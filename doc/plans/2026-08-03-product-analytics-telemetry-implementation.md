---
title: Product Analytics Local Ledger Implementation
date: 2026-08-03
kind: implementation
status: completed
area: data_model
entities:
  - product_analytics
  - activity_ledger
  - work_loop
issue:
related_plans:
  - 2026-08-03-openclaw-hermes-runtime-compatibility-refresh.md
supersedes: []
related_code:
  - packages/db/src/schema/product_analytics_events.ts
  - server/src/services/product-analytics.ts
  - server/src/routes/product-analytics.ts
  - packages/db/src/migrations/
commit_refs: []
updated_at: 2026-08-03
---

# Product Analytics Local Ledger Implementation

## Decision

Implement the safe local-first slice of the approved product analytics PRD in
Rudder's App DB. The first slice creates a versioned, append-only,
content-free event ledger and exposes organization-scoped baseline metrics.
Telemetry remains `off` by default: this slice creates no network uploader,
collector credential, account-linked subject, or implicit login export.

The event ledger is separate from `activity_log`, security events, and run
diagnostic tables. Domain transactions may append exact product facts while
the existing workflow behavior remains unchanged.

## Product Logic Alignment

Read contracts:

- `PRIVACY.LOCAL.DATA.BOUNDARY.001`
- `ORG.ONBOARDING.001`
- `CHAT.LIFECYCLE.001`
- `RUN.CHAT.AGENT.001`
- `RUN.EXECUTION.001`
- `REVIEW.DECISION.001`
- `REVIEW.CLOSEOUT.001`

This slice restores no missing current contract and does not yet claim the
new `TELEMETRY.PRIVACY.001` or `ANALYTICS.WORK.LOOP.001` contracts. It adds
local evidence without changing user-visible state transitions. The guarded
Product Logic Registry is not edited in this implementation; the approved
telemetry consent, explicit Chat completion, and exact work-loop completion
contract deltas remain a follow-up sync gate.

## Scope

Included:

- `product_analytics_events` local append-only table with strict event names,
  schema version, dedupe key, source transition, confidence, and allowlisted
  properties;
- exact/derived event validation with content-sensitive field rejection;
- organization-scoped read-only baseline metrics for human mutations, runs,
  outputs, review decisions, and issue completion candidates;
- deterministic idempotency and organization isolation tests;
- no outbound network behavior.

Deferred:

- central collector and raw warehouse;
- anonymous/account-linked consent UI and outbox;
- Desktop Main uploader and telemetry credentials;
- exact Chat `work_cycle_id` and durable accepted-loop projector;
- Product Logic Registry edits.

## Event Contract

The first implementation supports these local event names:

- `organization_created`
- `human_work_started`
- `run_started`
- `run_succeeded`
- `run_failed`
- `output_ready`
- `review_decision_recorded`

Every event is organization-scoped and carries only bounded scalar properties.
Prompt, transcript, title, description, path, URL, result body, raw error,
credentials, and free-form JSON are rejected by the validator.

## Acceptance

- Migration applies and rolls back safely on a fresh embedded PostgreSQL DB.
- Duplicate `dedupe_key` is a no-op and does not create a second fact.
- An event cannot be read across organization boundaries.
- Invalid event names, versions, properties, or sensitive fields fail closed.
- Baseline metrics use explicit names such as `mutating_user_dau_local` and
  `successful_runs`, never claim complete DAU or North Star coverage.
- `pnpm product-logic:check`, focused tests, typecheck, and migration checks
  pass for the changed surface.

## Follow-up Gate

Before enabling any upload or changing completion semantics, explicitly sync
the approved PRD deltas into `doc/product/**`, add the collector threat model,
and obtain independent privacy and black-box E2E evidence.

## Delivered Slice

- Added migration `0129_product_analytics_local_ledger` and the exported
  `product_analytics_events` append-only table.
- Added strict local event validation, scalar allowlists, content-sensitive key
  rejection, organization-scoped dedupe, and baseline summary/event APIs.
- Recorded exact organization, human-work, Run start/terminal, and visible
  result facts at their available transaction boundaries.
- Recorded Issue review decisions as explicitly `derived` because the current
  status, comment, and activity writes are separate transactions.
- Added service and route regression tests. Fresh embedded PostgreSQL and HTTP
  black-box verification covered migration application, dedupe, isolation,
  invalid input, and backlog-work classification.

This plan completes only the local baseline slice. It does not complete the
approved telemetry PRD: `work_loop_completed`, durable Chat work cycles,
consent/outbox/upload, Identity account funnel, and exact accepted-loop review
semantics remain follow-up work.
