---
title: Desktop macOS silent automatic updates
date: 2026-08-13
kind: implementation
status: in_progress
area: desktop
entities:
  - desktop_updates
  - desktop_runtime
issue:
related_plans:
  - 2026-07-16-desktop-update-last-known-good-recovery.md
supersedes: []
related_code:
  - desktop/src/desktop-update-flow.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/main.ts
  - cli/src/commands/start.ts
commit_refs: []
updated_at: 2026-08-13
---

# Desktop macOS Silent Automatic Updates

## Intent

Packaged macOS `prod_local/default` installs verified Desktop updates without
interrupting the operator. Rudder checks five seconds after a ready launch and
once per hour thereafter, prepares a verified candidate silently, and applies it
only during a genuine user quit. Window close, resident hide, attached runtime
survival, and system shutdown never trigger an implicit destructive action.

## Implementation decisions

The current implementation slice is intentionally fail-closed. It provides
durable scheduling, exact staged artifact identity, signed-policy verification
primitives, and natural-Quit routing, but it does not claim automatic install
until a separately installed recovery helper, authenticated policy loading,
instance-wide admission/drain, database checkpoint, atomic exchange,
probation, and last-known-good rollback are wired and packaged-tested.

- Automatic preparation is durable and single-flight. A persisted candidate is
  bound to `updateId`, release channel, version, platform, architecture,
  install/profile identity, and source release digest.
- The preparation event includes the exact cached archive path and digest;
  apply passes that identity back to the CLI in exact-asset mode, which refuses
  to resolve a new GitHub release or accept a substituted file.
- Automatic apply is disabled unless signed-policy and external-helper
  capability attestations are present. Missing capability leaves the candidate
  staged for a later eligible release.
- The existing manual Check for Updates / Install Now flow remains visible and
  keeps its existing blocker and force-update choices.
- Automatic update failures and successful rollback stay silent. If both the
  target and last-known-good release cannot reach readiness, the next launch
  uses the existing bounded boot recovery surface with sanitized diagnostics.
- v1 is macOS packaged only. Other platforms retain the existing manual path
  until their bootstrap and atomic replacement contracts are implemented.

## Acceptance

- Scheduler state survives restart, duplicate wake, sleep, and clock rollback;
  it never creates overlapping checks or a catch-up storm.
- Automatic preparation produces no update prompt, toast, progress card, or
  notification. A candidate remains available after a normal app restart.
- Candidate apply is attempted only from a natural quit, only for an owned
  runtime with no active work, and never delays OS shutdown/logoff.
- The exact candidate identity is checked again at apply time. A conflicting
  manual target cannot retarget an existing automatic claim.
- Packaged macOS E2E exercises successful prepare/apply, attached runtime,
  active-run drain, resident close, crash/restart, tamper, migration failure,
  rollback, and the dual-failure recovery surface.
