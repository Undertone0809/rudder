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

## Phase 8 Result

The eighth slice added the indexes needed by the approvals summary-only loader:

- `approvals_company_updated_idx` on `(org_id, updated_at)` for latest approval
  summary candidates and organization-scoped approval counts.
- `approvals_company_status_updated_idx` on `(org_id, status, updated_at)` for
  pending approval unread counts.
- `approval_comments_company_created_idx` on `(org_id, created_at)` for latest
  approval-comment summary candidates.

These indexes keep Phase 7 from trading full row hydration for unindexed latest
or unread scans on growing approval/comment histories. The existing detail
endpoint and response contracts are unchanged.

Phase 8 evidence:

- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/postgres pnpm db:generate`
- `pnpm --filter @rudderhq/db typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance

## Phase 9 Result

The ninth slice added a repeatable seeded timing harness for the optimized
control-plane paths. `pnpm perf:control-plane` now runs
`scripts/perf/control-plane-baseline.ts` against an explicit `DATABASE_URL`,
seeds a synthetic organization, times the hot service paths, emits JSON timing
summaries, and removes its seeded rows by default.

The harness covers:

- sidebar base counts
- unread touched issue count
- active chat attention count
- Messenger thread summaries
- cost event ingestion and monthly spend recomputation

It supports `--scale smoke|medium`, `--iterations <n>`, `--no-migrate`, and
`--keep-data` for later `EXPLAIN` work on the generated org.

Phase 9 evidence:

- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/<temp-db> pnpm perf:control-plane -- --scale smoke --iterations 2`
- `pnpm --filter @rudderhq/server typecheck`

## Phase 10 Result

The tenth slice extended the timing harness with `--explain`. When enabled, the
same seeded org now emits `EXPLAIN (ANALYZE, BUFFERS)` plans for representative
queries behind the optimized paths:

- actionable approval badge count
- latest failed-run badge count
- failed-run, join-request, approval, and approval-comment Messenger summary
  candidates
- active chat attention count
- cost-event monthly spend recomputation

This turns the previous timing-only harness into a reusable evidence packet for
checking whether the newly added indexes are actually selected on seeded data.

Phase 10 evidence:

- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/<temp-db> pnpm perf:control-plane -- --scale smoke --iterations 1 --explain`
- `pnpm --filter @rudderhq/server typecheck`
- `git diff --check`

## Phase 11 Result

The eleventh slice used the medium `--explain` harness to tune one remaining
Messenger approvals summary hot path without changing the response contract.
The seeded medium run showed `messenger.approvalCommentsLatest` using a nested
loop that repeatedly scanned organization approval comments while looking for
the newest approval-backed comment.

The fix keeps the same semantics but changes the query shape and index support:

- `/messenger/threads` still computes the approvals synthetic summary from the
  newest approval update and newest approval comment candidate.
- The newest approval comment candidate now uses a lateral per-approval latest
  comment query, preserving both `approvals.org_id` and
  `approval_comments.org_id` checks.
- A new `approval_comments_company_approval_created_idx` index on
  `(org_id, approval_id, created_at)` makes the lateral lookup use an indexed
  backward scan per approval instead of repeatedly scanning all org comments.

On the seeded medium harness, the representative
`messenger.approvalCommentsLatest` plan moved from the earlier nested-loop
shape that read roughly 3,936 buffers and took about 12 ms to an indexed
lateral plan reading roughly 939 buffers and taking about 0.27 ms. This is
medium fixture evidence, not a production latency claim.

Phase 11 evidence:

- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/postgres pnpm db:generate`
- `pnpm --filter @rudderhq/db typecheck`
- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance
  including multi-comment approval summary coverage
- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/<temp-db> pnpm perf:control-plane -- --scale medium --iterations 1 --explain`

## Phase 12 Result

The twelfth slice tightened another seeded medium hotspot without changing
sidebar badge semantics. The medium harness showed
`sidebar.countUnreadTouchedIssues` taking roughly 94 ms before this slice.

The previous count-only helper still used the shared issue-list predicates,
which expand into repeated per-issue comment/read-state subqueries. This slice
keeps the same user-visible definition but computes it with one SQL aggregation
pass:

- aggregate per-issue user comment, external comment, and read-state timestamps
- join those aggregates to eligible inbox issues
- keep the same touched-by-user sources: creator, assignee, reviewer, read
  state, or authored comment
- keep the same unread rule: latest external comment must be newer than the
  user's latest touch
- keep automation execution and hidden issues excluded

The perf harness now includes `sidebar.unreadTouchedIssues` in the `--explain`
packet and runs `ANALYZE` before EXPLAIN so fresh seeded databases have usable
planner statistics. On the seeded medium harness after this change,
`sidebar.countUnreadTouchedIssues` timed at roughly 20 ms, and the representative
`sidebar.unreadTouchedIssues` plan executed in roughly 1.5 ms. This remains
medium fixture evidence, not a production latency claim.

Phase 12 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/sidebar-badges-service.test.ts --reporter=verbose`
  with `RUDDER_SIDEBAR_BADGES_TEST_DATABASE_URL` pointed at a temporary isolated
  database on the already-running local Rudder Postgres instance, including
  read-after-external-comment, self-reply-after-external-comment, creator,
  reviewer, read-state-only, comment-only, and hidden-issue coverage
- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/<temp-db> pnpm perf:control-plane -- --scale medium --iterations 1 --explain`

## Phase 13 Result

The thirteenth slice continued the Messenger summary split for the `issues`
synthetic thread. `/messenger/threads` no longer builds full issue detail cards
for the Issues synthetic summary row.

The detail endpoint remains unchanged:

- `/messenger/issues` still loads the full issue thread with chronological
  cards, source comment metadata, status-change metadata, and issue actions.

The summary path now calls a summary-only loader that preserves the same
tracked-issue universe, unread count, latest attention timestamp, and preview
semantics, but skips work that only the detail view needs:

- no `MessengerIssueThreadItem` cards are built for the thread list
- no chronological item sort is performed for the thread list
- summary comment loading only reads external comments and avoids author-name
  joins that are only needed by detail cards

On the seeded medium harness after this change,
`messenger.listThreadSummaries` ran twice with a minimum around 44 ms and an
average around 55 ms. The previous medium run in Phase 12 was around 68 ms.
This remains fixture evidence and should not be read as a production latency
claim.

Phase 13 evidence:

- `pnpm --filter @rudderhq/server typecheck`
- `pnpm --filter @rudderhq/server exec vitest run src/__tests__/messenger-service.test.ts --reporter=verbose`
  with `RUDDER_MESSENGER_SERVICE_TEST_DATABASE_URL` pointed at a temporary
  isolated database on the already-running local Rudder Postgres instance
- `DATABASE_URL=postgres://rudder:rudder@127.0.0.1:54339/<temp-db> pnpm perf:control-plane -- --scale medium --iterations 2 --explain`

## Open Issues

- Default embedded-Postgres service tests may fail on this machine until local
  shared-memory pressure is cleared; focused SQL validation used an isolated
  database on an already-running local Rudder Postgres instance instead.
- Runtime latency targets still need production-shaped evidence from real or
  larger production-like organizations before claiming end-user performance
  wins.
- The next behavioral-compatible candidates are deeper Messenger summary-only
  loaders, opt-in issue list pagination, and transactional cost rollups.
