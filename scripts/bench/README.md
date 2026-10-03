# Benchmark harness

Cold-start and time-to-render measurement for the `oh-my-pi` fork. This directory
is the producer side of the measurement contract: it emits result documents, and
`labz-apps/omp-leaderboard` renders them. Nothing here computes a delta or
edits a number.

## The one command

```bash
bun scripts/bench/cold-start.ts --runs 20 --json > cold-start-<sha>.json
```

That is the whole publishable path for cold start. The result document goes
straight into the leaderboard, unmodified:

```bash
# in labz-apps/omp-leaderboard, once the pull request has merged
npm run import-result -- --file ~/cold-start-<sha>.json --pr <number> --pr-title "<title>"
npm run verify
```

Quick mode, for deciding whether an idea is worth a full run:

```bash
bun scripts/bench/cold-start.ts --quick
```

`--quick` and `--warm-cache` are recorded in the result file, so an indicative
run can never be silently presented as a publishable one.

## Preconditions

The harness refuses to guess. Each of these was a real failure mode while
bringing it up, and each is stated here rather than discovered again.

| Requirement | Why | Check |
| --- | --- | --- |
| `bun >= 1.4` on `PATH` | `packageManager` is `bun@>=1.4`; every script is `bun ...`. | `bun --version` |
| `bun install` has run | Workspace links under `node_modules/@oh-my-pi/*` must point at *this* checkout. A `node_modules` symlinked from another worktree resolves `@oh-my-pi` to that other checkout's sources and produces a syntactically valid mixture of two revisions. | `bun run ci:test:smoke` |
| `prepare` has run | `bun install` generates `packages/coding-agent/src/export/html/tool-views.generated.js` (gitignored). Without it the CLI exits 1 with `Cannot find module './tool-views.generated.js'`. | file exists |
| Rust natives built | `packages/natives/native/pi_natives.linux-x64-*.node` (gitignored). Without them the subpath export fails to resolve and the app exits 1 during module init — `Cannot find module '@oh-my-pi/pi-natives/path'` — so **neither** series can paint a frame. | `bun --cwd=packages/natives run build` |
| No `hyperfine` needed | Deliberate. See below. | — |

Every row above is **enforced**, not advice: `assertPreconditions()` runs before
the machine lease and before the first sample, and throws with the fix for each
unmet condition. An earlier version documented these and checked none of them, so
a fresh clone burned its whole 120 s per-sample budget and then reported
`no-paint` — which points at the TUI rather than at the missing build.

### No hyperfine

`packages/coding-agent/scripts/bench-guard.ts` shelled out to `hyperfine` and
read `median` (falling back to `mean`). The contract requires p50 **and** p95
for every metric and says a mean is not acceptable, because a change that leaves
the median alone and doubles the tail is a regression a user feels. A
median-only guard is blind to exactly that. The loop here owns the statistics
(`lib/stats.ts`), which also removes an external binary from the set of things
that must be installed and version-matched before a number is publishable.

`bench-guard.ts` is left in place and untouched; it is a separate local guard,
and it predates this contract.

## What is measured, and the frame-vs-chain question

This is the question the contract could not previously answer, so it is answered
here in full, with the measurements that settle it.

**They are different intervals, and only one of them is "first interactive
frame".**

### `firstInteractiveFrameMs` — the publishable cold-start number

Spawn to the first screen that shows a painted input surface (the composer
border), gated on that frame then answering a keystroke. This matches the
contract's definition of `cold-start`.

Measured by spawning under a real pty with `Bun.Terminal`, the same mechanism
`packages/coding-agent/test/fatal-stderr-pty.test.ts` uses. This is not
optional: `main.ts` computes
`autoPrint = (pipedInput !== undefined || !stdinIsTerminal) && !print && mode === undefined`,
so with pipes — which is how `bench-guard.ts` ran under hyperfine — the process
takes the auto-print path and calls `exitWithoutTerminal()` about a hundred lines
before the interactive branch. It exits 2 without painting anything. The old
guard's "boot median" was the wall clock of that early abort.

### `prePaintChainMs` — reported, never labelled a frame

Spawn to a clean exit under `PI_TIMING=x`. In the interactive branch that exit
is at `main.ts`, immediately after `logger.printTimings()` and **before**
`runInteractiveMode()` is called. At that point the TUI component tree is never
mounted, no paint has happened, and `Terminal.#attachInput()` has not run, so
raw mode is never enabled and the tty is never owned. It measures *launch to
pre-paint chain completion*.

It is kept because it is cheap, terminates on its own, and is the sharpest cheap
regression signal. It is a second metric in the same document, never the headline.

### Why the two differ so much, and what that means

Measured back to back on one machine in one session:

| Metric | p50 | What it is |
| --- | --- | --- |
| `firstInteractiveFrameMs` | ~350 ms | What a user waits for. |
| `prePaintChainMs` | ~1540 ms | All startup work before the TUI would mount. |

The gap is not measurement error. It is the **speculative prepaint composer**
(`packages/tui/src/terminal.ts`, the `deferInput` split): the app paints an
early frame and deliberately defers input ownership while the rest of startup
blocks the event loop. So the real interactive path is *faster to first frame*
than the `PI_TIMING` path, because `PI_TIMING` changes what runs:

- `packages/coding-agent/src/cli.ts` gates the prepaint composer on
  `!process.env.PI_TIMING`, so setting `PI_TIMING` **removes the early paint**.
- `PI_TIMING` also adds tree rendering to stderr before the exit.

So `PI_TIMING=x` is not merely a different stopping point — it is a different
program. A `PI_TIMING`-derived number must never be published as a first
interactive frame. That is now structural: the harness runs two separate spawn
series and names them accordingly.

### The proxy terms, stated explicitly

| Term | Measured by | Covered? |
| --- | --- | --- |
| Process launch | parent-side `performance.now()` around `Bun.spawn` | yes |
| First painted frame with an input surface | pty `data` event where the composer border appears | yes |
| Frame responds to input | keystroke written into the pty, then the next **completed paint frame** | yes, per sample |
| Full pre-paint chain | `PI_TIMING=x` clean exit | yes, reported separately |
| Frame *content* correctness | — | **not measured.** A frame is detected by a marker, not by asserting pixels. |

### How a frame boundary is detected, and why "the next byte" is wrong

Every paint is bracketed by the TUI's synchronized-output wrapper,
`\x1b[?2026h` … `\x1b[?2026l` (`packages/tui/src/tui.ts`, `PAINT_BEGIN` /
`PAINT_END`). The harness forces that wrapper on with `PI_TUI_SYNC_OUTPUT=1` and
scans the raw pty stream for the closing half. This is the whole instrument, and
it is deliberately *outside* the process: nothing is added to the startup or
render path, which is what the contract's run-integrity section asks for.

Begin and end are counted as a **pair**, because the TUI also writes an
unconditional `\x1b[?2026l` while tearing the terminal down
(`packages/tui/src/terminal.ts`), outside any frame. Counting that would invent
a frame at exit.

The obvious cheaper implementation — resolve when the pty produces *any* new byte
— is wrong, and it was the implementation in the first version of this harness.
A pty's line discipline echoes the keystroke straight back, so that loop measures
the terminal, not the app. The symptom is unmistakable once you look for it:

| | `inputToPaintMs` p50 | p95 | spread over 5 samples |
| --- | --- | --- | --- |
| next byte (harness `1`) | 2.102 ms | 2.109 ms | **0 ms** |
| completed paint frame (harness `2`) | 33.1 ms | 195.4 ms | 164 ms |

A p50 and p95 that agree to three decimal places with zero spread is not a fast
UI; it is the 2 ms poll interval being reported back. The same bug made the
cold-start input gate vacuous — a frame that ignores input entirely still passed
it — and `inputRoundTripMs` was reporting 2 ms where the honest figure is
seconds, because the prepaint composer deliberately defers input ownership after
painting. Both now use the frame boundary, and a keystroke that produces no frame
within the budget fails the sample (`no-paint-response`) instead of quietly
falling back to the echo path.

Because this changes what a sample *is*, `HARNESS_VERSION` is `2`, and a `2`
result is not comparable with a `1` result.

## Time to render

```bash
bun scripts/bench/time-to-render.ts --runs 200 --json > ttr-<sha>.json
```

Input event to painted frame, sampled inside one live pty session, p50 and p95.
Each sample is one keystroke written into the pty, resolved when the paint frame
that answers it **completes** — see
[How a frame boundary is detected](#how-a-frame-boundary-is-detected-and-why-the-next-byte-is-wrong).
The first five keystrokes are discarded so the measured samples describe
time-to-render rather than the session's own input-attach; the count is recorded
as `discardedSettlingSamples`.

## The whole suite

```bash
bun scripts/bench/run-all.ts --full --json
```

Runs every benchmark in this directory, writes one result document per benchmark
to `--out-dir`, and prints a manifest on stdout. Benchmarks that are not present
yet are skipped and named in the manifest, so the command does not need editing
as the suite grows.

## Series rules

A result is comparable only within one series: **one benchmark, one machine
`id`, one build type.** `machine.id` is derived only from durable hardware and OS
facts (`platform-arch-cpuModel-physicalCores`), never a hostname or boot id, so
a series survives a reboot. Memory is deliberately excluded from the id because
it is reported with small variations across boots and a changed id would split
one series in two.

Build type is pinned per series. The publishable series measures a **source run
under `bun`**, recorded as `harness.build: "source"`. `source`, `bundle`, and
`binary` are three different programs, so a delta between two of them would be
measuring the packaging rather than the change; the value is part of the series
key, not a note. The harness only produces `source`. A compiled-binary series
also cannot carry the module-load profile, because every module is pre-bundled
into `bunfs` and `module-timer`'s `onLoad` never fires.

Two further things are held constant by construction rather than by convention,
and both are cleared from the inherited environment so a surrounding shell
cannot change them: the terminal geometry (`120x30`, `xterm-256color`, `NO_COLOR`)
and `PI_TUI_SYNC_OUTPUT=1`, which fixes the paint bracket the input samples are
timed against. An inherited `PI_NO_SYNC_OUTPUT=1` would otherwise leave the
harness with no frame boundary at all.

### Provenance the schema cannot infer

Three fields exist because a result file otherwise cannot prove what it claims,
and the leaderboard refuses a document that leaves them out.

| Field | Why it exists |
| --- | --- |
| `harness.build` | `source`, `bundle`, or `binary`. Part of the series key. |
| `commit.shaAtFinish` | The head seen when the run *finished*. Must equal `commit.sha`. This checkout is shared and a rebase, branch switch, or `git pull` can move the tree mid-run; `sha` alone records only what was true at the start, so the measurement would be one number wearing whichever of two revisions happened to be on disk. |
| `machine.concurrentRuns` | Same-benchmark runs active on this machine during this run, including this one. `1` means it had the machine to itself. |

`machine.concurrentRuns` is taken from a **lease**, not from load average:
several agents share one machine, and load cannot tell you whether CPU pressure
came from another measurement. The lease is a directory keyed by machine id and
benchmark — `mkdir` is the one atomic primitive available without a daemon — and
a lease whose process is gone past a TTL is reclaimed, so a killed run cannot
wedge the machine as permanently contended.

Above `1`, the run is still written. The contract's answer to a noisy run is
*record it, do not publish it*: it stays in `data/results/` as evidence and is
excluded from the leaderboard, the charts, the deltas, the changelog, and from
serving as the next run's baseline.

### Percentiles

Nearest-rank, no interpolation, fixed in `lib/stats.ts`:

```
rank  = ceil(p / 100 * n)   clamped to [1, n]
value = sorted[rank - 1]
```

It always returns an observed sample, so `p95 got worse` can be checked against
the raw samples by inspection. Changing the estimator is a semantic change to
the harness and must bump `HARNESS_VERSION`.

### Failed samples

A sample that does not produce a measurement is counted, reported with its
reason, and by default fails the run rather than being dropped:

```
2 of 4 samples failed (no-paint x2); refusing to publish a number built from 2.
Pass --max-failures <n> to accept a partial run.
```

A harness that quietly discards the runs that broke is how a tail regression
gets published as an improvement. `--max-failures` exists for local debugging
and marks the run as partial.

## The module-init profile (`--profile`)

`--profile` adds `--preload packages/utils/src/module-timer.ts` to the
`PI_TIMING=x` series and records the resulting profile under `diagnostics`. It
reuses the profiler that already exists; there is deliberately no second one.

**The profiled run's wall clock is not a cold-start number.** `module-timer.ts`
intercepts every TS module, re-reads it synchronously, and regex-scans its
imports, which is why profiled runs are much slower than unprofiled ones. Only
the unprofiled series is published.

Without the preload, `logger.printTimings()` reports
`(before instrumentation): <n>ms [runtime init + module load]`, which on this
machine is roughly **85% of the whole boot** — the phase the tree structurally
cannot see. With the preload, `spliceModuleLoadBuffer()` back-extends the root
window over the static-import phase and the figure collapses to the `(modules)`
summary. Anyone reading a `PI_TIMING` tree without the preload should read that
line first.

### Documented coverage limits of `module-timer.ts`

These come from its own header and are repeated here so a reader does not
mistake the profile for the whole graph:

- **TS/TSX only.** `node_modules` CommonJS `.js`/`.cjs` is left to Bun's
  default path, because intercepting it forces ESM and breaks default-export
  detection.
- **Dev/source runs only.** In the compiled binary every module is pre-bundled
  into `bunfs`, so `onLoad` never fires.
- **A preload is required.** Bun reads the entire statically reachable graph
  before evaluating any module, so hooks installed from inside that graph cannot
  observe its own loading.
- **A module that throws before its final statement records no end marker**, so
  it is missing from the profile entirely rather than reported as fast.
- **Child edges are a text scan** of `import`/`export ... from` and
  `import(...)`, resolved with `Bun.resolveSync`. It is an observer only and can
  miss edges Bun itself resolves.
- `PI_TIMING=full` is needed to list every module-load entry; the default shows
  the top N.

## Files

| File | Role |
| --- | --- |
| `cold-start.ts` | The publishable cold-start entry point. |
| `time-to-render.ts` | Input-to-paint entry point. |
| `run-all.ts` | The suite entry point. |
| `lib/pty.ts` | Real-pty sample runner; paint-frame tracker; timing-tree parser. |
| `lib/stats.ts` | Percentiles and the estimator's rationale. |
| `lib/provenance.ts` | Machine, versions, commit, run id. |
| `lib/result.ts` | Result document assembly and pre-import checks. |
| `lib/preflight.ts` | Enforces the preconditions above before any sample is taken. |
| `lib/cli.ts` | Shared flags and the sample loop. |
| `lib/lease.ts` | Machine lease: how many runs of this benchmark shared the machine. |