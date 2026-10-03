/**
 * Result-document assembly.
 *
 * The leaderboard owns the schema (`labz-apps/omp-leaderboard/src/schema.mjs`)
 * and `npm run import-result` is the only supported way in. This file does not
 * reimplement that schema as a second source of truth — it builds a document to
 * that contract and then *re-checks the load-bearing invariants locally*, so a
 * bad run fails here with a readable message instead of three repositories away
 * with a validation dump.
 *
 * What is deliberately not here: any `delta` field, any interpolation, and any
 * default for a missing measurement. The site computes deltas from two
 * provenanced runs; storing one is rejected by the build and would be a lie
 * about which two runs were compared.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { MetricSummary } from "./stats";
import type { CommitInfo, MachineInfo, Versions } from "./provenance";

/**
 * Which program was launched. Must match `BUILD_TYPES` in omp-leaderboard.
 *
 * This is a series key, not a note: a source run, the npm bundle, and a
 * compiled binary are three different programs, so a delta between two of them
 * would be measuring the packaging instead of the change. The harness only ever
 * produces a source run; the other two need their own entry points.
 */
export const BUILD_TYPE = "source" as const;

/** Must match `SCHEMA_VERSION` in omp-leaderboard. */
export const SCHEMA_VERSION = 1;

/**
 * Bump when the meaning of a number changes (a new metric definition, a change
 * to the percentile estimator, a change to what a sample is). Results with
 * different harness versions are not comparable even when the field names
 * match.
 */
export const HARNESS_VERSION = "1";

export interface HarnessConfig {
	runs: number;
	warmupRuns: number;
	coldCache: boolean;
	[key: string]: unknown;
}

export interface ResultDoc {
	schemaVersion: number;
	runId: string;
	benchmark: "cold-start" | "time-to-render";
	startedAt: string;
	finishedAt: string;
	commit: CommitInfo;
	/** null until the pull request merges; such a run is never a leaderboard row. */
	pr: null;
	machine: MachineInfo;
	versions: Versions;
	harness: { version: string; command: string; build: string; config: HarnessConfig };
	metrics: Record<string, MetricSummary>;
	/** Free-form, schema-permitted extras kept out of `metrics`. */
	diagnostics?: Record<string, unknown>;
}

export interface BuildDocInput {
	benchmark: ResultDoc["benchmark"];
	runId: string;
	startedAt: Date;
	finishedAt: Date;
	commit: CommitInfo;
	machine: MachineInfo;
	versions: Versions;
	command: string;
	config: HarnessConfig;
	metrics: Record<string, MetricSummary>;
	diagnostics?: Record<string, unknown>;
}

export function buildResultDoc(input: BuildDocInput): ResultDoc {
	return {
		schemaVersion: SCHEMA_VERSION,
		runId: input.runId,
		benchmark: input.benchmark,
		startedAt: input.startedAt.toISOString(),
		finishedAt: input.finishedAt.toISOString(),
		commit: input.commit,
		pr: null,
		machine: input.machine,
		versions: input.versions,
		harness: { version: HARNESS_VERSION, command: input.command, build: BUILD_TYPE, config: input.config },
		metrics: input.metrics,
		...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
	};
}

/**
 * The invariants whose violation would be rejected by the importer or the
 * build. Checked here purely to fail early and legibly.
 */
export function assertPublishable(doc: ResultDoc): void {
	const problems: string[] = [];
	if (doc.schemaVersion !== SCHEMA_VERSION) problems.push(`schemaVersion must be ${SCHEMA_VERSION}`);
	if (!doc.runId.trim()) problems.push("runId must not be empty");
	if (doc.finishedAt < doc.startedAt) problems.push("finishedAt precedes startedAt");
	if (!/^[0-9a-f]{7,40}$/.test(doc.commit.sha)) problems.push("commit.sha is not a lowercase hex sha");
	if (!/^[\w.-]+\/[\w.-]+$/.test(doc.commit.repo)) problems.push("commit.repo is not an owner/name slug");
	if (!doc.machine.id.trim()) problems.push("machine.id must not be empty");
	if (doc.machine.physicalCores <= 0) problems.push("machine.physicalCores must be positive");
	if (doc.machine.memoryGb <= 0) problems.push("machine.memoryGb must be positive");
	if (!doc.harness.command.trim()) problems.push("harness.command must not be empty");
	if (!doc.harness.version.trim()) problems.push("harness.version must not be empty");
	if (!["source", "bundle", "binary"].includes(doc.harness.build)) {
		problems.push(`harness.build must be one of source, bundle, binary (got ${doc.harness.build})`);
	}
	if (!/^[0-9a-f]{7,40}$/.test(doc.commit.shaAtFinish)) {
		problems.push("commit.shaAtFinish must be a lowercase hex sha");
	} else if (doc.commit.shaAtFinish !== doc.commit.sha) {
		problems.push("commit.shaAtFinish differs from commit.sha: the tree moved during the run");
	}
	if (!Number.isInteger(doc.machine.concurrentRuns) || doc.machine.concurrentRuns < 1) {
		problems.push("machine.concurrentRuns must be an integer >= 1");
	}
	if (Object.keys(doc.metrics).length === 0) problems.push("metrics must not be empty");

	for (const [name, metric] of Object.entries(doc.metrics)) {
		if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(name)) {
			problems.push(`metrics.${name}: metric names must be camelCase identifiers`);
			continue;
		}
		if (metric.unit !== "ms") problems.push(`metrics.${name}.unit must be "ms"`);
		if (!Number.isInteger(metric.samples) || metric.samples <= 0) {
			problems.push(`metrics.${name}.samples must be a positive integer`);
		}
		if (!Number.isFinite(metric.p50) || metric.p50 < 0) problems.push(`metrics.${name}.p50 is invalid`);
		if (!Number.isFinite(metric.p95) || metric.p95 < 0) problems.push(`metrics.${name}.p95 is invalid`);
		if (metric.p95 < metric.p50) problems.push(`metrics.${name}: p95 must be >= p50`);
	}
	// A stored delta is rejected by the build and is never the harness's to compute.
	if ("delta" in (doc as unknown as Record<string, unknown>)) {
		problems.push("a result file must not carry a delta");
	}

	if (problems.length > 0) {
		throw new Error(`result would be rejected by import-result:\n  - ${problems.join("\n  - ")}`);
	}
}

/** Write the doc to `path`, creating parents. Returns the path. */
export async function writeResultDoc(doc: ResultDoc, path: string): Promise<string> {
	assertPublishable(doc);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
	return path;
}
