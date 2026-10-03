/**
 * Benchmark: session-load image blob hydration (upstream #14102).
 *
 * Every image a session ever read is externalized to the blob store and stored
 * once as content-addressed bytes, but the session file keeps a *reference* at
 * every site that displayed it. A transcript where the same screenshot is
 * re-read, or where one image is shown by several tool results, therefore
 * repeats the same ref many times.
 *
 * `resolveBlobRefsInEntries` used to read and re-encode the blob once per site,
 * so hydration cost scaled with the number of *sites* rather than the number of
 * *distinct* images. #14102 keys resolutions by (kind, ref) for the duration of
 * one loader call and shares the pending promise between async callers, so a
 * repeated ref costs one read and one encode.
 *
 * What is timed is the whole per-site work: one `BlobStore.get` (a file read
 * plus a Buffer copy) and one base64 encode per site. That is why the ratio is
 * large; the absolute numbers are session-load numbers, not cold-start numbers.
 *
 * Run: bun packages/coding-agent/bench/session-blob-dedup.bench.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BlobStore } from "../src/session/blob-store";
import type { FileEntry } from "../src/session/session-entries";
import { resolveBlobRefsInEntries, resolveBlobRefsInEntriesSync } from "../src/session/session-loader";

/** One PNG's worth of bytes, ~256 KiB once base64-encoded. */
const IMAGE_BYTES = Buffer.alloc(256 * 1024);
for (let i = 0; i < IMAGE_BYTES.length; i++) IMAGE_BYTES[i] = (i * 2654435761) & 0xff;

/** Distinct images in the fixture. Only one of them repeats across the session. */
const DISTINCT = 4;
/** Tool results that reference the repeated image. This is the number #14102 changes. */
const REPEATS = 32;

const dir = mkdtempSync(join(tmpdir(), "omp-blob-dedup-bench-"));
const store = new BlobStore(dir);

const distinctRefs: string[] = [];
for (let i = 0; i < DISTINCT; i++) {
	distinctRefs.push(store.putSync(Buffer.concat([IMAGE_BYTES, Buffer.from([i])])).ref);
}
/** The image a realistic transcript shows over and over. */
const sharedRef = distinctRefs[0]!;

function toolResultImages(refs: readonly string[]): FileEntry {
	return {
		type: "message",
		id: "images",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "image-read",
			toolName: "read",
			content: refs.map(ref => ({ type: "image", data: ref, mimeType: "image/png" })),
			details: { images: refs.map(ref => ({ type: "image", data: ref, mimeType: "image/png" })) },
			isError: false,
			timestamp: 0,
		},
	} as unknown as FileEntry;
}

/** A fresh entry graph per sample: hydration mutates the graph it is handed. */
function freshEntries(): FileEntry[] {
	const entries: FileEntry[] = [];
	for (let i = 0; i < REPEATS; i++) entries.push(toolResultImages([sharedRef, sharedRef]));
	for (const ref of distinctRefs.slice(1)) entries.push(toolResultImages([ref, ref]));
	return entries;
}

const SITES = REPEATS * 2 + (DISTINCT - 1) * 2;
const ITERS = 40;

/** Nearest-rank percentiles, no interpolation: p95 is always an observed sample. */
function report(label: string, samples: readonly number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
	console.log(
		`${label.padEnd(22)} p50 ${at(50).toFixed(2)}ms  p95 ${at(95).toFixed(2)}ms  min ${sorted[0]!.toFixed(2)}ms  ` +
			`(${SITES} sites over ${DISTINCT} distinct blobs, ${samples.length} samples)`,
	);
	return at(50);
}

console.log(`blob ${IMAGE_BYTES.length} bytes; ${REPEATS} tool results x2 sites of the shared image`);

const asyncSamples: number[] = [];
for (let i = 0; i < ITERS + 5; i++) {
	const entries = freshEntries();
	const start = Bun.nanoseconds();
	await resolveBlobRefsInEntries(entries, store);
	const ms = (Bun.nanoseconds() - start) / 1e6;
	// The first five are warmup: module graph, page cache, and V8 tiering.
	if (i >= 5) asyncSamples.push(ms);
}
const asyncP50 = report("async hydration", asyncSamples);

const syncSamples: number[] = [];
for (let i = 0; i < ITERS + 5; i++) {
	const entries = freshEntries();
	const start = Bun.nanoseconds();
	resolveBlobRefsInEntriesSync(entries, store);
	const ms = (Bun.nanoseconds() - start) / 1e6;
	if (i >= 5) syncSamples.push(ms);
}
const syncP50 = report("sync hydration", syncSamples);

rmSync(dir, { recursive: true, force: true });
console.log(
	JSON.stringify({
		sites: SITES,
		distinctBlobs: DISTINCT,
		asyncP50Ms: +asyncP50.toFixed(2),
		syncP50Ms: +syncP50.toFixed(2),
	}),
);
