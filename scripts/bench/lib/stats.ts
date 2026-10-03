/**
 * Percentile maths for the benchmark harness.
 *
 * The measurement contract forbids a mean and requires p50 *and* p95 for every
 * metric, because a change that leaves the median alone and doubles the tail is
 * a regression a user feels. That makes the percentile definition itself part of
 * the contract: two harnesses that disagree about which sample is "p95" will
 * disagree about whether a change regressed, and neither will be lying.
 *
 * So the estimator is fixed here, stated once, and never switched casually:
 * **nearest-rank on the sorted sample, with no interpolation.**
 *
 *   rank  = ceil(p / 100 * n)      clamped to [1, n]
 *   value = sorted[rank - 1]
 *
 * Nearest-rank was chosen over linear interpolation because it always returns an
 * actually-observed sample. An interpolated p95 is a number no run ever
 * produced, which makes "p95 got worse" harder to argue with and impossible to
 * reproduce from the raw samples by inspection. With `n = 20`, p95 is the 19th
 * of 20 sorted samples; with `n = 200`, p95 is the 190th.
 *
 * Every result file records `harness.version`. Bumping this file's estimator
 * is a semantic change to the harness and must bump that too, or two series
 * will be compared on different statistics.
 */

/** One metric's distribution, as it appears in a result file. */
export interface MetricSummary {
	unit: "ms";
	p50: number;
	p95: number;
	samples: number;
	min: number;
	max: number;
}

/**
 * Nearest-rank percentile of an unsorted sample. See the module comment for why
 * this estimator and not another.
 *
 * @param values sample values; must not be empty
 * @param p percentile in [0, 100]
 */
export function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) throw new Error("percentile of an empty sample");
	if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error(`percentile out of range: ${p}`);
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.ceil((p / 100) * sorted.length);
	const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
	return sorted[index]!;
}

/**
 * Summarise a sample into the shape `omp-leaderboard`'s schema requires:
 * `unit: "ms"`, `p50`, `p95`, `samples`, and the observed extremes.
 *
 * Rounded to 0.001 ms (nanosecond resolution). Rounding happens here, once, so
 * the value in the result file is exactly the value the site renders.
 */
export function summarize(values: readonly number[]): MetricSummary {
	if (values.length === 0) throw new Error("cannot summarize an empty sample");
	const sorted = [...values].sort((a, b) => a - b);
	const round = (n: number) => Math.round(n * 1000) / 1000;
	return {
		unit: "ms",
		p50: round(percentile(sorted, 50)),
		p95: round(percentile(sorted, 95)),
		samples: sorted.length,
		min: round(sorted[0]!),
		max: round(sorted[sorted.length - 1]!),
	};
}

/** Median-of-three trimmed mean, for reporting only. Never a published metric. */
export function spread(values: readonly number[]): number {
	if (values.length < 2) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return round3(sorted[sorted.length - 1]! - sorted[0]!);
}

function round3(n: number): number {
	return Math.round(n * 1000) / 1000;
}
