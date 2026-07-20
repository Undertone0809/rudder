---
title: Run Intelligence
domain: execution
status: active
coverage: detailed
contract_ids:
  - RUN.INTELLIGENCE.001
related_code:
  - server/src/services/run-intelligence.ts
  - server/src/routes/run-intelligence.ts
  - server/src/services/heartbeat-run-summary.ts
  - server/src/services/heartbeat-run-reference.ts
  - cli/src/commands/client/runs.ts
  - packages/run-intelligence-core/src/loaders/rudder.ts
  - packages/shared/src/types/run-intelligence.ts
related_tests:
  - server/src/__tests__/heartbeat-run-summary.test.ts
  - server/src/__tests__/run-intelligence-summary-service.test.ts
  - server/src/__tests__/run-intelligence-routes.test.ts
  - server/src/__tests__/run-intelligence-service.test.ts
  - server/src/__tests__/run-intelligence-e2e.test.ts
  - packages/run-intelligence-core/src/loaders/rudder.test.ts
  - tests/e2e/run-transcript-detail.spec.ts
edit_policy: user_confirmed_only
---

# Run Intelligence

## RUN.INTELLIGENCE.001

Why:

- Run intelligence helps operators understand a run without reading raw logs
  first. It summarizes status, transcript, result, cost, skill usage, and target
  context while preserving links to raw evidence.

Flow:

1. Execution records run result, transcript, events, cost, context snapshot, and
   references.
2. Organization-scoped list reads default to an allowlisted summary projection
   with stable `(createdAt, id)` keyset cursors. Summary rows include identity,
   status, timing, agent/runtime, target/issue reference, bounded outcome/error,
   normalized usage/cost, skill evidence, and log availability without loading
   full result/context JSON, excerpts, sessions, process data, or config
   fingerprints.
3. Official CLI list consumers use the summary projection by default and expose
   `--full` for the compatibility export shape.
4. Single-run detail retains the full diagnostic view. Events page by
   `afterSeq`/`limit`; logs page by byte `offset`/`limitBytes` and report the next
   offset plus EOF.
5. Transcript output returns only the requested page instead of appending a
   second complete transcript payload. Raw transcript/log evidence remains
   available underneath the summary.

Invariants:

- Summary must not replace raw run evidence.
- Derived insight must remain traceable to run, target, and transcript data.
- Run and hydrated issue metadata must remain organization-scoped even when an
  untrusted runtime context snapshot contains an issue id from another
  organization.
- Summary pagination must be stable for equal timestamps and must not use deep
  offset pagination.
- Summary rows and human outcome/error fields stay bounded independently of raw
  result and log size.
- Event and log reads enforce their server-side bounds, authorization, and
  redaction rules.
- Errors and transcript pages still load and parse one selected run's complete
  log before slicing. Removing that single-run memory/latency boundary requires
  normalized persisted transcript data and is not implied by bounded output.

Evidence:

- `server/src/__tests__/run-intelligence-summary-service.test.ts` covers the
  allowlist, payload budget, keyset pagination, and cross-organization issue
  hydration boundary.
- `server/src/__tests__/run-intelligence-routes.test.ts` and
  `server/src/__tests__/run-intelligence-service.test.ts` cover summary/full
  compatibility plus bounded event/log authorization and redaction.
- `server/src/__tests__/run-intelligence-e2e.test.ts` covers the real embedded
  PostgreSQL and Express workflow; run-intelligence core/CLI tests cover summary
  defaults and explicit full output.
- `tests/e2e/run-transcript-detail.spec.ts` covers the terminal run transcript
  detail surface.
