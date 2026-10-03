import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Contract: a ref'd hold keeps the event loop alive across a window whose only
 * pending work is an unresolved promise, releasing it lets the loop drain
 * again, and the drain report itself reaches the real stderr even when the
 * stderr guard has fd 2 pointed at a log file.
 *
 * Subprocesses: the probe arms the guard (a raw dup2 of fd 2) and one mode
 * never returns, so neither belongs in the test runner's own process.
 */

const PROBE = path.resolve(import.meta.dir, "fixtures/event-loop-drain-probe.ts");
const ALIVE_WINDOW_MS = 3_000;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { force: true, recursive: true });
	}
});

interface ProbeResult {
	/** false when the probe had to be killed: it was still running. */
	exited: boolean;
	exitCode?: number;
	stderr: string;
	redirect: string;
}

async function runProbe(mode: "bare" | "held" | "released"): Promise<ProbeResult> {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-loop-hold-"));
	tempDirs.push(dir);
	const redirectPath = path.join(dir, "redirect.log");

	const proc = Bun.spawn([process.execPath, PROBE, mode, redirectPath], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});

	const outcome = await Promise.race([
		proc.exited.then((code: number) => ({ drained: true, code })),
		Bun.sleep(ALIVE_WINDOW_MS).then(() => ({ drained: false, code: undefined })),
	]);
	if (!outcome.drained) proc.kill();
	const exitCode = outcome.drained ? outcome.code : await proc.exited;
	const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();

	return {
		exited: outcome.drained,
		exitCode,
		stderr,
		redirect: fs.existsSync(redirectPath) ? fs.readFileSync(redirectPath, "utf8") : "",
	};
}

describe("event-loop keepalive", () => {
	it("keeps a promise-only window alive, and releasing the hold lets it drain again", async () => {
		const held = await runProbe("held");
		// Without the hold the same probe drains and fails; with it, still running
		// when the window closes is the whole point.
		expect(held.exited).toBe(false);

		for (const mode of ["bare", "released"] as const) {
			const drained = await runProbe(mode);
			expect(drained.exited).toBe(true);
			expect(drained.exitCode).toBe(1);
		}
	}, 30_000);

	it("reports the drain on the real stderr, not into the redirected log file", async () => {
		const drained = await runProbe("bare");

		expect(drained.stderr).toContain("`omp probe` ended before completing");
		expect(drained.stderr).toContain("the event loop drained while it was still pending");
		expect(drained.redirect).not.toContain("ended before completing");
	}, 30_000);
});
