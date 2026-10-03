/**
 * Benchmark: `SessionManager.forkFrom` entry-graph copy (upstream #14105).
 *
 * `forkFrom` loads the source session and then hands the graph to
 * `migrateToCurrentVersion`, `resolveBlobRefsInEntries` and the fork's own
 * writer, all of which mutate it. That is why the load used to be wrapped in
 * `structuredClone`: the graph had to belong to the fork alone.
 *
 * `loadEntriesFromFile` already parses a fresh graph per call — it is
 * documented as returning entries owned by the caller — so the clone was a
 * second full deep copy of an object graph nobody else held a reference to.
 * #14105 drops it and documents the ownership rule instead.
 *
 * The cost that disappears is proportional to the size of the session graph,
 * so the fixture is a realistic long session: many entries with multi-KiB tool
 * results, which is what makes the clone expensive rather than negligible.
 *
 * Run: bun packages/coding-agent/bench/session-fork-clone.bench.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "../src/session/session-manager";
import type { FileEntry } from "../src/session/session-entries";
import { loadEntriesFromFile } from "../src/session/session-loader";
import { FileSessionStorage } from "../src/session/session-storage";

/** Turns in the fixture session. Each contributes a user and an assistant entry. */
const TURNS = 400;
/** Tool-result payload size, chosen so the graph is a few MiB of real content. */
const PAYLOAD_BYTES = 4096;

const dir = mkdtempSync(join(tmpdir(), "omp-fork-clone-bench-"));
const storage = new FileSessionStorage();
const cwd = dir;
const sessionDir = join(cwd, "sessions");
const sourceFile = join(sessionDir, "source.jsonl");
const timestamp = new Date(0).toISOString();

/** A long, realistic session: alternating text turns plus tool results. */
async function writeSource(): Promise<void> {
	const lines: string[] = [JSON.stringify({ type: "session", version: 2, id: "bench-source", timestamp, cwd })];
	let parentId: string | null = null;
	for (let i = 0; i < TURNS; i++) {
		const userId = `user-${i}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: userId,
				parentId,
				timestamp,
				message: { role: "user", content: `turn ${i}`, timestamp: i * 2 },
			}),
		);
		const toolId = `tool-${i}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: toolId,
				parentId: userId,
				timestamp,
				message: {
					role: "toolResult",
					toolCallId: `call-${i}`,
					toolName: "bash",
					content: [{ type: "text", text: "x".repeat(PAYLOAD_BYTES) }],
					isError: false,
					timestamp: i * 2 + 1,
				},
			}),
		);
		const assistantId = `assistant-${i}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id: assistantId,
				parentId: toolId,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `answer ${i}` }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } },
					stopReason: "stop",
					timestamp: i * 2 + 1,
				},
			}),
		);
		parentId = assistantId;
	}
	await Bun.write(sourceFile, `${lines.join("\n")}\n`);
}

await writeSource();
const sourceEntries = await loadEntriesFromFile(sourceFile, storage);
const entryCount = sourceEntries.length;
const bytesOnDisk = (await Bun.file(sourceFile).arrayBuffer()).byteLength;
console.log(`source: ${entryCount} entries, ${(bytesOnDisk / 1024 / 1024).toFixed(2)} MiB on disk`);

/** Nearest-rank percentiles, no interpolation: p95 is always an observed sample. */
function report(label: string, samples: readonly number[]): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
	console.log(
		`${label.padEnd(26)} p50 ${at(50).toFixed(2)}ms  p95 ${at(95).toFixed(2)}ms  min ${sorted[0]!.toFixed(2)}ms  ` +
			`(${samples.length} samples)`,
	);
	return at(50);
}

const ITERS = 20;

/** Peak RSS delta across the fork, in MiB. */
async function peakRssMiB(): Promise<number> {
	const usage = process.memoryUsage();
	return usage.rss / 1024 / 1024;
}

const forkSamples: number[] = [];
const rssBefore = await peakRssMiB();
let peakRss = rssBefore;
let forks = 0;
for (let i = 0; i < ITERS + 3; i++) {
	const start = Bun.nanoseconds();
	const forked = await SessionManager.forkFrom(sourceFile, cwd, join(cwd, `forks/${i}`), storage, {
		suppressBreadcrumb: true,
		copyArtifacts: false,
	});
	const ms = (Bun.nanoseconds() - start) / 1e6;
	peakRss = Math.max(peakRss, await peakRssMiB());
	await forked.close();
	if (i >= 3) {
		forkSamples.push(ms);
		forks++;
	}
}
const forkP50 = report("SessionManager.forkFrom", forkSamples);

// The isolated cost: just the deep copy that #14105 removes, on this graph.
const cloneSamples: number[] = [];
for (let i = 0; i < ITERS + 3; i++) {
	const entries = (await loadEntriesFromFile(sourceFile, storage)) as FileEntry[];
	const start = Bun.nanoseconds();
	const copy = structuredClone(entries);
	const ms = (Bun.nanoseconds() - start) / 1e6;
	if (copy.length !== entryCount) throw new Error("clone lost entries");
	if (i >= 3) cloneSamples.push(ms);
}
const cloneP50 = report("structuredClone(graph)", cloneSamples);

rmSync(dir, { recursive: true, force: true });
console.log(
	JSON.stringify({
		entries: entryCount,
		sourceMiB: +(bytesOnDisk / 1024 / 1024).toFixed(2),
		forkP50Ms: +forkP50.toFixed(2),
		cloneP50Ms: +cloneP50.toFixed(2),
		cloneShareOfFork: `${((cloneP50 / forkP50) * 100).toFixed(1)}%`,
		peakRssDeltaMiB: +(peakRss - rssBefore).toFixed(1),
		forks,
	}),
);
