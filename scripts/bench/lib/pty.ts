/**
 * Real-terminal measurement runner.
 *
 * This is the whole reason the harness exists in this shape. `oh-my-pi` decides
 * whether to run interactively with `process.stdin.isTTY === true`
 * (`packages/coding-agent/src/main.ts`). Spawn it with pipes, as the previous
 * `bench-guard.ts` did under hyperfine, and it takes the auto-print path and
 * bails out at `exitWithoutTerminal()` roughly a hundred lines before the
 * interactive branch — measuring a fast usage error, not a boot. There is also
 * no tty in the measurement workspace at all (`TERM=dumb`, no controlling
 * terminal), so "just run it" cannot work either.
 *
 * So every sample is spawned under a real pty via `Bun.Terminal`, which is the
 * same mechanism the repo's own `test/fatal-stderr-pty.test.ts` uses for its
 * real-terminal contract test. Nothing here reimplements a profiler: the module
 * load profile is produced by the existing `PI_TIMING` + `module-timer.ts`
 * preload, and the timing tree is the existing `logger.printTimings()` output,
 * parsed here.
 *
 * ## What is measured, and what it is not
 *
 * Two distinct intervals, kept distinct because conflating them is the failure
 * this file exists to prevent:
 *
 * 1. `firstInteractiveFrameMs` — spawn until the app's **first write to the
 *    terminal**, gated on that frame then *answering an input event*. The gate
 *    matters: a paint that ignores input is not an interactive frame. Matches
 *    the contract's definition of `cold-start`.
 * 2. `prePaintChainMs` — spawn until the process exits 0 under `PI_TIMING=x`,
 *    which in the interactive branch happens at `main.ts` right after
 *    `logger.printTimings()` and **before** `runInteractiveMode()` is called.
 *    Nothing is mounted, painted, or owns stdin at that point, so this is a
 *    *pre-paint chain completion* number and must never be labelled a first
 *    frame. It is cheap, deterministic, and is the cheap regression signal.
 *
 * ## Known bias in this environment
 *
 * A `Bun.Terminal` has no terminal emulator behind it, so the capability probes
 * the app writes (`CSI c` device attributes, `OSC 10/11` colour queries, DECRQM
 * mode queries, the Kitty keyboard query) go unanswered and the app waits out
 * its own timeouts. {@link TerminalQueryResponder} answers the common forms so
 * the session is not dominated by probe timeouts, but the remainder are still
 * unanswered. This is recorded in `capabilityProbesAnswered` /
 * `capabilityProbesSeen` on every sample rather than hidden, and the README
 * says what to do about it before these numbers are treated as final.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "./provenance";

import { TerminalQueryResponder } from "@oh-my-pi/pi-utils/vterm";

/** Columns/rows of the emulated terminal. Part of the series: layout changes paint cost. */
export const TERM_COLS = 120;
export const TERM_ROWS = 30;

/**
 * The composer border. A real frame is only useful to a user once there is an
 * input surface to type into, and this row is the one the repo's own pty test
 * uses to detect that the composer has been painted.
 */
const COMPOSER_MARKER = "╰─";

/**
 * Env keys scrubbed from every sample. A measurement must not depend on, or
 * leak, credentials: a machine with an API key cached would measure a
 * different boot than one without. Mirrors
 * `packages/coding-agent/test/cli-non-tty-launch.test.ts`.
 */
const CREDENTIAL_KEYS =
	/(_API_KEY|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY|_CREDENTIALS|^AWS_PROFILE|^GOOGLE_CLOUD_PROJECT)$/;

/**
 * Env keys cleared so a sample measures the product rather than the harness's
 * own surroundings. `PI_TIMING`/`PI_DEBUG_STARTUP` are set deliberately per mode
 * instead of inherited.
 */
const CLEARED_KEYS = [
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
	"PI_CONFIG_FILES",
	"OMP_PROFILE",
	"PI_PROFILE",
	"PI_TIMING",
	"PI_DEBUG_STARTUP",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"PI_TEST_RUNTIME",
	"BUN_ENV",
	"NODE_ENV",
	"OMP_TUI_DEBUG",
] as const;

/** One parsed row of the `PI_TIMING` module-load profile. */
export interface ModuleLoadRow {
	path: string;
	totalMs: number;
	selfMs: number | null;
}

export interface InteractiveFrameSample {
	/** spawn -> the first screen showing a painted input surface. */
	firstInteractiveFrameMs: number;
	/** spawn -> the app's very first write to the terminal, usable or not. */
	firstTerminalWriteMs: number;
	/** keystroke -> the next terminal write, proving the frame answers input. */
	inputRoundTripMs: number;
	/** True when the painted screen showed the composer input surface. */
	composerPainted: boolean;
	capabilityProbesSeen: number;
	capabilityProbesAnswered: number;
}

export interface PrePaintChainSample {
	/** Parent-observed spawn -> clean exit(0). Includes runtime init and module load. */
	wallMs: number;
	/** `Total:` from the tree: instrumented spans only, excludes module load. */
	treeTotalMs: number | null;
	/** `(before instrumentation):` from the tree: runtime init + module load. */
	beforeInstrumentationMs: number | null;
	/** `(modules): N loaded, wall Xms` from the tree, present only with the preload. */
	modulesLoaded: number | null;
	modulesWallMs: number | null;
	/** Slowest module-load rows, present only with the preload. */
	slowestModules: ModuleLoadRow[];
}

/** A sample that did not produce a usable measurement. Never silently dropped. */
export class SampleFailure extends Error {
	constructor(
		readonly reason: string,
		message: string,
	) {
		super(message);
		this.name = "SampleFailure";
	}
}

export interface RunOptions {
	/** Repo root the child runs in. */
	repoRoot: string;
	/** `PI_TIMING` value, or null for the plain interactive path. */
	piTiming: string | null;
	/** Preload `packages/utils/src/module-timer.ts` (module-init profile). */
	moduleProfile: boolean;
	/** Per-sample budget. A sample that exceeds it is a failure, not a slow win. */
	timeoutMs: number;
	/** Fresh HOME per sample so the boot cache is cold. */
	coldCache: boolean;
}

/** Path to the CLI entry, relative to the repo root. */
const CLI_ENTRY = "packages/coding-agent/src/cli.ts";
/**
 * The existing module-init profiler. Resolved to an absolute path because Bun
 * looks a `--preload` target up relative to its own resolution root, not to the
 * child's `cwd`.
 */
const MODULE_TIMER = join(REPO_ROOT, "packages", "utils", "src", "module-timer.ts");

function buildEnv(options: RunOptions, home: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		if (CREDENTIAL_KEYS.test(key)) continue;
		env[key] = value;
	}
	for (const key of CLEARED_KEYS) delete env[key];
	// A fresh HOME is the cold-cache mechanism: settings, plugin roots, skills,
	// session history and auth storage all live under it.
	env.HOME = home;
	env.USERPROFILE = home;
	// A real terminal to write to, with a real terminal emulator behind it.
	env.TERM = "xterm-256color";
	env.NO_COLOR = "1";
	env.COLUMNS = String(TERM_COLS);
	env.LINES = String(TERM_ROWS);
	if (options.piTiming) env.PI_TIMING = options.piTiming;
	return env;
}

/** Remove ANSI control sequences so screen content can be matched as text. */
function stripAnsi(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching CSI/OSC is the point
	return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?>=]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g, "");
}

/** Parse a `fmtMs`-formatted number ("0.42", "12.3", "3787"). */
function parseFmtMs(text: string): number {
	const value = Number(text);
	return Number.isFinite(value) ? value : NaN;
}

/**
 * Parse `logger.printTimings()` output.
 *
 * Only the aggregate lines are parsed for the published number, because those
 * are stable and documented. The module-load rows are best-effort diagnostics:
 * they exist so `--profile` output is readable, and a format change upstream
 * degrades them to an empty list rather than failing a measurement.
 */
export function parseTimingTree(raw: string): Omit<PrePaintChainSample, "wallMs"> {
	const treeTotalMs = raw.match(/^Total: ([\d.]+)ms \(since first marker\)$/m)?.[1];
	const before = raw.match(/^\(before instrumentation\): ([\d.]+)ms/m)?.[1];
	const modules = raw.match(/^\(modules\): (\d+) loaded, wall ([\d.]+)ms$/m);
	const slowestModules: ModuleLoadRow[] = [];
	for (const line of raw.split("\n")) {
		const match = line.match(/^\s*load:(\S+?): ([\d.]+)ms(?: \(self ([\d.]+)ms\))?/);
		if (!match) continue;
		slowestModules.push({
			path: match[1]!,
			totalMs: parseFmtMs(match[2]!),
			selfMs: match[3] === undefined ? null : parseFmtMs(match[3]),
		});
	}
	slowestModules.sort((a, b) => b.totalMs - a.totalMs);
	return {
		treeTotalMs: treeTotalMs === undefined ? null : parseFmtMs(treeTotalMs),
		beforeInstrumentationMs: before === undefined ? null : parseFmtMs(before),
		modulesLoaded: modules ? Number(modules[1]) : null,
		modulesWallMs: modules ? parseFmtMs(modules[2]!) : null,
		slowestModules,
	};
}

/** One input-to-paint observation. */
export interface InputSample {
	/** keystroke written -> the terminal write that answers it. */
	latencyMs: number;
}

/** A live interactive session, already past its first interactive frame. */
export interface InteractiveSession {
	firstInteractiveFrameMs: number;
	firstTerminalWriteMs: number;
	/** Write one keystroke and resolve when the app paints in response. */
	press(key: string): Promise<InputSample>;
	close(): Promise<void>;
}

/**
 * The only part of `Bun.Subprocess` this harness uses. Naming it structurally
 * rather than as `Bun.Subprocess<...>` keeps the stdio generics — which Bun
 * infers differently when a `terminal` is supplied — from leaking into every
 * call site.
 */
interface Child {
	exitCode: number | null;
	exited: Promise<number>;
	kill(): void;
}

interface SessionHandles {
	terminal: Bun.Terminal;
	proc: Child;
	/** Per-sample HOME, so dispose can remove the cold cache it created. */
	home: string;
	bytesWritten(): number;
	firstWriteAt: number;
	composerAt: number;
	probesSeen: number;
	probesAnswered: number;
	t0: number;
	/** Kill the child, close the pty, and remove the per-sample HOME. */
	dispose(): Promise<void>;
}

/**
 * Spawn under a pty and resolve once the first interactive frame is on screen.
 * Shared by `measureInteractiveFrame` (one sample per session) and
 * `openInteractiveSession` (many samples per session).
 */
async function startInteractive(options: RunOptions): Promise<SessionHandles> {
	const home = options.coldCache ? mkdtempSync(join(tmpdir(), "omp-bench-home-")) : tmpdir();
	const responder = new TerminalQueryResponder();
	const decoder = new TextDecoder();
	let bytes = 0;
	/** Stripped tail, so a marker split across chunks is still matched. */
	let plainTail = "";
	let firstWriteAt = 0;
	let composerAt = 0;
	let probesSeen = 0;
	let probesAnswered = 0;

	const painted = Promise.withResolvers<void>();
	const exited = Promise.withResolvers<number>();
	const t0 = performance.now();

	const terminal = new Bun.Terminal({
		cols: TERM_COLS,
		rows: TERM_ROWS,
		data(_t, data: Uint8Array) {
			if (data.length === 0) return;
			if (!firstWriteAt) firstWriteAt = performance.now();
			bytes += data.length;
			const text = decoder.decode(data, { stream: true });
			// The first interactive frame is the first screen that shows an input
			// surface, not merely the first byte: a partial frame the user cannot
			// type into is not interactive. Un-stripped text is useless here because
			// every run of styled output is wrapped in colour escapes.
			const window = plainTail + stripAnsi(text);
			if (!composerAt && window.includes(COMPOSER_MARKER)) {
				composerAt = performance.now();
				painted.resolve();
			}
			plainTail = window.slice(-16);
			const replies = responder.feed(text);
			if (replies) {
				probesSeen += 1;
				probesAnswered += 1;
				terminal.write(replies);
			}
		},
		exit() {
			exited.resolve(0);
		},
	});

	const proc = Bun.spawn([process.execPath, CLI_ENTRY], {
		cwd: options.repoRoot,
		env: buildEnv(options, home),
		terminal,
	});

	const settled = await Promise.race([
		painted.promise.then(() => "painted" as const),
		exited.promise.then(() => "exited" as const),
		Bun.sleep(options.timeoutMs).then(() => "timeout" as const),
	]);

	const handles: SessionHandles = {
		terminal,
		proc,
		home,
		bytesWritten: () => bytes,
		firstWriteAt,
		composerAt,
		probesSeen,
		probesAnswered,
		t0,
		dispose: async () => {
			if (handles.proc.exitCode === null) handles.proc.kill();
			await handles.proc.exited.catch(() => undefined);
			handles.terminal.close();
			if (options.coldCache) rmSync(home, { recursive: true, force: true });
		},
	};

	if (settled === "timeout") {
		await handles.dispose();
		throw new SampleFailure("no-paint", `no interactive frame within ${options.timeoutMs}ms`);
	}
	if (settled === "exited") {
		await handles.dispose();
		throw new SampleFailure("exited-early", `exited ${await proc.exited} before painting a frame`);
	}
	return handles;
}

/** Write one keystroke and resolve on the terminal write that answers it. */
async function pressAndAwait(handles: SessionHandles, key: string, timeoutMs: number): Promise<InputSample> {
	const bytesBefore = handles.bytesWritten();
	const tKey = performance.now();
	handles.terminal.write(key);
	const latencyMs = await Promise.race([
		(async () => {
			// Waiting on the event rather than sleeping is load-bearing: a fixed
			// delay would either over-report every sample or race the repaint. The
			// repo's own pty test carries the comment to match.
			while (handles.bytesWritten() === bytesBefore) await Bun.sleep(2);
			return performance.now() - tKey;
		})(),
		Bun.sleep(timeoutMs).then(() => null),
	]);
	if (latencyMs === null) {
		throw new SampleFailure("no-input-response", `no repaint within ${timeoutMs}ms of a keystroke`);
	}
	return { latencyMs };
}

/**
 * One interactive sample: spawn under a pty, wait for the first painted frame,
 * then prove that frame answers input.
 */
export async function measureInteractiveFrame(options: RunOptions): Promise<InteractiveFrameSample> {
	const handles = await startInteractive(options);
	try {
		const { latencyMs } = await pressAndAwait(handles, "x", options.timeoutMs);
		return {
			firstInteractiveFrameMs: handles.composerAt - handles.t0,
			inputRoundTripMs: latencyMs,
			composerPainted: handles.composerAt > 0,
			// Kept as a diagnostic: the gap between "first byte" and "first
			// interactive frame" is the part of the boot that is not yet usable.
			firstTerminalWriteMs: handles.firstWriteAt - handles.t0,
			capabilityProbesSeen: handles.probesSeen,
			capabilityProbesAnswered: handles.probesAnswered,
		};
	} finally {
		await handles.dispose();
	}
}

/**
 * Open one interactive session and keep it open, for benchmarks that sample many
 * input events inside a single launch instead of relaunching per sample.
 */
export async function openInteractiveSession(options: RunOptions): Promise<InteractiveSession> {
	const handles = await startInteractive(options);
	return {
		firstInteractiveFrameMs: handles.composerAt - handles.t0,
		firstTerminalWriteMs: handles.firstWriteAt - handles.t0,
		press: key => pressAndAwait(handles, key, options.timeoutMs),
		close: () => handles.dispose(),
	};
}

/**
 * One pre-paint chain sample: spawn under `PI_TIMING=x` and time the clean
 * exit. The app prints its timing tree to stderr and exits 0 before mounting
 * the TUI, so this terminates without input and without a timeout race.
 */
export async function measurePrePaintChain(options: RunOptions): Promise<PrePaintChainSample> {
	const home = options.coldCache ? mkdtempSync(join(tmpdir(), "omp-bench-home-")) : tmpdir();
	const argv = [process.execPath];
	if (options.moduleProfile) argv.push("--preload", MODULE_TIMER);
	argv.push(CLI_ENTRY);
	const decoder = new TextDecoder();
	let stderr = "";
	const t0 = performance.now();

	await using terminal = new Bun.Terminal({
		cols: TERM_COLS,
		rows: TERM_ROWS,
		data(_t, data: Uint8Array) {
			if (data.length > 0) stderr += decoder.decode(data, { stream: true });
		},
		exit() {},
	});

	const proc = Bun.spawn(argv, {
		cwd: options.repoRoot,
		env: buildEnv(options, home),
		terminal,
	});

	try {
		const code = await proc.exited;
		const wallMs = performance.now() - t0;
		if (code !== 0) {
			throw new SampleFailure("nonzero-exit", `PI_TIMING boot exited ${code}: ${stripAnsi(stderr).slice(-400)}`);
		}
		if (!stderr.includes("Startup timings")) {
			throw new SampleFailure(
				"no-timing-tree",
				`expected logger.printTimings() output; got: ${stripAnsi(stderr).slice(-400)}`,
			);
		}
		return { wallMs, ...parseTimingTree(stderr) };
	} finally {
		if (options.coldCache) rmSync(home, { recursive: true, force: true });
	}
}
