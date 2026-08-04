---
title: Product Analytics Telemetry
domain: governance-and-visibility
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - ANALYTICS.TELEMETRY.001
related_code:
  - packages/db/src/schema/product_analytics_events.ts
  - packages/db/src/schema/product_analytics_consent.ts
  - packages/db/src/schema/product_analytics_installations.ts
  - packages/db/src/schema/product_analytics_outbox.ts
  - packages/db/src/schema/product_analytics_work_cycles.ts
  - packages/identity-db/src/product-analytics.ts
  - packages/identity-db/src/product-analytics-consent.ts
  - packages/identity-db/src/schema.ts
  - server/src/services/product-analytics.ts
  - server/src/services/product-analytics-collector.ts
  - server/src/routes/product-analytics.ts
  - server/src/routes/product-analytics-collector.ts
  - server/src/routes/product-analytics-collector-report.ts
  - server/src/services/product-analytics-collector-maintenance.ts
  - server/src/routes/instance-settings.ts
  - desktop/src/product-analytics-telemetry.ts
  - desktop/src/product-analytics-uploader.ts
  - ui/src/pages/InstancePrivacyTelemetrySettings.tsx
  - ui/src/api/instanceSettings.ts
  - ui/src/lib/settings-prefetch.ts
related_tests:
  - server/src/services/product-analytics.test.ts
  - server/src/services/product-analytics-collector.test.ts
  - server/src/__tests__/product-analytics-routes.test.ts
  - server/src/__tests__/product-analytics-collector-routes.test.ts
  - desktop/src/product-analytics-telemetry.test.ts
  - desktop/src/product-analytics-uploader.test.ts
  - ui/src/pages/InstancePrivacyTelemetrySettings.test.tsx
  - tests/e2e/product-analytics.spec.ts
  - tests/e2e/settings-layout.spec.ts
related_plans:
  - doc/plans/2026-08-03-product-analytics-telemetry-full-implementation.md
edit_policy: user_confirmed_only
---

# Product Analytics Telemetry

## ANALYTICS.TELEMETRY.001

### Contract Summary

Rudder records privacy-bounded product analytics facts locally before any
optional delivery. Product analytics is opt-in, consent-scoped, pseudonymized
at export, and must measure human-origin work loops rather than presence,
sessions, raw runs, or issue status alone.

### Intent / User Job

Product operators can answer whether Rudder is being used to complete real,
reviewable agent work while preserving a local-first default and a clear
boundary around account-linked data.

### Why / Design Reasoning

DAU without an action definition overcounts open tabs, devices, and automated
runs. The north-star fact is a human-origin work loop that has a successful run,
an output, and any required approval. Consent epochs and an outbox make export
revocable and retryable without losing the local evidence ledger.

### Actors / Objects / State

- Human operator, agent, automation, local Rudder installation, local user,
  organization, chat/issue work cycle, event ledger, consent ledger, outbox,
  private collector, and Desktop uploader.
- Installation modes are `off`, `anonymous`, and `account_linked`.
- Outbox states are pending, claimed, retry-wait, delivered, and actionable
  failure/dead-letter.
- A work cycle is open, completed at a monotonic completion revision, or
  invalidated after a later reopen/recovery transition.

### Entry Points / Inputs

- Product event producers at organization, chat, issue, agent-readiness, run,
  output, review, completion, and invalidation transitions.
- Identity read-only funnel queries for account-created, verified,
  desktop-authorized, and local-connected counts.
- Installation registration, consent grant/revoke, outbox claim/ack, and the
  private collector batch/revoke boundaries.
- Desktop local telemetry state creation and one-shot upload orchestration.

### Product Logic Flow

1. A producer writes a bounded event envelope to the local event ledger with a
   stable dedupe key and explicit actor, origin, environment, work, run, and
   confidence fields.
2. Chat and issue work creates one organization-scoped work-cycle record. Run,
   output, and review facts advance its completion gates.
3. Completion is emitted only when a successful run and output exist, plus an
   approved review when the work requires review. Reopen/invalidation records a
   revision-specific invalidation fact.
4. Installation registration starts in `off`. A consent ledger decision, not a
   registration flag, changes the effective mode. Account-linked consent is
   also recorded in the Identity-owned append-only ledger; the latest granted
   Identity row is required before an upload assertion is issued. Revocation
   advances the consent epoch and removes unsent older-epoch outbox rows.
5. A consent-matched event is copied to the local outbox. Desktop claims a
   homogeneous batch with a lease, sends pseudonymized payloads to the private
   collector using a subject-free telemetry-scoped assertion for anonymous mode
   or a subject-bound assertion for account-linked mode, and acknowledges
   delivery or retry/dead-letter state using the installation secret.
6. The summary endpoint exposes local human activity, meaningful/productive
   installations, completed loops, invalidations, run/output/review facts, and
   data-quality context.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Default installation | No consent ledger grant | Persist locally; effective mode is `off` | Upload telemetry implicitly | Desktop state and E2E |
| Anonymous grant | Anonymous scope granted at current epoch | Queue installation-scoped pseudonymous events | Attach a local account identity | Consent/outbox tests |
| Account-linked grant | Human local user grants account scope | Queue events for that user and epoch | Use an agent ID as the human identity | Route/service tests |
| Consent revoke | Revoke decision creates a newer epoch | Drop unsent older-epoch rows and reject stale collector batches | Replay an equal/older epoch to un-revoke | Collector tests |
| Duplicate event | Same event ID and identical payload | Return duplicate acknowledgement | Store a second fact or accept a conflicting payload | Collector tests |
| Completion gate | Successful run, output, and required approval exist | Emit one revisioned completed-loop fact | Count a raw run or `done` status as completion | Work-cycle service tests |
| Reopen/invalidation | Completed cycle is reopened or invalidated | Record invalidation and exclude it from completed-loop summary | Keep invalidated completion in the north-star count | Summary/service tests |

### Actor-Visible Input

The operator can explicitly choose anonymous or account-linked telemetry in the
consent boundary. Installation status, consent history, pending delivery count,
and last upload status are available to the owning local runtime. The default
state is off.

### Operator-Visible Output

Analytics summaries distinguish local human activity from completed work loops,
installation cohorts, run/output/review counts, invalidations, and data-quality
limits. Export payloads contain pseudonymous identifiers and scalar allowlisted
properties only.

### Persisted Evidence

The local database stores the event ledger, work-cycle state, consent decisions
and epochs, installation secret hash, and outbox delivery state. Identity
funnel reads return aggregate counts without email, provider subject, or device
identifiers. The private collector stores raw facts, subject consent state,
quality counters, daily rollups, revision projections, and thresholded privacy
aggregates in the isolated `rudder_analytics` schema. Anonymous and
account-linked uploads use signed short-lived `aud=telemetry-collector`
assertions; account-linked assertions include only the collector-scoped subject
and both modes require the corresponding current Identity consent grant and
epoch when an Identity session is used.

### Canonical Scenarios

1. A fresh Desktop creates an installation in `off`, then records an explicit
   anonymous consent grant and queues eligible events.
2. A human starts work in Chat or an issue, a run succeeds, output is ready,
   and required review is approved; exactly one completion revision is counted.
3. A completed issue is reopened; the completion is invalidated and no longer
   contributes to the completed-loop summary.
4. A collector receives the same event twice, accepts it once, and rejects a
   payload conflict or revoked epoch.

### Invariants / Non-Goals

- No telemetry leaves the local installation without explicit consent.
- Secrets are hashed at rest and are used only for local claim/ack and export
  pseudonymization; they are not sent to the renderer or collector payload.
- Analytics is organization-scoped for local product facts and never exposes
  raw prompts, transcripts, titles, descriptions, URLs, email, or credentials.
- This contract does not claim a configured public telemetry deployment or a
  self-hosted uploader without Desktop Main. The central SQL collector, signed
  assertion, Desktop scheduler, and Privacy & Telemetry controls are implemented
  surfaces that still require deployment credentials and rollout gates.
- Presence, device sessions, raw runs, and issue `done` status are not DAU or
  north-star completion definitions.

### Drift Boundaries

Update this contract for event-envelope changes, new consent scopes or modes,
work-cycle completion gates, invalidation semantics, export identifiers,
collector authorization, delivery state transitions, or user-visible telemetry
controls.

### Traceability

The local analytics service, DB migrations, collector contract tests, Desktop
telemetry tests, identity consent tests, report/retention checks, and privacy E2E
cover the current behavior. Browser E2E covers the local consent/revocation
workflow; the private central collector/report surface is covered by server
integration tests and deterministic fixtures because it requires an isolated
deployment database. Deployment role provisioning, anonymous authorization, and
network-redaction gates remain operational rollout work.
