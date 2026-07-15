---
title: Control Plane Domain
domain: control-plane
status: active
coverage: detailed
contract_ids: []
related_code:
  - server/src/services/activity.ts
  - server/src/services/issue-approvals.ts
  - server/src/services/budgets.ts
  - server/src/services/costs.ts
  - server/src/services/run-intelligence.ts
  - server/src/index.ts
  - server/src/runtime/runtime-supervisor.ts
related_tests:
  - server/src/__tests__/activity-service.test.ts
  - server/src/__tests__/approvals-service.test.ts
  - server/src/__tests__/budgets-service.test.ts
  - server/src/__tests__/costs-service.test.ts
  - server/src/__tests__/runtime-supervisor.test.ts
  - scripts/smoke/server-runtime-lifecycle.mjs
edit_policy: user_confirmed_only
---

# Control Plane Domain

## Owns

- Approval records and governed action application.
- Budget hard stops, cost events, and spend rollups.
- Activity log taxonomy and audit references.
- Dashboard and run-intelligence rollups derived from underlying domain facts.
- Server process availability across startup, shutdown, and restart boundaries.
- Desktop startup presentation and failure-only operator recovery.

## Contract Index

- `CONTROL.APPROVALS.001`: approvals preserve governed action state and
  application evidence.
- `CONTROL.BUDGETS.001`: budget limits stop hidden autonomy and surface spend.
- `CONTROL.ACTIVITY.001`: mutating product actions leave auditable activity.
- `CONTROL.RUN.INTELLIGENCE.001`: operator intelligence surfaces summarize runs
  without replacing raw evidence.
- `CONTROL.DASHBOARD.001`: dashboard summarizes organization health from live
  domain records.
- `CONTROL.CALENDAR.001`: calendar events preserve source-object identity.
- `CONTROL.INBOX.001`: human inbox aggregates user-scoped operator attention.
- `CONTROL.SERVER.LIFECYCLE.001`: the server releases resources registered with
  its lifecycle owner consistently across normal stop, repeated stop, startup
  failure, and restart.
- `CONTROL.DESKTOP.STARTUP.RECOVERY.001`: Desktop keeps healthy startup quiet and
  reveals retry, support-email guidance, and bounded diagnostics only after a
  managed local startup failure.
