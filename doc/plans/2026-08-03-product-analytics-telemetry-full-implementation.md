---
kind: plan
area: analytics
entities: product-analytics, telemetry, work-cycles
status: in_progress
---

# Product Analytics and Privacy-Safe Telemetry

## Objective

Implement the approved Rudder product analytics PRD from the existing local
ledger baseline through durable work-loop facts, consent-scoped delivery, and
read-only reporting surfaces. Preserve local-first behavior and never upload
workspace content.

## Delivery slices

1. Expand the local event envelope and add durable work-cycle/completion facts.
2. Add identity funnel and agent-readiness projections with read-only views.
3. Add append-only consent, installation state, outbox leasing, retry, and
   privacy-safe export helpers. Keep delivery disabled by default.
4. Add local summary metrics, deterministic fixtures, privacy/reliability tests,
   and documentation of the collector boundary.
5. Run focused verification, typechecks, migration generation, and commit only
   analytics-owned files.

## Product Logic boundary

This plan does not authorize semantic edits to `doc/product/**`. The Product
Logic delta described in the PRD remains proposed until the user explicitly
approves synchronization into the registry.

## Implemented In This Slice

- Local event envelope, durable work cycles, completion revisions, consent ledger,
  installation state, and lease-based outbox are persisted by migrations `0131`
  through `0136`.
- Local outbox claim proves the installation secret, rechecks the current consent
  epoch, returns only pseudonymized allowlisted payloads, and supports a server-side
  ACK that cannot mix users, modes, or epochs.
- A private collector boundary accepts at most 100 events and 64 KiB per batch,
  rejects unknown or content-bearing fields, rejects excessive future skew, and is
  idempotent by `eventId` with payload-conflict detection. Its in-memory store is a
  deterministic contract fixture; production deployment must provide the central
  private SQL store and authorizer.
- Desktop Main has a one-shot uploader orchestration path. Renderer code never
  receives the installation secret; collector failures only leave the local outbox
  retryable.

## Deferred Explicitly

- Central SQL migrations, signed Identity analytics assertions, scheduled Desktop
  background execution, and privacy-threshold daily rollups remain deployment work
  outside this local repository slice.
- A visible Privacy & Telemetry settings page still needs to be wired to the
  existing settings shell. The API and E2E privacy contract are in place, with
  telemetry defaulting to `off`.

## Acceptance evidence

- Exact event facts are transactionally deduplicated and append-only.
- Work-loop completion is revisioned and invalidation is additive.
- Consent revocation prevents new claims and removes pending deliveries.
- Outbox claim/ack/retry is lease-safe and cross-user isolated.
- Export payloads contain only allowlisted, pseudonymized fields.
- Identity and local analytics summaries distinguish exact, derived, and
  incomplete metrics.
- Focused tests and typechecks pass; unrelated shared-worktree failures are
  reported separately.
