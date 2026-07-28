# Workflow And API Benchmark

Use the existing isolated harness:

```bash
node cli/node_modules/tsx/dist/cli.mjs \
  scripts/perf/run-isolated-workflow.ts \
  --scale smoke \
  --warmups 2 \
  --iterations 5
```

Select the smallest scale that answers the question, then escalate. Use a fixed
`--anchor` for comparable time-window data. Add `--explain` only when query
plans are part of the hypothesis. Avoid `--keep-data` unless inspection after
the run is necessary; record and clean exact retained roots.

The harness creates isolated PostgreSQL, applies migrations, seeds deterministic
organizations and neighboring-organization sentinels, runs service workflows,
and cleans the instance.

## What To Measure

- Messenger list/search/paging latency and bytes.
- Chat/message retrieval, search, and transcript inclusion cost.
- Issue list/search, comments, linked runs, and ordering.
- Run summary versus full projection, event/log bytes, and parser cost.
- Dashboard/activity/cost summary queries where relevant.
- Process RSS/heap deltas with the exact collection method.
- Query plans only after the service boundary identifies a database hotspot.

## Admission-Control Risks

A row limit does not bound a list if individual rows contain large JSON,
transcripts, logs, or adapter evidence. For list, polling, and prefetch paths:

- prefer summary projection;
- apply row and aggregate byte budgets;
- keep full detail on single-resource demand;
- stop polling terminal/invisible resources;
- prevent multiple consumers from duplicating the same detail source.

## Resource Failure

If embedded PostgreSQL cannot initialize because of process/shared-memory
exhaustion:

1. classify it as environment blockage, not a product regression;
2. identify only orphaned disposable Rudder/E2E producers;
3. do not kill all PostgreSQL processes or delete instance data;
4. recover exact authorized disposable targets through workspace/instance
   hygiene;
5. rerun the same benchmark after the environment is stable.
