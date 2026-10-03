/**
 * Shared CLI surface and sample loop for the benchmark harnesses.
 *
 * One loop, one set of flags, so a number can never be produced by a code path
 * that a different flag combination silently used instead. The contract's rule
 * applies here too: quick mode and full mode must be distinguishable from the
 * result file, so they cannot be silently mixed.
 */

import { spread } from "./stats";
import { SampleFailure } from "./pty";

export interface CommonArgs {
	runs: number;
	warmupRuns: number;
	quick: boolean;
	json: boolean;
	out: string | null;
	profile: boolean;
	noColdCache: boolean;
	timeoutMs: number;
	maxFailures: number;
}

export const DEFAULT_RUNS = 20;
export const DEFAULT_WARMUP = 2;
export const DEFAULT_TIMEOUT_MS = 120_000;

const USAGE = `Usage: bun scripts/bench/<benchmark>.ts [options]

  --runs <n>          measured samples (default ${DEFAULT_RUNS})
  --warmup <n>        discarded warmup samples (default ${DEFAULT_WARMUP})
  --quick             few samples, indicative only; marks the result unpublishable
  --json              write the result document to stdout
  --out <path>        also write the result document to <path>
  --profile           add the module-init profile (module-timer preload); diagnostic only
  --warm-cache        keep one HOME across samples instead of a cold cache per sample
  --timeout-ms <n>    per-sample budget (default ${DEFAULT_TIMEOUT_MS})
  --max-failures <n>  tolerate this many failed samples (default 0)
  -h, --help          this message
`;

export function parseArgs(argv: readonly string[]): CommonArgs {
	const args: CommonArgs = {
		runs: DEFAULT_RUNS,
		warmupRuns: DEFAULT_WARMUP,
		quick: false,
		json: false,
		out: null,
		profile: false,
		noColdCache: false,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxFailures: 0,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${token} needs a value`);
			return value;
		};
		switch (token) {
			case "--runs":
				args.runs = intArg(next(), "--runs");
				break;
			case "--warmup":
				args.warmupRuns = intArg(next(), "--warmup");
				break;
			case "--quick":
				args.quick = true;
				break;
			case "--json":
				args.json = true;
				break;
			case "--out":
				args.out = next();
				break;
			case "--profile":
				args.profile = true;
				break;
			case "--warm-cache":
				args.noColdCache = true;
				break;
			case "--timeout-ms":
				args.timeoutMs = intArg(next(), "--timeout-ms");
				break;
			case "--max-failures":
				args.maxFailures = intArg(next(), "--max-failures");
				break;
			case "-h":
			case "--help":
				process.stdout.write(USAGE);
				process.exit(0);
				break;
			default:
				throw new Error(`unknown option ${token}\n\n${USAGE}`);
		}
	}
	if (args.runs < 1) throw new Error("--runs must be at least 1");
	if (args.warmupRuns < 0) throw new Error("--warmup must not be negative");
	if (args.quick && args.runs === DEFAULT_RUNS) args.runs = 5;
	return args;
}

function intArg(raw: string, flag: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value)) throw new Error(`${flag} needs an integer, got ${JSON.stringify(raw)}`);
	return value;
}

/** The command as a human would type it, recorded verbatim in the result file. */
export function commandLine(script: string, argv: readonly string[]): string {
	return `bun scripts/bench/${script} ${argv.join(" ")}`.replace(/\s+$/, "");
}

export interface SampleOutcome<T> {
	value: T | null;
	failure: SampleFailure | null;
}

/**
 * Run warmups, then `count` measured samples, reporting progress on stderr so
 * a long run is visibly alive.
 *
 * A failed sample is never silently dropped and never replaced by an
 * imputation: it is counted, reported with its reason, and by default fails the
 * run. A harness that quietly discards the runs that broke is how a tail
 * regression gets published as an improvement.
 */
export async function collectSamples<T>(
	label: string,
	count: number,
	warmups: number,
	maxFailures: number,
	measure: (index: number) => Promise<T>,
): Promise<T[]> {
	const values: T[] = [];
	const failures: SampleFailure[] = [];
	const total = count + warmups;

	for (let i = 0; i < total; i += 1) {
		const isWarmup = i < warmups;
		const started = performance.now();
		try {
			const value = await measure(i);
			if (isWarmup) {
				process.stderr.write(`  warmup ${i + 1}/${warmups} ok (${ms(performance.now() - started)})\n`);
				continue;
			}
			values.push(value);
			process.stderr.write(
				`  ${label} ${values.length}/${count} ${ms(performance.now() - started)}` + ` [${describe(value)}]\n`,
			);
		} catch (error) {
			const failure =
				error instanceof SampleFailure
					? error
					: new SampleFailure("unexpected", error instanceof Error ? error.message : String(error));
			failures.push(failure);
			process.stderr.write(`  ${label} ${i + 1}/${total} FAILED ${failure.reason}: ${failure.message}\n`);
		}
	}

	if (failures.length > maxFailures) {
		const byReason = new Map<string, number>();
		for (const failure of failures) byReason.set(failure.reason, (byReason.get(failure.reason) ?? 0) + 1);
		const summary = [...byReason].map(([reason, n]) => `${reason} x${n}`).join(", ");
		throw new Error(
			`${failures.length} of ${total} samples failed (${summary}); ` +
				`refusing to publish a number built from ${values.length}. ` +
				`Pass --max-failures <n> to accept a partial run.`,
		);
	}
	return values;
}

function describe(value: unknown): string {
	if (typeof value === "number") return `${ms(value)}`;
	const record = value as Record<string, unknown>;
	const parts: string[] = [];
	for (const [key, raw] of Object.entries(record)) {
		if (typeof raw === "number" && key.endsWith("Ms")) parts.push(`${key}=${ms(raw)}`);
	}
	return parts.length > 0 ? parts.join(" ") : "";
}

function ms(value: number): string {
	return `${Math.round(value)}ms`;
}

/** Observed spread, for the log only. A range is not a published statistic. */
export function reportSpread(label: string, values: readonly number[]): void {
	if (values.length < 2) return;
	process.stderr.write(`  ${label}: observed spread ${ms(spread(values))} over ${values.length} samples\n`);
}
