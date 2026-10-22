---
title: Qualify native Agent detail ingress and Desktop startup
date: 2026-10-22
kind: fix-plan
status: in_progress
area: api
entities:
  - agent
  - backend_authority
  - rust_migration
issue:
related_plans:
  - 2026-10-16-rudder-rust-backend-retirement.md
supersedes: []
related_code:
  - native/crates/server-foundation/src/public_ingress/agent_core.rs
  - native/crates/d1-persistence/src/agent_core/instructions/mod.rs
  - server/src/routes/agents.core.ts
  - desktop/src/identity-runtime.ts
  - desktop/scripts/smoke.mjs
  - native/crates/server-foundation/src/native_chat_startup.rs
commit_refs: []
updated_at: 2026-10-22
---

## Problem and bounded outcome

The remaining Agent qualification debt includes historical managed recovery and
requests that wait on an Agent row lock after their JWT expires while crossing
the private Node bridge. Upstream PR #352, now on main at `b38b171364`, already
supplies the opaque external-root error repair and Claude history-path fix.
Those upstream outcomes are preserved rather than counted again as this change.

Move GET/HEAD `/api/agents/:id` and `/api/agents/me`, including casing and
trailing-slash aliases, directly into the Rust public adapter. Resolve trusted
host placement in Rust and revalidate the original credential after row locks,
before full or restricted projections can allocate workspace keys. Suppress the
corresponding private Node adapters in native mode; native dependency failure
must return 503 without Node business fallback. The production CLI continues to
reject missing native identity configuration before binding its public port.

Preserve reference lookup, query multiplicity, error precedence, redaction,
integrations, tool descriptors and HEAD representation lengths. External roots
remain opaque, including files and symlinks. Historical managed recovery
rejects symlink ancestors before writes, recovers contents larger than 1 MiB,
and preserves valid existing managed edits and aliases. The Claude Windows
history repair is already on the new base and has no diff in this candidate.

Compatibility deployments without the native public listener remain registered
debt. This slice does not complete authentication or backend retirement.

## Desktop and qualification repairs

The complete Desktop macro exposed two startup mismatches and an update fixture
error. Reuse the previously preserved startup implementation instead of repeating
the diagnosis: create the missing absolute workspace root supplied by the trusted
launcher; retain existing configured aliases and files; reject relative paths,
parent traversal, file roots and dangling aliases. This path is an installation
fact, not an API request parameter.

Resolve the Desktop account requirement before configuring native ingress. An
explicit development bypass and a legitimately marked packaged smoke fixture
must supply the same identity policy to both layers. Ordinary packaged apps and
spoofed name/marker combinations remain account-required. The public auto-update
fixture must pass the environment returned by its external-runtime preparation.
Full-only update completion leaves the app closed; manual reopen is separate.

macOS CI also exposed two test assumptions. Canonicalize only the owned temporary
instruction fixture root so `/tmp` and `/private/tmp` aliases do not accidentally
exercise the production ownership guard. Keep all malicious symlink cases and
the guard itself unchanged. Synchronize the process-host finish test at the
actual full-queue branch, preserving terminal-frame order and the production
queue, drain deadline and close behavior. These are qualification repairs, not
additional backend authority retirement.

## Current candidate and evidence boundary

Draft PR #353 has remote source `6e0e3836f` on main base `b38b171364`. Its API-only
v5 source fingerprint is
`31ee9f5d638ed951fcfacbf72ee3bbb97357dd4e9cc7ba3d01ed1b1f2daffcd6`.
Independent scoped API acceptance passed. The original complete run remained
FAIL after a stale bridge prevented the create supplement; a separate fresh
runtime passed the six create observations. These are distinct runtime/data
identities. Preserve both results and the earlier FAIL/QUESTION history.

The expanded v6r1 source candidate has twelve scoped source/test paths, fingerprint
`71aa79c222850b6d10f8c829de758715cf099cad5537d2916e40e981197fdbbc`.
Before the reviewer traversal correction, the staged foundation SHA was
`7d277a2abea42568c4ec7312edef45c9e1ad8aa17c205a815883cf704bd0ea39`;
the staged process-host SHA is
`06c98571db643761898052c87afa7c8b50c63a1469ba3b1dcb5f4aecc8c5e77e`.
The existing Desktop app/ZIP predates the restored startup source and is not a
current packaged candidate. Prior v5 binary acceptance cannot certify these
combined artifacts.

Author checks on the added changes passed: 16 Desktop identity-policy cases,
Desktop typecheck, six native startup units, 25 instruction units under
`TMPDIR=/tmp`, eight process-host units, native staging, and a real development
startup-recovery scenario. The old instruction binary first reproduced the
macOS alias failure. The process-host Cargo suite passed, while its outer zsh
wrapper failed on a read-only variable; retain both statuses without replaying
passing tests merely to repair metadata.

The API-only rebased author baseline passed 44 public-entry tests, full repository
typecheck, Rust format and scoped clippy. Full lint had 22 unchanged failures.
PR #353's old head currently has 18 successful checks, one skipped check and
three failures (both macOS native jobs and the aggregate qualification job).
Those CI failures remain historical until the repaired exact head is qualified
and published. Windows CI passed for the old head; new-head CI is still needed.

## Remaining gates

1. Independent stage review accepted v6r1 after the existing-target traversal
   correction. All six startup units passed in 78.716 seconds; the earlier
   rejected candidate and stale staged artifacts remain recorded.
2. Run the complete `pnpm desktop:verify` without scenario skips. Require at
   least 8 GiB free before starting; monitor an ongoing 2.5 GiB floor and bound
   the owned process group to 1,200 seconds. A resource stop is a failure, not a
   waived gate. Preserve the previous full-macro startup failure.
3. Freeze the actual current packaged app and native artifacts. Independently
   accept the changed startup/account-gate/update paths and affected public API
   against that exact source/build/data identity. Normal application storage
   initialization is allowed; an OS authentication prompt remains QUESTION.
   A synthetic marked smoke profile does not prove real-account/provider use.
4. Obtain final review, update the existing draft PR with an exact remote-head
   lease, and require current protected cross-platform CI before merging.

No current complete Desktop, no-Node, real-provider, merge, release, deployment
or whole-backend completion is claimed. The original detailed receipts remain
in the versioned task evidence; they are not replaced by this concise record.

Use one shared-baseline integration candidate. Bound long commands with owned
process groups and timeouts, isolate fixture paths, and reuse evidence only
for unchanged relevant content. Preserve prior FAIL/QUESTION receipts and
record base drift. Sustained throughput improvement requires delivered results,
not another process proposal.
