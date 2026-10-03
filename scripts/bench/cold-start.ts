#!/usr/bin/env bun
/**
 * Cold-start harness: process launch to first interactive frame.
 *
 * One documented command:
 *
 *   bun scripts/bench/cold-start.ts --runs 20 --json > cold-start-<sha>.json
 *
 * Measured under a real pty, because `oh-my-pi` only takes the interactive
 * path when `process.stdin.isTTY === true`, and the measurement workspace has
 * no controlling terminal at all. See `scripts/bench/README.md` for the full
 * series rules and `scripts/bench/lib/pty.ts` for how a sample is spawned.
 *
 * Two metrics, deliberately kept apart:
 *
 *   firstInteractiveFrameMs  spawn -> the app's first write to the terminal,
 *                             gated on that frame then answering a keystroke.
 *                             This is the contract's definition of cold start.
 *   prePaintChainMs          spawn -> clean exit under `PI_TIMING=x`, which
 *                             happens before the TUI is mounted and before stdin
 *                             is owned. A pre-paint chain number, not a frame.
 *
 * No hyperfine. `bench-guard.ts` needed hyperfine for a `median`; the contract
 * forbids a median-only or mean-only verdict and requires p50 *and* p95, so the
 * loop here owns the statistics and one less external binary has to be
 * installed and version-matched for a number to be publishable.
 */

import { collectSamples, commandLine, parseArgs, reportSpread } from "./lib/cli";
import { acquireMachineLease } from "./lib/lease";
import {
	measureInteractiveFrame,
	measurePrePaintChain,
	type ModuleLoadRow,
	type PrePaintChainSample,
	type RunOptions,
} from "./lib/pty";
import { REPO_ROOT, detectCommit, detectMachine, detectShaAtFinish, detectVersions, newRunId } from "./lib/provenance";
import { buildResultDoc, writeResultDoc, type ResultDoc } from "./lib/result";
import { summarize } from "./lib/stats";

const SCRIPT = "cold-start.ts";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const args = parseArgs(argv);
	// The machine lease is taken before the first sample and released in
	// `finally`, so `concurrentRuns` describes the whole measurement window rather
	// than an instant. The lease is keyed by the machine id, which is derived from
	// hardware first, so contention is a property of the machine and not of the
	// revision being measured.
	const lease = acquireMachineLease(detectMachine().id, "cold-start");
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
	const runId = newRunId("cold-start", startedAt);
	// Probed once: the machine block is the series key, and it must be the same
	// value in the log, the lease key, and the result file.
	const machine = detectMachine(lease.concurrentRuns);

	const options: RunOptions = {
		repoRoot: REPO_ROOT,
		// The first-frame metric must run the real interactive path, so PI_TIMING
		// is deliberately *not* set for it: PI_TIMING disables the speculative
		// prepaint composer and exits before the TUI mounts.
		piTiming: null,
		moduleProfile: false,
		timeoutMs: args.timeoutMs,
		coldCache: !args.noColdCache,
	};

	process.stderr.write(`cold start on ${machine.id}\n`);
	process.stderr.write(`run ${runId}\n`);
	process.stderr.write(
		lease.concurrentRuns > 1
			? `WARNING: ${lease.concurrentRuns} cold-start runs are sharing this machine. ` +
					`This run is recorded as evidence and will not be a leaderboard row, a chart point, ` +
					`or the baseline for a later run.\n`
			: `machine held exclusively (concurrentRuns 1)\n`,
	);

	const frames = await collectSamples("first-frame", args.runs, args.warmupRuns, args.maxFailures, index =>
		measureInteractiveFrame(options).then(sample => {
			void index;
			return sample;
		}),
	);
	reportSpread(
		"first-frame",
		frames.map(frame => frame.firstInteractiveFrameMs),
	);

	const chainOptions: RunOptions = { ...options, piTiming: "x", moduleProfile: args.profile };
	const chains = await collectSamples("pre-paint-chain", args.runs, args.warmupRuns, args.maxFailures, () =>
		measurePrePaintChain(chainOptions),
	);
	reportSpread(
		"pre-paint-chain",
		chains.map(chain => chain.wallMs),
	);

	const metrics = {
		firstInteractiveFrameMs: summarize(frames.map(frame => frame.firstInteractiveFrameMs)),
		prePaintChainMs: summarize(chains.map(chain => chain.wallMs)),
	};

	const diagnostics = {
		// Proof the published first-frame number was gated on a real input
		// round-trip, per sample, rather than assumed.
		inputRoundTripMs: summarize(frames.map(frame => frame.inputRoundTripMs)),
		firstTerminalWriteMs: summarize(frames.map(frame => frame.firstTerminalWriteMs)),
		composerPaintedSamples: frames.filter(frame => frame.composerPainted).length,
		capabilityProbes: {
			seen: frames.map(frame => frame.capabilityProbesSeen),
			answered: frames.map(frame => frame.capabilityProbesAnswered),
		},
		// The tree's own view, so a reader can see what the wall clock includes.
		treeTotalMs: summarize(chains.map(chain => chain.treeTotalMs ?? Number.NaN).filter(Number.isFinite)),
		beforeInstrumentationMs: summarize(
			chains.map(chain => chain.beforeInstrumentationMs ?? Number.NaN).filter(Number.isFinite),
		),
		...(args.profile ? { moduleProfile: moduleProfileDiagnostics(chains) } : {}),
		...(args.quick ? { quick: true, publishable: false } : {}),
	};

	const doc: ResultDoc = buildResultDoc({
		benchmark: "cold-start",
		runId,
		startedAt,
		finishedAt: new Date(),
		commit: { ...detectCommit(), shaAtFinish: detectShaAtFinish() },
		machine,
		versions: detectVersions(),
		command,
		config: {
			runs: args.runs,
			warmupRuns: args.warmupRuns,
			coldCache: !args.noColdCache,
			timeoutMs: args.timeoutMs,
			quick: args.quick,
			percentileEstimator: "nearest-rank",
			terminal: { cols: 120, rows: 30, term: "xterm-256color" },
			// The input gate is part of the headline number, so how it resolves is
			// recorded with it.
			paintBoundary: "dec-2026-synchronized-output-bracket",
		},
		metrics,
		diagnostics,
	});

	if (args.out) {
		const path = await writeResultDoc(doc, args.out);
		process.stderr.write(`wrote ${path}\n`);
	}
	if (args.json) {
		// stdout stays pure JSON so it can be piped straight into import-result.
		process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
	}
	process.stderr.write(
		`cold start ${runId}: firstInteractiveFrameMs p50 ${metrics.firstInteractiveFrameMs.p50} ` +
			`p95 ${metrics.firstInteractiveFrameMs.p95} · prePaintChainMs p50 ${metrics.prePaintChainMs.p50} ` +
			`p95 ${metrics.prePaintChainMs.p95}\n`,
	);
	if (!args.json && !args.out) {
		process.stderr.write(`(nothing written; pass --json or --out <path>)\n`);
	}
}

/**
 * Per-sample module-init profile, from the existing `module-timer.ts` preload.
 * Diagnostics only: the preload rewrites and synchronously re-reads every TS
 * module, so a profiled run is slower than an unprofiled one and its wall clock
 * is not a cold-start number.
 */
function moduleProfileDiagnostics(chains: readonly PrePaintChainSample[]): Record<string, unknown> {
	const loaded = chains.map(chain => chain.modulesLoaded).filter((n): n is number => n !== null);
	const wall = chains.map(chain => chain.modulesWallMs).filter((n): n is number => n !== null);
	const byPath = new Map<string, ModuleLoadRow>();
	for (const chain of chains) {
		for (const row of chain.slowestModules) {
			const seen = byPath.get(row.path);
			// Median over samples, so one noisy run does not define the profile.
			byPath.set(row.path, seen && seen.totalMs >= row.totalMs ? seen : row);
		}
	}
	return {
		modulesLoadedPerBoot: loaded.length > 0 ? summarizeUnitless(loaded) : null,
		moduleLoadWallMs: wall.length > 0 ? summarize(wall) : null,
		slowestModules: [...byPath.values()].sort((a, b) => b.totalMs - a.totalMs).slice(0, 15),
	};
}

function summarizeUnitless(values: readonly number[]): {
	unit: "count";
	p50: number;
	p95: number;
	samples: number;
	min: number;
	max: number;
} {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (p: number) => sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1]!;
	return {
		unit: "count",
		p50: at(50),
		p95: at(95),
		samples: sorted.length,
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
	};
}

await main();
