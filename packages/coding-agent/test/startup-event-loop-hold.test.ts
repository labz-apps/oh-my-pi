/**
 * Regression (OHM-17): `omp launch` used to exit part-way through startup on the
 * hosted CI runner, printing `omp: \`omp launch\` ended before completing: the
 * event loop drained while it was still pending` instead of opening its prompt.
 *
 * `scripts/ci-test-ts.ts` sets `PI_TEST_RUNTIME=1` in every chunk, and this test
 * passes `...process.env` through to the spawned CLI exactly as
 * `test/utils/changelog.test.ts` does. That flag makes the terminal headless, so
 * the launch owns no terminal and reads no stdin, and it also skips the startup
 * watchdog. Nothing then holds an event-loop ref except whatever each awaited
 * operation holds itself, and a promise resolved by an `unref()`ed timer holds
 * none — the loop empties, `beforeExit` fires, and the launch ends.
 *
 * This spawns the real entry under a pty with that same flag, so the assertion is
 * the product contract: a launch that is still starting must still be running.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries, VERSION } from "@oh-my-pi/pi-utils";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
const packageDir = path.join(repoRoot, "packages", "coding-agent");
const hasPtyHarness =
	process.platform === "linux" &&
	(await Bun.file("/usr/bin/script").exists()) &&
	(await Bun.file("/usr/bin/timeout").exists());

/** The broken launch died at ~4.5s; the deadline only has to exceed that. */
const LAUNCH_DEADLINE = "12s";

describe.skipIf(!hasPtyHarness)("omp launch under a headless runtime", () => {
	test("keeps the event loop alive instead of draining mid-startup", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-launch-hold-"));
		const agentDir = path.join(root, "agent");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			for (const dir of ["xdg-config", "xdg-state", "xdg-data"]) {
				await fs.mkdir(path.join(root, dir), { recursive: true });
			}
			// setupVersion 1 < CURRENT_SETUP_VERSION is what makes this a fresh
			// install, so the changelog marker gets written during startup and the
			// assertion below proves the launch got that far rather than dying early.
			await Bun.write(path.join(agentDir, "config.yml"), "setupVersion: 1\n");

			const proc = Bun.spawn(
				["timeout", LAUNCH_DEADLINE, "script", "-q", "-c", `bun ${JSON.stringify(cliEntry)}`, "/dev/null"],
				{
					cwd: repoRoot,
					stdout: "pipe",
					stderr: "pipe",
					env: {
						...process.env,
						HOME: root,
						XDG_CONFIG_HOME: path.join(root, "xdg-config"),
						XDG_STATE_HOME: path.join(root, "xdg-state"),
						XDG_DATA_HOME: path.join(root, "xdg-data"),
						PI_CODING_AGENT_DIR: agentDir,
						PI_PACKAGE_DIR: packageDir,
						PI_NO_TITLE: "1",
						NO_COLOR: "1",
						TERM: "xterm-256color",
						// What `ci-test-ts` sets for every chunk, and what makes the
						// launch headless there. Pinned rather than inherited so this
						// keeps testing the failing configuration when a developer runs
						// it outside the CI runner.
						PI_TEST_RUNTIME: "1",
					},
				},
			);

			const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

			// 124 is `timeout`'s "still running at the deadline". Anything else means
			// the launch ended on its own, which is the bug.
			if (exitCode !== 124) {
				console.error(
					[
						`[launch-event-loop-hold] exitCode=${exitCode} signal=${proc.signalCode ?? "-"}`,
						`[launch-event-loop-hold] stdoutBytes=${Buffer.byteLength(stdout)}`,
						`[launch-event-loop-hold] drained=${stdout.includes("the event loop drained")}`,
						`[launch-event-loop-hold] --- stdout tail ---\n${stdout.slice(-3000)}`,
					].join("\n"),
				);
			}
			expect(stdout).not.toContain("the event loop drained");
			expect(exitCode).toBe(124);
			expect(await Bun.file(path.join(agentDir, "last-changelog-version")).text()).toBe(VERSION);
		} finally {
			await removeWithRetries(root);
		}
	}, 60_000);
});
