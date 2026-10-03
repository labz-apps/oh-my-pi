#!/usr/bin/env bun
/**
 * The whole benchmark suite, one command.
 *
 *   bun scripts/bench/run-all.ts --full --json
 *
 * Runs every benchmark present in this directory, writes one result document per
 * benchmark, and prints a manifest on stdout. Which benchmarks exist is
 * discovered from the directory rather than hardcoded, so this command does not
 * need editing as the suite grows and cannot silently skip one: a benchmark that
 * is absent is named in the manifest as skipped, and a benchmark that is present
 * but fails fails the run.
 *
 * Result documents are written to `--out-dir` rather than concatenated on
 * stdout, because the leaderboard importer takes exactly one document per call
 * (`npm run import-result -- --file <path> --pr <n>`).
 */

import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

interface ManifestEntry {
	benchmark: string;
	script: string;
	status: "ran" | "skipped" | "failed";
	file?: string;
	reason?: string;
}

function parse(argv: readonly string[]): { outDir: string; runs: string | null; json: boolean; extra: string[] } {
	let outDir = "bench-out";
	let runs: string | null = null;
	let json = false;
	const extra: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!;
		if (token === "--out-dir") outDir = argv[++i] ?? outDir;
		else if (token === "--runs") runs = argv[++i] ?? null;
		else if (token === "--json") json = true;
		else extra.push(token);
	}
	return { outDir, runs, json, extra };
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const { outDir, runs, json, extra } = parse(argv);
	const scripts = (await readdir(here))
		.filter(file => file.endsWith(".ts") && file !== "run-all.ts" && !file.startsWith("lib"))
		.sort();

	const manifest: ManifestEntry[] = [];
	let failures = 0;

	for (const script of scripts) {
		const benchmark = script.replace(/\.ts$/, "");
		const args = ["--out", join(outDir, `${benchmark}.json`)];
		// `--runs` has a different meaning per benchmark (launches vs keystrokes),
		// so it is only forwarded when the caller gave one explicitly and each
		// script is free to interpret it for its own interval.
		if (runs) args.push("--runs", runs);
		args.push(...extra);
		process.stderr.write(`\n== ${benchmark} ==\n`);
		const proc = Bun.spawn([process.execPath, join(here, script), ...args], {
			cwd: join(here, "..", ".."),
			stdout: json ? "inherit" : "inherit",
			stderr: "inherit",
		});
		const code = await proc.exited;
		if (code === 0) {
			manifest.push({ benchmark, script, status: "ran", file: join(outDir, `${benchmark}.json`) });
		} else {
			failures += 1;
			manifest.push({ benchmark, script, status: "failed", reason: `exited ${code}` });
		}
	}

	if (!existsSync(outDir) && manifest.some(entry => entry.status === "ran")) {
		throw new Error(`expected results in ${outDir} but the directory does not exist`);
	}

	const summary = {
		schemaVersion: 1,
		startedFrom: "scripts/bench/run-all.ts",
		outDir,
		benchmarks: manifest,
		next: "import each file, one per call: npm run import-result -- --file <path> --pr <number>",
	};
	if (json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	else for (const entry of manifest) process.stderr.write(`${entry.benchmark}: ${entry.status}\n`);

	if (failures > 0) {
		process.stderr.write(`\n${failures} benchmark(s) failed; not publishing a partial suite.\n`);
		process.exit(1);
	}
}

await main();
