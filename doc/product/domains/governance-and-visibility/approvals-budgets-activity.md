---
title: Approvals Budgets And Activity
domain: governance-and-visibility
status: active
coverage: detailed
contract_ids:
  - APPROVAL.GOVERNED.ACTIONS.001
  - BUDGET.ENFORCEMENT.001
  - ACTIVITY.AUDIT.001
related_code:
  - packages/db/src/schema/approvals.ts
  - packages/db/src/schema/approval_comments.ts
  - packages/db/src/schema/issue_approvals.ts
  - packages/db/src/schema/cost_events.ts
  - server/src/services/issue-approvals.ts
  - server/src/services/budgets.ts
  - server/src/services/costs.ts
  - server/src/services/activity.ts
related_tests:
  - server/src/__tests__/approvals-service.test.ts
  - server/src/__tests__/approval-routes-chat-application.test.ts
  - server/src/__tests__/budgets-service.test.ts
  - server/src/__tests__/costs-service.test.ts
  - server/src/__tests__/costs-rollups-service.test.ts
  - server/src/__tests__/activity-service.test.ts
  - tests/e2e/cost-trend.spec.ts
edit_policy: user_confirmed_only
---

# Approvals Budgets And Activity

## APPROVAL.GOVERNED.ACTIONS.001

Why:

- Approvals are the product boundary for governed actions. They prevent an
  agent or chat proposal from silently changing high-impact state.

Flow:

1. A proposal creates an approval request with target entity, action payload,
   requester, status, and context.
2. Comments preserve approval discussion.
3. Approver accepts/rejects or requests changes.
4. Approved action is applied through the owning domain service.
5. Activity and chat/issue links preserve the decision and application result.

Invariants:

- Approval application must be idempotent.
- Approval state must remain organization-scoped and tied to the governed
  action it permits.

Evidence:

- `server/src/__tests__/approvals-service.test.ts` covers approval service
  behavior.
- `server/src/__tests__/approval-routes-chat-application.test.ts` covers chat
  approval application paths.

## BUDGET.ENFORCEMENT.001

Why:

- Rudder allows autonomous agent runs, so spend controls must be visible and
  enforce hard stops instead of only reporting after the fact.

Flow:

1. Runtime/result ingestion records cost events and usage metadata.
2. Cost rollups aggregate by organization, agent, project, issue, run, and time
   window where supported.
3. Budget service checks monthly UTC period limits and thresholds.
4. Soft alerts surface spend pressure; hard limits pause or block further work.
5. UI/API readbacks show spend trend and budget state.

Invariants:

- Hard-stop budget behavior must block new hidden work when limit is reached.
- Cost rollups must retain source run/event identity for audit.

Evidence:

- `server/src/__tests__/budgets-service.test.ts`,
  `server/src/__tests__/costs-service.test.ts`, and
  `server/src/__tests__/costs-rollups-service.test.ts` cover budget/cost
  service behavior.
- `tests/e2e/cost-trend.spec.ts` covers visible cost trend behavior.

## ACTIVITY.AUDIT.001

Why:

- Activity is the operator's audit ledger. Mutating actions across issues,
  goals, projects, agents, automations, approvals, and integrations need a
  durable trace.

Flow:

1. Owning domain mutates state.
2. It records activity action, actor, entity, organization, references, and
   summary fields.
3. Activity service can aggregate related chat, issue, run, and approval
   context for timelines and Messenger.
4. Internal execution-coordination audits may remain durable for backend
   diagnostics while operator-facing Activity, Messenger, Agent Run events,
   and Run Intelligence omit them when they do not describe a material product
   change. `issue.execution_released` is this kind of internal audit: it proves
   terminal cleanup and idempotency, but it does not itself change the issue's
   operator-visible status, ownership, review state, or result.

Invariants:

- Activity should describe material product changes, not every internal update.
- Mutating product actions must not be invisible when later agents need to
  reconstruct why state changed.
- Agents reconstruct issue state from material issue activity, the issue's
  current status and routing fields, and the run's visible terminal lifecycle
  evidence. They must not depend on the internal `issue.execution_released`
  audit, which remains queryable only through backend storage and diagnostics.
- Filtering an internal event must happen before pagination is exposed so a
  hidden row cannot consume a public page slot, create a false `hasMore`, or
  make visible lifecycle evidence disappear.

Evidence:

- `server/src/__tests__/activity-service.test.ts` covers activity aggregation
  and reference behavior, including the persisted-but-operator-hidden execution
  release audit boundary.
- Issue, automation, approval, and Messenger tests verify domain-specific
  activity consumers where those flows are visible.
- `tests/e2e/issue-activity-chat-links.spec.ts` covers the same hidden-event
  boundary across public Agent Run events, Run Intelligence, Messenger issue
  activity, and Agent Run detail while keeping visible terminal evidence.
