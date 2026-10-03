/**
 * Ref'd event-loop hold: keeps the process alive across a window whose only
 * pending work is an unresolved promise.
 *
 * ## Why this exists
 *
 * `reportUnsettledEntry()` (postmortem.ts) treats an empty event loop while the
 * top-level command promise is still pending as a failure, because a command
 * that "finishes" that way never finished: Bun exits 0 (or, with the guard, 1
 * after printing one line) and the launch is silently over.
 *
 * The window is only safe if something is *ref'd* for its whole duration. An
 * `await` holds the loop only as long as the operation it is waiting on keeps
 * a live handle of its own. Some operations do not: Bun 1.4.2 settles a
 * `Bun.file()` read that rejects with ENOENT without registering a ref, which
 * is why `launch/client.ts` reads its broker token with `node:fs` instead.
 * Every such await is a single-point drain.
 *
 * ## How to use it
 *
 * Hold across the window, release at the handoff where real work takes over:
 *
 * ```ts
 * const release = keepEventLoopAlive();
 * try {
 *   await bootstrap();
 * } finally {
 *   release();
 * }
 * await runSomethingThatOwnsItsOwnHandles();
 * ```
 *
 * ## Not `EventLoopKeepalive`
 *
 * `EventLoopKeepalive` (pi-agent-core) is deliberately `unref()`ed: it stops
 * Bun from busy-waiting while parked on a promise but must never be what keeps
 * the process alive. This hold is the opposite trade — it is ref'd on purpose,
 * so it does keep the process alive, and a caller that forgets to release it
 * turns a drain into a hang. Pair it with a bounded reporter (an unref'd
 * "still working" timer) so a genuinely stuck window is still diagnosable.
 */

/** Interval long enough to never fire, short enough to stay a plain timer. */
const HOLD_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Hold the event loop open until the returned callback runs. The callback is
 * idempotent, so a `finally` plus an explicit release on the success path is
 * safe.
 *
 * @returns release callback that drops the hold.
 */
export function keepEventLoopAlive(): () => void {
	const timer = setInterval(() => {}, HOLD_INTERVAL_MS);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		clearInterval(timer);
	};
}
