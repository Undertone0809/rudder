# UI And Scroll Benchmark

Use production/static or packaged UI for final numbers; Vite dev is useful for
diagnosis but includes development overhead.

The canonical pressure shape from the activity-coordinator work includes:

- 2,001 Chat messages;
- 221 Messenger threads;
- 500 Issue comments;
- 250 terminal Runs;
- 2 active Runs.

Use the current test fixture when it exists; preserve its manifest and build
identity. Do not invent a visually similar but behaviorally different seed.

## Required Metrics

- mounted Chat messages / Messenger rows / Run rows;
- total DOM nodes and event listeners;
- ready time;
- frame-interval p50/p95 and dropped-frame ratio;
- long-task count;
- renderer task duration;
- JavaScript heap when available;
- request/WebSocket/log-poll counts;
- console/page/server errors.

Compare raw results with:

```bash
node scripts/perf/compare-scroll-evals.mjs \
  /tmp/before.json \
  /tmp/after.json \
  /tmp/scroll-performance-eval.md
```

The comparison script expects raw browser result JSON. Its thresholds are
regression gates, not universal product SLAs.

## Update Boundaries

For realtime and long-list work, verify:

- only the active entity receives high-frequency detail updates;
- summary subscribers update only when summary fields change;
- data may be cached broadly while mounted DOM stays viewport-bounded;
- variable-height virtualization preserves anchors and dynamic content;
- one organization-level connection/source is reused where designed;
- invisible terminal Runs do not fetch logs;
- current active Run reconciles disconnect gaps and stops after stable terminal
  evidence;
- stream batching never drops final content.

## Before/After Discipline

Use the same browser, viewport, route, interaction, seed, source class, warmup,
and trace settings. Capture screenshots for visible correctness, but do not use
a screenshot as frame or memory evidence.
