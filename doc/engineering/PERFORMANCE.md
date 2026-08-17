# Performance And Production-Shaped Data

Use this guide for data-heavy UI/API work and repeatable performance changes.
Rudder is an operational tool; pages must remain usable with many issues, runs,
comments, agents, resources, conversations, and activity entries.

## Data-Surface Rules

- Do not load an unbounded organization-wide dataset into the browser.
- List, timeline, search, activity, run, transcript, chat, and resource
  endpoints should expose explicit limits, stable ordering, and pagination
  unless the result is provably bounded.
- Server-side filters own large-dataset narrowing. Client filtering is for the
  loaded page, small fixed option sets, or local presentation concerns.
- Polling and refresh should preserve pagination, scroll position, filters, and
  selection unless the user changes scope.
- Prefer incremental loading, virtualization, or split detail queries over
  hidden bulk payloads.
- Distinguish not-yet-loaded, partially loaded, loaded-empty, and error states.
- Scope query keys and invalidation to the actor, organization, filters,
  cursor, date window, and selected entity that define the visible data.
- Define whether counts and charts represent the current page, filtered server
  result, or complete organization dataset.

## Evidence

Any workflow whose correctness depends on volume, scroll continuation, date
windows, filters, async refresh, or aggregation needs production-shaped E2E
coverage. A performance claim must record:

- workload and fixture shape;
- baseline measurement;
- post-change measurement;
- relevant viewport/runtime identity;
- preserved user state during refresh or incremental loading.

Reuse the dev-only `Rudder Performance Lab` organization
(`rudder-performance-lab`) for repeatable non-destructive UI/API checks when its
schema is current. Keep automation disabled, omit credentials and host
configuration, and use a separate synthetic organization for destructive or
mutation-heavy pressure.

Review should challenge any surface that fetches everything, loses the user's
place during refresh, reports a page-local count as global, or proves only a
small fixture when the real workflow is scale-sensitive.

Use [`DESIGN.md`](./DESIGN.md) for visual and interaction requirements,
[`DATABASE.md`](./DATABASE.md) for database behavior, and `AGENTS.md` for the
verification class and hand-off gates.
