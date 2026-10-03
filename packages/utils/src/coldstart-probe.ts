/**
 * Cold-start probe, enabled by `OMP_COLDSTART_PROBE=<path>`.
 *
 * Appends one JSON line per named mark to the given file, stamped on the same
 * wall clock the launch harness reads before spawning, so "process launch to
 * first interactive frame" is measurable without trusting in-process spans
 * (which start after the module graph is already loaded).
 *
 * Each line also carries this process's cumulative user+system CPU time. Wall
 * clock on a shared machine moves with every competing process, while CPU time
 * only moves when the work itself changes, so before/after comparisons should
 * read the CPU column.
 *
 * Marks are written with `fs.appendFileSync` on purpose: the readiness marks
 * sit at points where the surrounding code is synchronous, and a queued write
 * would either land after the frame or move the very latency it measures.
 *
 * Set `OMP_COLDSTART_PROBE_APPEND=1` to keep an existing file (harness use);
 * without it the file is truncated on the first mark of the process.
 *
 * The env read happens once at module load; an unset variable makes every mark a
 * single boolean check.
 */
import * as fs from "node:fs";

let path: string | undefined = process.env.OMP_COLDSTART_PROBE;
const append = process.env.OMP_COLDSTART_PROBE_APPEND === "1";
let truncated = false;

/** Wall-clock milliseconds, comparable across processes on the same machine. */
export function coldstartProbe(mark: string): void {
	if (path === undefined || path === "") return;
	const usage = process.cpuUsage();
	const line = JSON.stringify({
		mark,
		t: performance.timeOrigin + performance.now(),
		cpu: (usage.user + usage.system) / 1000,
	});
	try {
		if (!truncated) {
			truncated = true;
			if (!append) fs.writeFileSync(path, "");
		}
		fs.appendFileSync(path, `${line}\n`);
	} catch {
		path = undefined;
	}
}
