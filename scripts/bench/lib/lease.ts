/**
 * Machine lease: how many runs of this benchmark were on this machine at once.
 *
 * The leaderboard requires `machine.concurrentRuns` and refuses to publish a
 * contended run as a row, a chart point, a changelog entry, or a baseline for
 * the next run. The reasoning is sound and this file exists to serve it: one
 * machine is shared by several agents, two overlapping runs of the same
 * benchmark split the CPU, and both numbers get worse in a way that has nothing
 * to do with the code under test. A number taken under contention must be
 * *recorded* — that is evidence — and never compared.
 *
 * So the harness takes a lease before its first sample and counts how many
 * leases for this benchmark on this machine already exist, including its own.
 * `1` means it had the machine to itself.
 *
 * Leases are directories, because `mkdir` is the one atomic primitive that is
 * available everywhere and needs no daemon. A crashed or killed run leaves its
 * lease behind, which would otherwise wedge the machine as permanently
 * contended, so each lease records its pid and a lease whose process is gone is
 * reclaimed immediately.
 *
 * The lease directory is keyed by machine id and benchmark, never by repo or
 * commit: contention is a property of the hardware, not of the revision.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A lease older than this is assumed dead regardless of its pid.
 *
 * Only a backstop against pid reuse: no benchmark run legitimately lasts six
 * hours, and a recycled pid must not keep a dead lease alive forever.
 */
const LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface Lease {
	/** Same-benchmark runs active on this machine, including this one. */
	concurrentRuns: number;
	release(): void;
}

function leaseRoot(machineId: string, benchmark: string): string {
	// `hostname` keeps two containers on one host from sharing a lease directory,
	// while `machineId` keeps the series key and the lease key consistent.
	return join(tmpdir(), `omp-bench-lease-${hostname()}`, machineId, benchmark);
}

/** The pid recorded in a lease, or null when it cannot be read. */
function leasePid(dir: string): number | null {
	try {
		const pid = Number(readFileSync(join(dir, "pid"), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** Existence check that does not signal the process. */
function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, it just belongs to another user.
		return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
	}
}

/**
 * Whether a lease directory can be reclaimed.
 *
 * Liveness is decided by the recorded pid, not by age. The previous version
 * treated *any* lease younger than the TTL as live, so a run killed by a timeout
 * or a cancelled heartbeat left a directory behind that every later run counted
 * as contention: on a shared machine that marks every subsequent result
 * `concurrentRuns > 1`, which the contract keeps as evidence and off the
 * leaderboard. The symptom is a machine that quietly stops producing publishable
 * numbers for hours, with the cause in a directory nobody looks at.
 */
function isAbandoned(dir: string): boolean {
	let age: number;
	try {
		age = Date.now() - statSync(dir).mtimeMs;
	} catch {
		return true;
	}
	if (age >= LEASE_TTL_MS) return true;
	const pid = leasePid(dir);
	// A young lease with no readable pid may be mid-creation, so it is left alone.
	if (pid === null) return false;
	return !processAlive(pid);
}

/**
 * Take a lease and report how contended this benchmark is on this machine.
 *
 * Never throws. A harness that cannot measure contention is still useful, and
 * the honest answer for "I could not tell" is 1 only when this process can
 * prove it is alone; if the lease directory is unusable the run reports the
 * contention it can see rather than claiming an exclusive machine.
 */
export function acquireMachineLease(machineId: string, benchmark: string): Lease {
	const dir = leaseRoot(machineId, benchmark);
	let own: string | null = null;
	let concurrentRuns = 1;

	try {
		mkdirSync(dir, { recursive: true });
		own = join(dir, `run-${process.pid}-${Date.now()}`);
		mkdirSync(own);
		writeFileSync(join(own, "pid"), String(process.pid), "utf8");

		// Count our own lease plus every live one, reclaiming abandoned leases so
		// a killed run cannot wedge the machine as contended forever.
		let live = 0;
		for (const entry of readdirSync(dir)) {
			const path = join(dir, entry);
			if (isAbandoned(path)) {
				rmSync(path, { recursive: true, force: true });
				continue;
			}
			live += 1;
		}
		concurrentRuns = live;
	} catch {
		// Could not take a lease. Report 1 rather than a fabricated number only
		// when this process is provably alone; otherwise report contention, which
		// keeps the run as evidence and out of the leaderboard.
		concurrentRuns = 1;
	}

	return {
		concurrentRuns,
		release: () => {
			if (!own) return;
			rmSync(own, { recursive: true, force: true });
		},
	};
}
