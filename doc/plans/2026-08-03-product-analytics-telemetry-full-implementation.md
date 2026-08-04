---
kind: plan
area: analytics
entities: product-analytics, telemetry, work-cycles
status: review_ready
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

The user explicitly authorized synchronization into `doc/product/**`; the
implemented consent, collector, assertion, report, and retention behavior is
reflected in `ANALYTICS.TELEMETRY.001`.

## Implemented In This Slice

- Local event envelope, durable work cycles, completion revisions, consent ledger,
  installation state, and lease-based outbox are persisted by migrations `0131`
  through `0136`.
- Local outbox claim proves the installation secret, rechecks the current consent
  epoch, returns only pseudonymized allowlisted payloads, and supports a server-side
  ACK that cannot mix users, modes, or epochs.
- A private collector boundary accepts at most 100 events and 64 KiB per batch,
  rejects unknown or content-bearing fields, rejects excessive future skew, and is
  idempotent by `eventId` with payload-conflict detection. The PostgreSQL-backed
  deployment stores raw events, subject consent state, quality counters, rollups,
  revision projections, and thresholded privacy aggregates in `rudder_analytics`.
- Desktop Main has a one-shot uploader orchestration path. Renderer code never
  receives the installation secret; collector failures only leave the local outbox
  retryable.
- Desktop Main reads the local Privacy & Telemetry mode before starting the
  uploader, synchronizes either anonymous or account-linked consent with
  Identity, and uses the same installation-secret HMAC as the exporter for the
  signed collector assertion. Anonymous assertions remain subject-free; a
  deployment-level anonymous authorization remains the fallback for installs
  that do not have an Identity session.
- Identity owns an append-only per-user/per-installation consent ledger. The
  telemetry assertion endpoint derives its epoch from the latest granted row;
  request-body consent flags cannot authorize an upload. The central collector
  requires the Identity ledger to synchronize each grant/revoke through its
  private `/api/analytics/v1/internal/consent/sync` hook (protected by
  `RUDDER_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET`) before an assertion can
  authorize delivery; Identity performs this sync with
  `IDENTITY_TELEMETRY_COLLECTOR_URL` and
  `IDENTITY_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET`, and retries the gate on
  assertion issuance. Assertion claims never bootstrap consent state.
- Subject-scoped consent synchronization also creates the central installation
  cohort row without treating one shared-installation subject as the global
  installation authorization state. The row is metadata-only until an
  anonymous installation-scoped decision establishes its own consent epoch.
- Identity performs the private sync before appending a new consent decision;
  a collector outage therefore returns a retryable 503 without committing a
  ledger decision that the collector cannot enforce. Replaying an unchanged
  decision re-synchronizes its existing epoch.
- The central report exposes real delivery quality counters and W1 meaningful,
  W1 loop, and W4 loop cohorts. Retention deletes raw events at the exact cutoff
  timestamp and rebuilds the cutoff UTC day.

## Rollout Gates

- A configured central deployment, role provisioning, and network redaction remain
  operational gates. Anonymous mode still requires independent deployment
  authorization; the installation secret is never accepted as an account-linked
  collector bearer credential.
- Telemetry remains `off` by default and no self-hosted uploader without Desktop
  Main is claimed by this slice.

## Acceptance evidence

- Exact event facts are transactionally deduplicated and append-only.
- Work-loop completion is revisioned and invalidation is additive.
- Consent revocation prevents new claims and removes pending deliveries.
- Outbox claim/ack/retry is lease-safe and cross-user isolated.
- Export payloads contain only allowlisted, pseudonymized fields.
- Identity and local analytics summaries distinguish exact, derived, and
  incomplete metrics.
- Focused tests, deterministic PRD gates, identity/server/db/desktop typechecks,
  migration checks, report quality counters, retention reconstruction, and the
  collector benchmark pass; unrelated shared-worktree failures remain scoped
  separately.
- The browser E2E path covers local consent and revocation. The private central
  collector and report routes are covered by server integration tests and
  deterministic fixtures because they require an isolated deployment database
  and are not mounted in the local user-facing app.
