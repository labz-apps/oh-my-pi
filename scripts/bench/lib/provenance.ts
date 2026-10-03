/**
 * Provenance for a harness run.
 *
 * The measurement contract's rule is that a stage which cannot prove which
 * commit, machine, and command it came from is not a stage. That makes this
 * file the part of the harness with no interesting logic and the most
 * important one: everything here exists so that a number on the leaderboard can
 * be traced back to one commit on one machine, and so that two runs only get
 * compared when they really are comparable.
 *
 * Two of those rules drive the design:
 *
 *   - Machine id is a *stable* identifier. It is derived from the CPU model,
 *     core count, OS, and arch, so the same box produces the same id across runs
 *     and weeks, and a different box cannot accidentally share a series.
 *   - Results are never compared across machines. `machine.id` is the series
 *     key on the leaderboard, so it must not encode anything transient (a
 *     hostname, a boot id, a load average).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Repo root: scripts/bench/lib -> scripts/bench -> scripts -> repo root. */
export const REPO_ROOT = resolve(here, "..", "..", "..");

/** Which build of the product is being measured. See the README's series rules. */
export const BUILD_TYPE = "source-run-bun" as const;

export interface MachineInfo {
	id: string;
	cpuModel: string;
	physicalCores: number;
	memoryGb: number;
	os: string;
	arch: string;
}

export interface CommitInfo {
	sha: string;
	repo: string;
	message?: string;
}

export interface Versions {
	ohMyPi: string;
	runtime: string;
	runtimeVersion: string;
}

function readTrimmed(path: string): string | undefined {
	try {
		const text = readFileSync(path, "utf8").trim();
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

/** First `model name` line from /proc/cpuinfo, else the platform description. */
export function detectCpuModel(): string {
	const cpuinfo = readTrimmed("/proc/cpuinfo");
	if (cpuinfo) {
		const match = cpuinfo.match(/^model name\s*:\s*(.+)$/m);
		if (match) return match[1]!.trim();
	}
	return `${platform()} ${arch()}`;
}

/**
 * Physical cores, not logical ones. Hyperthreading changes how a startup's
 * parallel work schedules, so `nproc` would make the same box look like two
 * different machines. Falls back to `os.cpus().length` where /proc is absent.
 */
export function detectPhysicalCores(): number {
	const cpuinfo = readTrimmed("/proc/cpuinfo");
	if (cpuinfo) {
		// One "core id" block per physical core.
		const ids = new Set<string>();
		let current = "";
		for (const line of cpuinfo.split("\n")) {
			const match = line.match(/^(physical id|core id)\s*:\s*(.+)$/);
			if (!match) continue;
			if (match[1] === "physical id") current = `${current}|${match[2]!.trim()}`;
			else ids.add(`${current}|${match[2]!.trim()}`);
		}
		if (ids.size > 0) return ids.size;
	}
	const cores = readTrimmed("/proc/self/status")?.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
	if (cores) {
		let total = 0;
		for (const part of cores[1]!.trim().split(",")) {
			const [lo, hi] = part.split("-");
			total += (hi ? Number(hi) : Number(lo)) - Number(lo) + 1;
		}
		if (total > 0) return total;
	}
	const online = Number(Bun.spawnSync(["getconf", "_NPROCESSORS_ONLN"]).stdout.toString().trim());
	return Number.isFinite(online) && online > 0 ? online : 1;
}

function detectMemoryGb(): number {
	const meminfo = readTrimmed("/proc/meminfo");
	const kb = meminfo?.match(/^MemTotal:\s*(\d+) kB$/m)?.[1];
	if (kb) return round2(Number(kb) / 1024 / 1024);
	// macOS and BSDs report bytes.
	const bytes = meminfo?.match(/^MemTotal:\s*(\d+)$/m)?.[1];
	if (bytes) return round2(Number(bytes) / 1024 ** 3);
	return (
		round2(
			Bun.spawnSync(["sysctl", "-n", "hw.memsize"]).stdout.toString().trim()
				? Number(Bun.spawnSync(["sysctl", "-n", "hw.memsize"]).stdout.toString().trim()) / 1024 ** 3
				: 0,
		) || 0
	);
}

function detectOs(): string {
	const release = readTrimmed("/etc/os-release");
	if (release) {
		const pretty = release.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1];
		if (pretty) return pretty;
		const name = release.match(/^NAME="?([^"\n]+)"?$/m)?.[1];
		const version = release.match(/^VERSION_ID="?([^"\n]+)"?$/m)?.[1];
		if (name) return version ? `${name} ${version}` : name;
	}
	return `${platform()} ${arch()}`;
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

/** Stable, human-readable slug. Same box -> same id, always. */
export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
}

/**
 * The comparison basis. `id` is derived only from durable hardware and OS
 * facts, never from a hostname or a boot id, so a series survives a reboot and
 * a rename.
 */
export function detectMachine(): MachineInfo {
	const cpuModel = detectCpuModel();
	const physicalCores = detectPhysicalCores();
	const memoryGb = detectMemoryGb();
	const osName = detectOs();
	const archName = arch();
	// Memory is deliberately *not* in the id: memory size can be reported with
	// small differences across boots (hotplug, cgroup rounding) and a changed
	// id would silently split one series in two.
	const id = `${slug(`${platform()}-${archName}-${cpuModel}`)}-${physicalCores}`;
	return { id, cpuModel, physicalCores, memoryGb, os: osName, arch: archName };
}

function git(args: string[], cwd = REPO_ROOT): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

/** `owner/name` from the origin remote, falling back to the documented repo. */
export function detectRepo(): string {
	const url = git(["remote", "get-url", "origin"]);
	const match = url.match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
	if (match) return `${match[1]}/${match[2]}`;
	return "labz-apps/oh-my-pi";
}

export function detectCommit(): CommitInfo {
	const sha = git(["rev-parse", "HEAD"]);
	if (!/^[0-9a-f]{7,40}$/.test(sha)) {
		throw new Error(`could not read a commit sha from git (got ${JSON.stringify(sha)})`);
	}
	const message = git(["log", "-1", "--format=%s"]);
	return { sha, repo: detectRepo(), ...(message ? { message } : {}) };
}

/** oh-my-pi's own version, from the package that ships the CLI. */
export function detectOhMyPiVersion(): string {
	const pkg = readTrimmed(join(REPO_ROOT, "packages", "coding-agent", "package.json"));
	if (!pkg) throw new Error("could not read packages/coding-agent/package.json");
	try {
		return (JSON.parse(pkg) as { version?: string }).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

export function detectVersions(): Versions {
	return {
		ohMyPi: detectOhMyPiVersion(),
		runtime: "bun",
		runtimeVersion: typeof Bun === "undefined" ? "unknown" : Bun.version,
	};
}

/**
 * A run identifier that is unique per run and sorts by time:
 * `<benchmark>-<YYYYMMDDTHHMMSSZ>-<short random>`.
 *
 * The leaderboard sanitises it into a filename and uses it as the last segment
 * of the result-file identity, so two runs of the same benchmark on the same
 * commit must not collide. The random suffix is what guarantees that when two
 * harnesses start in the same second.
 */
export function newRunId(benchmark: string, now = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
	const rand = Math.random().toString(36).slice(2, 7);
	return `${benchmark}-${stamp}-${rand}`;
}
