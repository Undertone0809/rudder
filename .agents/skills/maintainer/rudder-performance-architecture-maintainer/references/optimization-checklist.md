# Optimization Checklist

Use this checklist for Rudder architecture and performance work. It is a memory
aid, not a substitute for tracing the actual code path.

## Frontend Query And Cache

- Query keys must include organization id and every semantic filter.
- Query keys must not include moving `now` values unless the product expects a
  new cache bucket on every render.
- Date ranges should be canonicalized to a stable bucket that matches the UI
  freshness contract.
- Sort arrays, tag lists, and filter objects before using them as cache inputs.
- Prefer shared hooks for repeated cross-page data contracts.
- Use `placeholderData` or keep-previous-data behavior when stale visual
  continuity is better than a skeleton and the stale state is safe.
- Keep errors visible even when placeholder data is shown.
- Review invalidation fan-out after mutations and live events; invalidate the
  narrowest key that preserves correctness.

## Network And API

- Look for request waterfalls caused by component nesting or conditional
  fetching.
- Batch or prefetch only after confirming the data is needed together.
- Push filtering, pagination, and aggregation to the layer that owns the data
  contract.
- Avoid adding one endpoint per card when the page has one coherent data
  contract; avoid one giant endpoint when cards have independent freshness and
  failure behavior.
- Keep response shapes stable unless the task explicitly includes a contract
  migration.

## Server, Database, Runtime

- Start from route validators, org scoping, and service aggregation boundaries.
- Search for broad scans followed by in-memory filtering.
- Check date/status/org filters before adding indexes.
- Use `EXPLAIN` or representative fixtures when changing a query for
  performance.
- Avoid N+1 loops across runs, issues, agents, tasks, activity, files, or
  external process metadata.
- Do not cache external-process or runtime state without a clear invalidation
  source.

## Architecture

- Make ownership of freshness explicit: UI cache, API aggregation, service
  memoization, DB materialization, or runtime state.
- Extract a facade when many consumers duplicate the same data-path assumptions.
- Split large files along responsibility boundaries only when consumers can
  depend on stable entrypoints after the split.
- Do not leak internal DB rows, Express request objects, filesystem paths, or
  process handles as stable cross-module contracts.
- Prefer compatibility shims during migrations, then remove them only after
  call sites are rewired and tested.

## Validation

- Add a regression test for the exact failure mode.
- Include an edge case for org scoping, date boundaries, permissions, async
  runtime state, or large data when relevant.
- Run the smallest failing/relevant test first, then the required repo baseline.
- For UI performance changes, use a browser or screenshot when the user-visible
  loading behavior changed.
- Record unresolved bottlenecks as follow-ups instead of expanding scope
  silently.
