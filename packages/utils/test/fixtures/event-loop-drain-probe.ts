/**
 * Reproduces the launch-drain precondition in isolation.
 *
 * `bare` — an `await` on a promise with no underlying handle. The loop drains,
 * `beforeExit` fires, and `reportUnsettledEntry` prints its one-line verdict.
 * This is what `omp launch` did when a startup await settled without holding an
 * event-loop ref.
 *
 * `held` — the same await with a ref'd hold across the window. The loop must
 * not drain, so the launch survives instead of ending.
 *
 * `released` — the hold is armed and released again before the await. It must
 * drain exactly like `bare`: the hold prevents a premature drain, it does not
 * turn the process into something that can never exit.
 *
 * `bare` and `released` additionally arm the stderr guard first, standing in
 * for the TUI-owned viewport, so the drain report's own visibility is covered.
 *
 * Runs in a subprocess — it arms the guard (which dup2's fd 2) and never
 * returns.
 */
import { keepEventLoopAlive } from "../../src/event-loop-keepalive";
import { reportUnsettledEntry } from "../../src/postmortem";
import { suppressTerminalStderr } from "../../src/stderr-guard";

const mode = process.argv[2];
const redirectPath = process.argv[3];

if (mode === "bare" || mode === "released") {
	// Force, not gate: this probe's stderr is a pipe, and the point is to prove
	// the drain report escapes a redirected fd 2.
	suppressTerminalStderr({ force: true, redirectPath });
}

if (mode === "held" || mode === "released") {
	const release = keepEventLoopAlive();
	if (mode === "released") release();
}

// Never settles and owns no handle — the only thing this process is waiting on.
// Floating call, not top-level await: a pending TLA is itself pending work, so
// it would mask the very drain under test. The CLI entry has the same shape.
const pending = new Promise<void>(() => {});
reportUnsettledEntry(pending, () => "probe");
void (async () => {
	await pending;
})();
