---
title: Performance control-plane optimization
date: 2026-05-25
kind: implementation
status: in_progress
area: api
entities:
  - control_plane_performance
  - sidebar_badges
  - messenger_chat
  - issue_search
  - cost_events
issue:
related_plans:
  - 2026-05-10-messenger-pinned-thread-summary.md
  - 2026-05-07-org-cost-trend-chart.md
  - 2026-05-09-agent-issue-search-capability.md
supersedes: []
related_code:
  - server/src/routes/sidebar-badges.ts
  - server/src/services/sidebar-badges.ts
  - server/src/services/messenger.ts
  - server/src/services/issues.ts
  - server/src/services/costs.ts
  - ui/src/pages/Issues.tsx
  - ui/src/pages/Costs.tsx
  - ui/src/components/transcript/useLiveRunTranscripts.ts
commit_refs: []
updated_at: 2026-05-25
---

# Performance Control-Plane Optimization

## Summary

Optimize Rudder's high-traffic control-plane paths without changing the current
operator experience or breaking existing API contracts. The first delivery slice
focuses on measurement scaffolding and the narrowest safe backend change:
making sidebar badge counts use aggregate queries instead of hydrating full
issue and chat objects.

The guiding rule is compatibility first: global summaries and attention counts
must remain exact across the full organization, while large detail surfaces can
later become opt-in paginated or lazily loaded.

## Problem

Rudder's current control-plane paths often compute small summaries by loading
large object sets:

- `/orgs/:orgId/sidebar-badges` calls dashboard summary, full unread issue list,
  full active chat list, and badge aggregation twice.
- `/orgs/:orgId/messenger/threads` computes summary state through heavier
  issue/comment/activity paths.
- `issueService.list` returns full `Issue[]` and is shared by many UI, API, and
  plugin consumers, so direct default pagination would be a breaking change.
- `costService.createEvent` recomputes monthly spend totals on each cost event.
- active run transcript rendering polls persisted logs while also using live
  events.

These are likely to become visible as organizations accumulate thousands of
issues, comments, heartbeat runs, chats, and cost events.

## Scope

In scope for the first implementation phase:

- Add a plan-backed measurement baseline target for high-traffic endpoints.
- Rewrite sidebar badge computation to use count-only helpers while preserving
  current route shape and semantics.
- Add focused route/service coverage for sidebar counts, permission boundaries,
  and organization scoping.

Out of scope for the first implementation phase:

- Changing `issuesApi.list()` or `/orgs/:orgId/issues` default behavior.
- Changing Messenger response contracts.
- Adding cost rollup schema or migrations.
- Adding speculative indexes before seeded `EXPLAIN` evidence.
- Route-level frontend code splitting before bundle sizing is measured.

## Operator Workflows

The optimization should preserve these workflows:

1. A first-time operator opens Dashboard, Messenger, and Issues and sees usable
   organization state quickly.
2. A daily operator checks who is working, what is blocked, what needs review,
   and whether cost or failed-run alerts need intervention.
3. A growing organization accumulates many runs, comments, and activity rows,
   but sidebar and Messenger attention surfaces still remain responsive.
4. Issue execution and review keep existing deep links, parent/child behavior,
   assignee/reviewer attention, Calendar usage, and Chat mention behavior.
5. Budget hard-stop enforcement remains strongly consistent when cost rollups
   are introduced in a later phase.

## Implementation Plan

1. Baseline the current code shape with static evidence and focused tests.
2. Add count-only service helpers for:
   - unread touched issue count for a board user
   - active chat attention count for a board user
   - latest failed-run count by active agent
3. Refactor `/orgs/:orgId/sidebar-badges` to use the count helpers and avoid
   duplicate badge aggregation.
4. Keep the existing `SidebarBadges` response unchanged.
5. Add focused regression tests that compare the count-only behavior against
   the intended semantics for permissions, org scoping, unread touched issues,
   chat attention, failed runs, and budget alerts.
6. After this first slice, use measured evidence to decide whether Messenger
   summary split or opt-in issues pagination should be the next commit.

## Design Notes

- Existing full-list contracts remain compatible. Any future issue pagination
  must be opt-in through a new `listPage` style contract until consumers are
  migrated one by one.
- Sidebar badge counts are global organization summaries. They must not be
  approximated or limited to the first page of a detail list.
- Cost rollups, when implemented later, must make hard-stop budget decisions
  from transactional totals. Backfill or reconcile jobs can repair drift but
  must not be the authority for enforcement.
- Large seeded performance fixtures should run through explicit perf scripts or
  jobs, not the default fast unit or E2E path.

## Success Criteria

The first implementation phase is done when:

- `/orgs/:orgId/sidebar-badges` no longer uses full issue/chat hydration for
  counts.
- The route response remains `SidebarBadges` with the same user-visible meaning.
- Organization boundaries and actor permissions are preserved.
- Focused tests cover the new aggregate semantics.
- No existing visible behavior changes are introduced.

## Validation

Required before handoff:

- Focused server tests for sidebar badge route/service behavior.
- Targeted typecheck for impacted packages.
- Broader checks where practical:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

If broad checks are blocked by missing local dependencies or embedded database
setup, record the blocker and the focused evidence that did run.

Phase 1 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/sidebar-badges-routes.test.ts --reporter=verbose`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/sidebar-badges-service.test.ts --reporter=verbose`
  with `RUDDER_SIDEBAR_BADGES_TEST_DATABASE_URL` pointed at a temporary isolated
  database on the already-running local Rudder Postgres instance.
- Default embedded-Postgres test startup was not usable on this machine because
  `initdb` failed with shared-memory exhaustion. The same failure reproduced in
  an existing embedded-Postgres service test, so this was treated as local
  environment evidence rather than a sidebar badge regression.

## Phase 1 Result

The first slice rewired `/orgs/:orgId/sidebar-badges` away from full issue and
chat hydration. It now uses count-only helpers for unread touched issues, active
chat attention, base approval counts, and latest failed-run counts while
preserving the existing `SidebarBadges` response shape.

Reviewer-requested hardening added:

- route-level coverage for board/agent actor behavior, join-request permission
  handling, alert aggregation, and response shape
- service-level SQL coverage for org scoping, active-only chat attention,
  cross-org approval references, first-read state creation, unread issue
  semantics, automation issue exclusion, and latest failed-run semantics
- an explicit `approvals.orgId = orgId` predicate for pending proposal attention

## Phase 2 Result

The second slice tightened the same compatibility boundary by removing the
remaining row hydration inside sidebar badge internals:

- latest failed-run badges now count in SQL with `row_number()` over each active
  agent instead of selecting one latest run row per agent and filtering in
  JavaScript
- chat first-read state creation now uses a single `insert ... select ... on
  conflict do nothing` statement instead of selecting every active conversation
  into application memory before inserting user states

Phase 2 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/sidebar-badges-routes.test.ts --reporter=verbose`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/sidebar-badges-service.test.ts --reporter=verbose`
  with `RUDDER_SIDEBAR_BADGES_TEST_DATABASE_URL` pointed at a temporary isolated
  database on the already-running local Rudder Postgres instance

## Phase 3 Result

The third slice started the Messenger summary split without changing the
`/messenger/threads` response shape. It consolidated synthetic thread read-state
loading so the thread summary endpoint loads read states for `issues`,
`approvals`, `failed-runs`, `budget-alerts`, and `join-requests` in one query
instead of repeating the same `messenger_thread_user_states` lookup inside each
summary builder. Detail endpoints keep their single-thread paths.

Phase 3 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance

## Phase 4 Result

The fourth slice reduced cost-event write amplification without changing budget
or cost API behavior. `costService.createEvent` now recomputes the current UTC
month agent spend and organization spend with one conditional aggregate over
`cost_events` instead of two separate month-window aggregate scans.

The compatibility boundary is unchanged:

- the inserted `cost_events` row is still the source of truth
- `agents.spentMonthlyCents` and `organizations.spentMonthlyCents` are still
  refreshed before budget evaluation
- budget hard-stop evaluation still receives the same inserted event
- no schema, migration, rollup, or response contract changed

Phase 4 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/costs-langfuse.test.ts src/__tests__/monthly-spend-service.test.ts --reporter=verbose`

## Phase 5 Result

The fifth slice continued the Messenger summary split. `/messenger/threads` now
uses summary-only loaders for the `failed-runs` and `join-requests` synthetic
threads instead of constructing their full detail item lists just to decide
whether a summary row should be shown.

The detail endpoints remain unchanged:

- `/messenger/system/failed-runs` still uses the full failed-run detail loader
  with agent names, item cards, chronological ordering, and retry/open actions.
- `/messenger/system/join-requests` still uses the full join-request detail
  loader with action cards and request metadata.

The summary-only loaders preserve the existing list semantics by computing
item count, latest activity, unread count, and latest preview directly from the
same scoped rows.

Phase 5 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance

## Phase 6 Result

The sixth slice added the indexes needed by the new Messenger system-thread
summary loaders:

- `heartbeat_runs_company_status_updated_idx` on
  `(org_id, status, updated_at)`
- `join_requests_company_status_updated_idx` on
  `(org_id, status, updated_at)`

These indexes match the `/messenger/threads` summary-only filters for failed
runs and pending join requests, including latest-activity ordering and
read-state unread counts. This keeps Phase 5 from merely shifting work from
application hydration into less-indexed database scans.

Phase 6 evidence:

- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/postgres pnpm db:generate`
- `pnpm --filter @rudderhq/db typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance

## Phase 7 Result

The seventh slice moved the `approvals` synthetic thread in
`/messenger/threads` to a summary-only loader. The thread list no longer
loads every approval and every approval comment to produce the single
approvals summary row.

The detail endpoint remains unchanged:

- `/messenger/approvals` still uses the full approval detail loader with
  chronological cards, comment-backed previews, action links, and redacted
  approval payloads.

The summary-only loader preserves the existing summary semantics by computing
the approval count and pending unread count directly, then comparing the latest
approval update with the latest approval comment so comment-backed previews can
still pin the summary.

Phase 7 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance

## Open Issues

- Default embedded-Postgres service tests may fail on this machine until local
  shared-memory pressure is cleared; focused SQL validation used an isolated
  database on an already-running local Rudder Postgres instance instead.
- Runtime latency targets still need a seeded fixture and timing harness before
  claiming quantified performance wins.
- The next behavioral-compatible candidates are deeper Messenger summary-only
  loaders, opt-in issue list pagination, and transactional cost rollups.
