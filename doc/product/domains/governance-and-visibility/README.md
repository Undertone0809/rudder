---
title: Governance And Visibility
domain: governance-and-visibility
status: active
coverage: detailed
contract_ids: []
related_code:
  - server/src/services/activity.ts
  - server/src/services/issue-approvals.ts
  - server/src/services/budgets.ts
  - server/src/services/costs.ts
related_tests:
  - server/src/__tests__/activity-service.test.ts
  - server/src/__tests__/approvals-service.test.ts
  - server/src/__tests__/budgets-service.test.ts
  - server/src/__tests__/costs-service.test.ts
edit_policy: user_confirmed_only
---

# Governance And Visibility

## Owns

- Approval records and governed action application.
- Budget hard stops, cost events, and spend rollups.
- Activity log taxonomy and audit references.
- Dashboard summaries derived from underlying domain facts.
- Calendar source traceability and human Inbox attention.

## Contract Index

- `APPROVAL.GOVERNED.ACTIONS.001`: approvals preserve governed action state and
  application evidence.
- `BUDGET.ENFORCEMENT.001`: budget limits stop hidden autonomy and surface spend.
- `ACTIVITY.AUDIT.001`: mutating product actions leave auditable activity.
- `DASHBOARD.SUMMARY.001`: dashboard summarizes organization health from live
  domain records.
- `CALENDAR.SOURCE.001`: calendar events preserve source-object identity.
- `INBOX.ATTENTION.001`: human inbox aggregates user-scoped operator attention.
- `SEARCH.AI.001`: command-palette deterministic search can explicitly fall
  back to organization Smart Model search, including selected category scopes.
