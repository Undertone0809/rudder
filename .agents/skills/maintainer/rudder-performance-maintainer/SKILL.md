---
name: rudder-performance-maintainer
description: "Use for repeatable Rudder performance audits, regressions, profiling, optimization proposals, or implementation verification across Messenger, Chat, Issues, Runs, Desktop, API payloads, database queries, rendering, memory, and high-volume workflows. Trigger for daily performance checks, product latency or memory growth, prod-shaped scale tests, before/after benchmarks, virtualization or polling investigations, and requests to prove an optimization. Do not use for dev-startup recovery, one failed agent run, transcript/debug evidence, or release-pipeline duration unless measurement shows a product performance regression."
---

# Rudder Performance Maintainer

Measure the real bottleneck under a controlled workload, preserve correctness,
and separate evidence from intuition.

## Decide The Mode

Classify the request before running expensive work:

- `AUDIT`: measure current health, identify the highest-leverage risk, and
  propose the smallest safe next step. This is the default for daily checks.
- `DIAGNOSE`: reproduce a named slowdown and isolate client, server, database,
  payload, runtime, or environment cost.
- `IMPLEMENT`: change code only when the user asked to optimize/fix/implement.
- `VERIFY`: run comparable before/after evidence for an existing change.

Do not let a scheduled audit silently turn into a multi-hour implementation.
When the user continues the same task with an implementation request, preserve
the audit evidence and switch modes explicitly.

Route environment startup/hang recovery to
`rudder-desktop-dev-recovery-maintainer`, a single failed run or missing
transcript to `debug-run-transcript-maintainer`, and release workflow delay to
`release-maintainer`. Return here only when bounded measurement identifies a
product latency, throughput, rendering, payload, or memory scaling problem.

## Read The Relevant References

- Always read `references/evidence-model.md`.
- Read `references/workflow-benchmark.md` for API/database/high-volume workflow
  baselines and `scripts/perf/run-isolated-workflow.ts`.
- Read `references/ui-scroll-benchmark.md` for Chat/Messenger/Issue/Run
  rendering, virtualization, streaming, and
  `scripts/perf/compare-scroll-evals.mjs`.
- Read `references/environment-and-safety.md` before using installed Desktop,
  prod-local data, large logs, or cleanup/recovery actions.

Do not load UI guidance for a database-only regression or release guidance for
a local benchmark.

## First-Principles Performance Model

Performance is the work performed per user-visible outcome:

```text
user action
  -> requests and payloads
  -> server/query/runtime work
  -> client state propagation
  -> render/layout/paint
  -> observable latency, responsiveness, memory, and correctness
```

Measure the boundary where cost first grows with data volume or update
frequency. A low-latency API does not prove a responsive UI; low RSS does not
prove smooth frames; a fast initial view does not prove bounded background
polling.

## Required Gates

1. **Source identity** — record repository SHA, build identity, runtime
   descriptor, instance, version, and UI bundle where available. Treat a stale
   installed build as historical shape evidence, not current-source proof.
2. **Comparable workload** — use the same seed manifest, scale, anchor,
   viewport, browser/build mode, warmups, iterations, and interaction.
3. **Correctness sentinels** — preserve organization boundaries, ordering,
   pagination, deep navigation, realtime completion, final persisted content,
   and error states while measuring.
4. **Bounded evidence** — record request count/bytes, query/service timing,
   mounted nodes, frame intervals, long tasks, renderer task time, and the
   memory metric actually observed.
5. **Mutation ledger** — list disposable records, runtime/process changes,
   writes, cleanup, and any intentionally retained evidence.

If these gates cannot be met, return a qualified finding rather than a false
comparison.

## Standard Workflow

1. Rewrite the concern as a falsifiable hypothesis.
2. Establish runtime/source identity and select an evidence target:
   current-source isolated, packaged candidate, installed prod-local, or named
   external environment.
3. For production-shaped dev checks, reuse the persistent `Rudder Performance
   Lab` organization described in `references/environment-and-safety.md` when
   it is compatible with the current schema. Do not create another large seed
   by default.
4. Start with bounded metadata and summary endpoints. Do not fetch maximum
   transcripts or full projections until the hypothesis requires them.
5. Run the smallest representative workload, then a production-shaped edge
   case where scaling risk appears.
6. Capture correctness and performance from the same run.
7. Identify the first scaling boundary and propose one smallest safe change.
8. In IMPLEMENT mode, use an isolated branch/worktree when the current checkout
   contains unrelated changes.
9. Run before/after on the same harness and source identities.
10. Require independent review and black-box acceptance for implementation.
11. Report measured improvements, unchanged metrics, regressions, skipped
    evidence, proxy limitations, and remaining risk.

## Evidence Language

- Say `JavaScript heap`, `renderer task time`, `response bytes`, or `process
  RSS` exactly; do not rename one metric as another.
- Separate current-source proof from stale installed/prod observations.
- Separate service/query microbenchmarks from browser/Desktop terminal proof.
- Treat p95 from a tiny sample as directional and report sample count.
- Tool volume or memory growth is a lead, not a root cause.
- A performance improvement that loses messages, events, anchors, realtime
  state, organization isolation, or accessibility is a failed optimization.

## Output

```text
RESULT: GREEN | YELLOW | RED | BLOCKED
Mode:
Source/runtime identity:
Workload:
Current measurements:
Correctness gates:
Primary bottleneck:
Smallest safe action:
Before/after:
Mutation and cleanup ledger:
Evidence limits:
```

Use `GREEN` only when the requested current source/target and representative
edge case pass. Use `YELLOW` for a proven non-incident risk worth scheduling,
`RED` for a reproduced material regression or unsafe scaling boundary, and
`BLOCKED` when the required environment or comparable evidence is unavailable.
