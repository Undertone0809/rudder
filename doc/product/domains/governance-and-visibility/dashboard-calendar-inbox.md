---
title: Dashboard Calendar And Inbox
domain: governance-and-visibility
status: active
coverage: detailed
contract_ids:
  - DASHBOARD.SUMMARY.001
  - CALENDAR.SOURCE.001
  - INBOX.ATTENTION.001
related_code:
  - server/src/routes/dashboard.ts
  - server/src/services/dashboard.ts
  - server/src/routes/calendar.ts
  - server/src/services/calendar.ts
  - server/src/routes/sidebar-badges.ts
  - ui/src/pages/Dashboard.tsx
  - ui/src/pages/Calendar.tsx
  - ui/src/pages/Inbox.tsx
related_tests:
  - tests/e2e/dashboard-date-filter.spec.ts
  - tests/e2e/calendar-v1.spec.ts
  - server/src/__tests__/calendar-routes.test.ts
  - server/src/__tests__/sidebar-badges-service.test.ts
edit_policy: user_confirmed_only
---

# Dashboard Calendar And Inbox

## DASHBOARD.SUMMARY.001

Why:

- Dashboard is the "is the organization alive?" surface. It should summarize
  live work-loop health without becoming the owner of the underlying facts.

Product model:

- Dashboard derives active/running/paused/error agent counts, issue counts,
  month-to-date spend, budget utilization, pending approvals, recent runs, and
  other health cards from owning domain records.
- Date filters change aggregation windows, not source truth.
- Skill analytics and run previews cite run/skill contracts.

Flow:

1. UI requests dashboard payload for an organization and optional date window.
2. Dashboard service aggregates from agents, issues, approvals, costs, runs,
   skills, and activity.
3. UI presents glanceable cards and links back to owning surfaces.

Invariants:

- Dashboard counts must be derived from live organization-scoped data.
- Dashboard must not redefine issue, cost, approval, or run state.

Evidence:

- `server/src/services/dashboard.ts` and `server/src/routes/dashboard.ts` own
  aggregation.
- `tests/e2e/dashboard-date-filter.spec.ts` verifies date-window behavior on
  the visible dashboard surface.
- Known gap: dashboard cards are only as strong as the source-domain contracts
  and tests they aggregate.

## CALENDAR.SOURCE.001

Why:

- Calendar turns scheduled and dated work into an operator planning surface. It
  is useful only if events remain traceable to their source automation, issue,
  run, or external calendar source.

Product model:

- Calendar events belong to one organization and may derive from automation
  schedules, issue dates, run windows, or configured calendar sources.
- Event detail can link to source automation/run/issue where available.

Flow:

1. Calendar service collects events from source records for a time range.
2. UI displays events by day/week/month.
3. Event detail links back to the owning work object.
4. A writable manual event can be deleted only after an explicit confirmation
   names the event and states that deletion cannot be undone.

Invariants:

- Calendar event display must not become a second state machine for
  automations/issues.
- Source identity must be preserved for navigable events.
- Cancel, close, or Escape from event deletion must preserve the event and send
  no delete request. A confirmed deletion sends one request and exposes success
  or failure feedback while preventing duplicate submission.

Evidence:

- `server/src/__tests__/calendar-routes.test.ts` covers route-level event
  behavior.
- `tests/e2e/calendar-v1.spec.ts` covers visible calendar behavior.
- Known gap: third-party calendar source behavior should get provider-specific
  contracts if external sync becomes first-class.

## INBOX.ATTENTION.001

Why:

- Human Inbox is the operator-facing attention surface. It differs from
  `AGENT.INBOX.001`, which is runtime-facing work selection.

Product model:

- Inbox may aggregate approvals, issue review/user assignment attention,
  failed/stuck runs, unread Messenger threads, budget incidents, and other
  operator decisions.
- Sidebar badges are user-scoped summaries of those attention sources.

Flow:

1. Owning domains emit states that require operator attention.
2. Inbox/sidebar services aggregate user-scoped attention.
3. UI opens the source thread/entity and clears read markers when appropriate.

Invariants:

- Human Inbox must route to source objects instead of hiding action inside a
  generic notification.
- User-scoped unread/attention state must not leak across organizations.

Evidence:

- `server/src/__tests__/sidebar-badges-service.test.ts` covers attention badge
  counting and user/org scoping.
- `tests/e2e/messenger-contract.spec.ts` covers many visible thread/read-state
  flows that feed human attention.
- Known gap: if Inbox becomes a richer standalone workflow, it should gain its
  own E2E spec beyond Messenger/sidebar coverage.
