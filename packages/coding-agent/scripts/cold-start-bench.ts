#!/usr/bin/env bun
/**
 * Cold-start benchmark: process launch to the first interactive frame.
 *
 *   bun scripts/cold-start-bench.ts                       # compiled binary, 15 samples
 *   bun scripts/cold-start-bench.ts --dev                 # bun src/cli.ts (profiling only)
 *   bun scripts/cold-start-bench.ts --samples 30 --json boot.json
 *   bun scripts/cold-start-bench.ts --compare ../bin/omp-a ../bin/omp-b --samples 12
 *
 * The app stamps `OMP_COLDSTART_PROBE` marks (see @oh-my-pi/pi-utils/coldstart-probe)
 * on the same wall clock this harness reads immediately before spawn, so the
 * reported number contains process exec, runtime init, module graph load and
 * everything up to the frame — none of which `PI_TIMING` covers, since that tree
 * only starts once `main.ts` has been imported.
 *
 * Marks, in the order a cold interactive launch reaches them:
 *   cli-entry         first statement of runCli (after exec + runtime init)
 *   prepaint-frame    speculative composer frame committed (input still cooked)
 *   input-enabled     raw mode installed — THE cold-start number
 *   interactive-frame full runtime tree committed (transcript, status line)
 *   interactive-ready submit pipeline live (Enter dispatches)
 *
 * Each sample runs under a real PTY (`script -qfec`) because the app takes the
 * speculative-prepaint path only when stdin and stdout are TTYs.
 *
 * Wall-clock numbers are MACHINE-RELATIVE: hold the machine, the CPU governor,
 * the build (`--dev` vs compiled) and the warm/cold state of `~/.omp` constant.
 * A loaded machine inflates every sample and drifts during a session, so use
 * `--compare` for before/after: it interleaves the two binaries sample by sample
 * so drift lands on both arms instead of on whichever one ran second.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface Mark {
	mark: string;
	t: number;
	cpu: number;
}

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : undefined;
};
const dev = argv.includes("--dev");
const samples = Number(flag("samples") ?? (dev ? 5 : 15));
const jsonOut = flag("json");
const compare =
	flag("compare")
		?.split(",")
		.map(entry => path.resolve(entry)) ?? [];
const root = path.join(import.meta.dir, "..", "..", "..");
const cwd = path.join(root, "packages", "coding-agent");
const defaultBinary = path.join(cwd, dev ? "src/cli.ts" : "dist/omp");
const singleBinary = path.resolve(flag("bin") ?? defaultBinary);
const probeFile = path.join(os.tmpdir(), `omp-coldstart-probe-${process.pid}.jsonl`);
const KILL_AFTER_MARK = "interactive-ready";
const MAX_WAIT_MS = 60_000;

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return Number.NaN;
	const rank = (p / 100) * (sorted.length - 1);
	const low = Math.floor(rank);
	const high = Math.ceil(rank);
	return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function round(value: number): number {
	return Math.round(value * 10) / 10;
}

async function runSample(binary: string, cpus?: string): Promise<Record<string, number>> {
	fs.rmSync(probeFile, { force: true });
	const started = performance.timeOrigin + performance.now();
	const command = binary.endsWith(".ts") ? `bun ${binary}` : binary;
	const script = cpus
		? ["taskset", "-c", cpus, "script", "-qfec", command, "/dev/null"]
		: ["script", "-qfec", command, "/dev/null"];
	const proc = Bun.spawn(script, {
		cwd,
		env: {
			...process.env,
			OMP_COLDSTART_PROBE: probeFile,
			OMP_COLDSTART_PROBE_APPEND: "1",
			PI_STRICT_EDIT_MODE: "1",
			TERM: "xterm-256color",
		},
		stdout: "ignore",
		stderr: "ignore",
	});
	const deadline = started + MAX_WAIT_MS;
	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});
	let marks: Mark[] = [];
	while (true) {
		await Bun.sleep(4);
		try {
			marks = fs
				.readFileSync(probeFile, "utf8")
				.split("\n")
				.filter(line => line.length > 0)
				.map(line => JSON.parse(line) as Mark);
		} catch {
			marks = [];
		}
		if (marks.some(mark => mark.mark === KILL_AFTER_MARK) || performance.timeOrigin + performance.now() > deadline)
			break;
		if (exited) break;
	}
	proc.kill("SIGKILL");
	await proc.exited;
	const result: Record<string, number> = {};
	for (const { mark, t } of marks) result[mark] = round(t - started);
	result["launch-exit"] = round(performance.timeOrigin + performance.now() - started);
	const last = marks[marks.length - 1];
	result["launch-cpu"] = round(last?.cpu ?? 0);
	for (const mark of marks) result[`${mark.mark}:cpu`] = round(mark.cpu);
	return result;
}

const order = [
	"cli-entry",
	"prepaint-frame",
	"input-enabled",
	"interactive-frame",
	"interactive-ready",
	"launch-exit",
	"cli-entry:cpu",
	"prepaint-frame:cpu",
	"input-enabled:cpu",
	"interactive-frame:cpu",
	"interactive-ready:cpu",
];
const arms = compare.length > 0 ? compare : [singleBinary];
const cpuList = flag("cpus");
const rounds: Array<Record<string, Record<string, number>>> = [];
for (let index = 0; index < samples; index++) {
	// Swap arm order every round so a drift inside a round lands on both arms.
	const orderThisRound = index % 2 === 1 ? arms.slice().reverse() : arms;
	const round: Record<string, Record<string, number>> = {};
	for (const arm of orderThisRound) {
		round[arm] = await runSample(arm, cpuList);
	}
	rounds.push(round);
}
const collected = new Map<string, Map<string, number[]>>(
	arms.map(arm => [arm, new Map(order.map(key => [key, [] as number[]]))]),
);
for (const round of rounds) {
	for (const arm of arms) {
		for (const key of order) {
			const value = round[arm]?.[key];
			if (value !== undefined) collected.get(arm)?.get(key)?.push(value);
		}
	}
}
fs.rmSync(probeFile, { force: true });

const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
const machine = {
	commit,
	dirty: Bun.spawnSync(["git", "status", "--porcelain"], { cwd: root }).stdout.toString().trim().length > 0,
	build: arms.map(arm => (arm.endsWith(".ts") ? "dev" : path.basename(arm))).join(" vs "),
	bun: Bun.version,
	node: process.versions.node,
	os: `${os.type()} ${os.release()} ${os.arch()}`,
	cpuCount: os.cpus().length,
	cpuModel: os.cpus()[0]?.model ?? "unknown",
	totalMemoryGiB: round(os.totalmem() / 1024 ** 3),
	loadavg1: round(os.loadavg()[0] ?? 0),
	clock: "wall ms from launch; :cpu marks are cumulative process user+system ms",
	samples,
	cpus: cpuList ?? null,
};
const summarize = (values: number[]): { min: number; p50: number; p95: number; max: number } => {
	const sorted = values.slice().sort((a, b) => a - b);
	if (sorted.length === 0) return { min: Number.NaN, p50: Number.NaN, p95: Number.NaN, max: Number.NaN };
	return {
		min: round(sorted[0] ?? 0),
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		max: round(sorted[sorted.length - 1] ?? 0),
	};
};

const report: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
console.log(
	`cold start · ${machine.build} · ${samples} samples/arm · ${commit.slice(0, 9)}${machine.dirty ? " (dirty)" : ""}`,
);
console.log(
	`host: ${machine.cpuModel} · ${machine.cpuCount} cpu · ${machine.totalMemoryGiB}GiB · load1 ${machine.loadavg1}`,
);
console.log("");
const width = Math.max(...order.map(key => key.length));
for (const arm of arms) {
	const perMark = collected.get(arm) ?? new Map<string, number[]>();
	const stats: Record<string, ReturnType<typeof summarize>> = {};
	for (const key of order) {
		const values = perMark.get(key) ?? [];
		if (values.length === 0) continue;
		stats[key] = summarize(values);
	}
	report[arm] = stats;
	const label = path.basename(arm);
	console.log(`${label} · n=${perMark.get("input-enabled")?.length ?? 0}`);
	console.log(
		`${"mark".padEnd(width)} ${"min".padStart(9)} ${"p50".padStart(9)} ${"p95".padStart(9)} ${"max".padStart(9)}`,
	);
	for (const key of order) {
		const row = stats[key];
		if (!row) {
			console.log(`${key.padEnd(width)} ${"(not reached)".padStart(9)}`);
			continue;
		}
		console.log(
			`${key.padEnd(width)} ${`${row.min}ms`.padStart(9)} ${`${row.p50}ms`.padStart(9)} ${`${row.p95}ms`.padStart(9)} ${`${row.max}ms`.padStart(9)}`,
		);
	}
	console.log("");
}

if (arms.length === 2) {
	const [a, b] = arms as [string, string];
	console.log("paired delta (b - a) per round; negative = faster");
	console.log(
		`${"mark".padEnd(width)} ${"a p50".padStart(10)} ${"b p50".padStart(10)} ${"paired".padStart(10)} ${"a min".padStart(10)} ${"b min".padStart(10)}`,
	);
	for (const key of order) {
		const statsA = report[a]?.[key];
		const statsB = report[b]?.[key];
		if (!statsA || !statsB) continue;
		const diffs = rounds
			.map(round =>
				round[a]?.[key] !== undefined && round[b]?.[key] !== undefined ? round[b][key] - round[a][key] : undefined,
			)
			.filter((value): value is number => value !== undefined);
		const paired =
			diffs.length === 0
				? Number.NaN
				: percentile(
						diffs.slice().sort((x, y) => x - y),
						50,
					);
		console.log(
			`${key.padEnd(width)} ${`${statsA.p50}ms`.padStart(10)} ${`${statsB.p50}ms`.padStart(10)} ${`${round(paired)}ms`.padStart(10)} ${`${statsA.min}ms`.padStart(10)} ${`${statsB.min}ms`.padStart(10)}`,
		);
	}
	console.log("");
}

if (jsonOut) {
	await Bun.write(path.resolve(jsonOut), `${JSON.stringify({ machine, arms: report, rounds }, null, "\t")}\n`);
	console.log(`wrote ${jsonOut}`);
}
