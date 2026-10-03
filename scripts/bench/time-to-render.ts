#!/usr/bin/env bun
/**
 * Time-to-render harness: an input event to the painted frame it produces.
 *
 *   bun scripts/bench/time-to-render.ts --runs 200 --json > ttr-<sha>.json
 *
 * Measured inside a live pty session rather than across process launches, because
 * this interval has no launch in it. One session is opened, the first
 * interactive frame is awaited (the same gate cold start uses, so both benchmarks
 * agree on what "interactive" means), and then each sample is one keystroke
 * written into the pty followed by the next terminal write. Waiting on the
 * event rather than sleeping is load-bearing: a fixed delay would either
 * over-report every sample or race the repaint.
 *
 * A keystroke, not a resize or a paste: a resize repaints everything and would
 * measure layout rather than input handling.
 */

import { collectSamples, commandLine, parseArgs, reportSpread } from "./lib/cli";
import { acquireMachineLease } from "./lib/lease";
import { openInteractiveSession, type InputSample, type RunOptions } from "./lib/pty";
import { REPO_ROOT, detectCommit, detectMachine, detectShaAtFinish, detectVersions, newRunId } from "./lib/provenance";
import { buildResultDoc, writeResultDoc, type ResultDoc } from "./lib/result";
import { summarize } from "./lib/stats";

const SCRIPT = "time-to-render.ts";

/** Samples taken after the frame lands but before measuring, so the first
 * measured keystroke is not paying for the session's own setup repaint. */
const DISCARD = 5;

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	const lease = acquireMachineLease(detectMachine().id, "time-to-render");
	try {
		await measure(args, commandLine(SCRIPT, argv), lease);
	} finally {
		lease.release();
	}
}

/** Take the samples and write the document. The caller releases the lease. */
async function measure(
	args: ReturnType<typeof parseArgs>,
	command: string,
	lease: ReturnType<typeof acquireMachineLease>,
): Promise<void> {
	const startedAt = new Date();
	const runId = newRunId("time-to-render", startedAt);
	const machine = detectMachine(lease.concurrentRuns);

	const options: RunOptions = {
		repoRoot: REPO_ROOT,
		piTiming: null,
		moduleProfile: false,
		timeoutMs: args.timeoutMs,
		coldCache: !args.noColdCache,
	};

	process.stderr.write(`time to render on ${machine.id}\n`);
	process.stderr.write(`run ${runId}\n`);
	process.stderr.write(
		lease.concurrentRuns > 1
			? `WARNING: ${lease.concurrentRuns} time-to-render runs are sharing this machine. ` +
					`This run is recorded as evidence and will not be a leaderboard row.\n`
			: `machine held exclusively (concurrentRuns 1)\n`,
	);

	const session = await openInteractiveSession(options);
	try {
		const total = args.runs + DISCARD;
		const samples = await collectSamples<InputSample>("input-to-paint", total, 0, args.maxFailures, () =>
			session.press("x"),
		);
		// Drop the settling samples: the first few keystrokes after a paint can be
		// slower while the app finishes attaching input, and including them would
		// describe the session's warm-up rather than time-to-render.
		const measured = samples.slice(DISCARD).map(sample => sample.latencyMs);
		if (measured.length === 0) throw new Error("no samples survived the discard window");
		reportSpread("input-to-paint", measured);

		const metrics = { inputToPaintMs: summarize(measured) };
		const doc: ResultDoc = buildResultDoc({
			benchmark: "time-to-render",
			runId,
			startedAt,
			finishedAt: new Date(),
			commit: { ...detectCommit(), shaAtFinish: detectShaAtFinish() },
			machine,
			versions: detectVersions(),
			command,
			config: {
				runs: args.runs,
				warmupRuns: 0,
				coldCache: !args.noColdCache,
				timeoutMs: args.timeoutMs,
				discardedSettlingSamples: DISCARD,
				percentileEstimator: "nearest-rank",
				terminal: { cols: 120, rows: 30, term: "xterm-256color" },
				quick: args.quick,
			},
			metrics,
			diagnostics: {
				firstInteractiveFrameMs: session.firstInteractiveFrameMs,
				inputRoundTripAfterWarmup: summarize(measured),
				...(args.quick ? { quick: true, publishable: false } : {}),
			},
		});

		if (args.out) {
			const path = await writeResultDoc(doc, args.out);
			process.stderr.write(`wrote ${path}\n`);
		}
		if (args.json) process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
		process.stderr.write(
			`time to render ${runId}: inputToPaintMs p50 ${metrics.inputToPaintMs.p50} ` +
				`p95 ${metrics.inputToPaintMs.p95}\n`,
		);
		if (!args.json && !args.out) process.stderr.write("(nothing written; pass --json or --out <path>)\n");
	} finally {
		await session.close();
	}
}

await main();
