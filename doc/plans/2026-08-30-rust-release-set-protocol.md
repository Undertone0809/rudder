---
title: Signed release-set and bounded bootstrap protocol
date: 2026-08-30
kind: design-note
status: in_progress
area: deployment
entities:
  - release_set
  - desktop_update
  - migration_compatibility
issue: R6Z-132
related_plans:
  - 2026-08-20-rust-migration-baseline-freeze.md
  - 2026-08-20-rust-electron-release-inventory.yml
  - 2026-07-16-desktop-update-last-known-good-recovery.md
supersedes: []
related_code:
  - contracts/rudder-release-set/v1.schema.json
  - scripts/release-set-protocol.mjs
  - scripts/release-set-protocol.test.mjs
  - scripts/release-compatibility-matrix.mjs
  - .github/workflows/release.yml
commit_refs: []
updated_at: 2026-08-30
---

# Signed Release-Set And Bounded Bootstrap Protocol

## Decision

This protocol defines `rudder.release-set/v1` as the versioned identity of one
complete, immutable product generation. The manifest binds one source commit,
one product version, one channel, an exact sorted artifact set, compatibility
epochs, a minimum updater, bounded stage/probe/drain limits, and the existing
Electron/native-helper handoff. A release set is accepted only inside a
`rudder.signed-release-set/v1` Ed25519 envelope.

This layer validates and coordinates identities. It does not take execution
authority from Electron, the Server, the database migration runtime, or the
native update helper.

## Scope Boundary

R6Z-132 delivers the schema, executable reference validator/state machine,
failure-closed tests, migration declaration, and explicit packaged lifecycle
gates. It does **not** yet make the release workflow emit a signed envelope or
make the installed Electron/updater path consume one. Those integration points
need a configured release signing trust root and changes owned by the existing
release and Electron/helper authorities. Until that follow-up is implemented,
the current checksum, signed Desktop update-policy, and helper transaction
contracts remain production authority. The reference protocol must not be
described as governing a published or installed release yet.

## Manifest Identity

The canonical structural wire schema is
`contracts/rudder-release-set/v1.schema.json`. Its root is the complete signed
envelope and its payload definition is `rudder.release-set/v1`. JSON Schema
enforces exact fields, primitive shapes, bounds, identifiers, and the fixed
authority constants. The reference validator additionally enforces semantic
invariants JSON Schema cannot express portably: canonical ordering, artifact
version equality, self-readable database epochs, exact updater scope, and
cross-generation compatibility. Canonical JSON sorts object keys, preserves
array order, rejects non-JSON numbers and values, and is hashed with SHA-256.
The same canonical payload bytes are the Ed25519 signature input.

Required release identity:

- `releaseId`, product `version`, release `channel`, and full lowercase
  `sourceSha`;
- `minimumUpdaterVersion`;
- sorted artifacts with stable id, kind, exact release version, SHA-256, byte
  length, platform, and architecture;
- release and database compatibility epochs;
- bounded stage attempts, probe attempts, probe timeout, and drain timeout;
- immutable Electron/native-helper authority names.

The protocol rejects unknown schemas or fields, missing/unknown/invalid
signatures, unsafe or duplicate artifact ids, mixed artifact versions,
unexpected artifact sets, and artifact digests or sizes outside the schema.

## Compatibility Boundary

Each manifest declares:

- `releaseEpoch`: the release protocol generation;
- `databaseEpoch`: the database generation the candidate produces;
- `bootstrapFromEpochs`: installed release epochs the candidate may replace;
- `readableDatabaseEpochs`: database epochs the candidate can open;
- `rollbackToEpochs`: installed release epochs to which rollback is declared.

A transition is admitted only when the candidate can bootstrap from the
installed release epoch and read its database epoch. Rollback is admitted only
when the candidate names the installed release epoch and the installed release
can read the candidate database epoch. An epoch declaration is not evidence by
itself: the release migration compatibility matrix and historical runtime
rehearsal remain mandatory.

## Bounded State Machine

```text
pending
  -> staged
  -> admission_closed (activeRuns=0, durable drain token)
  -> switched (same manifest digest and drain token)
  -> committed (probe passes)
  -> rollback_required (bounded probes exhausted)
  -> rolled_back | recovery_required
```

Staging and probing have manifest-defined attempt caps. The transition freezes
the drain/probe timeouts from the candidate manifest. A successful stage fixes
the drain deadline; an atomic switch fixes the probe deadline. Events carry a
monotonic `nowMs`, and expiry fails the drain or requires rollback after switch.
Stale events are rejected unless they carry the frozen manifest digest. The
switch requires the same drain token that closed admission. A failed or expired
probe can never commit. Once the bounded probe allowance is exhausted, the only
legal next operation is LKG rollback; failed rollback becomes
`recovery_required` rather than guessing a generation.

## Authority Handoff

The signed manifest must contain these exact authorities:

| Boundary | Authority |
| --- | --- |
| shell/window/IPC and update orchestration | `electron` |
| run admission and drain | `electron` |
| destructive filesystem exchange | `rudder-update-helper/v1` |
| installed-generation rollback | `rudder-update-helper/lkg-v1` |

Electron continues to verify signed update policy, stage an exact payload,
close admission, produce the drain token and checkpoint, then exit. The native
helper continues to verify helper/request/path identity, journal before
exchange, switch atomically on one filesystem, probe, commit, or restore LKG.
JavaScript, shell, PowerShell, and `npx` remain permitted build, release, and
installation entrypoints; they do not become persistent product authority.

## Required Production Integration Gates

Before this signed release-set can become production release/update authority:

1. the release authority generates one exact artifact manifest after all npm
   and Desktop candidate bytes are frozen, signs it with a configured Ed25519
   trust root, verifies it before the first publication mutation, and publishes
   the same envelope for installed clients;
2. Electron verifies that envelope against pinned trust, updater version,
   channel, exact requested version, and expected artifact identity before
   staging, then passes the frozen digest/deadlines into the helper transaction;
3. migration manifest preflight and historical compatibility rehearsal pass;
4. public package, Desktop, CLI, Cargo workspace/lock, and native binary
   versions match;
5. npm and Desktop candidates are built from one exact source SHA;
6. the macOS arm64 candidate runs packaged `startup-recovery`, `clean`,
   `upgrade`, `auto-update`, and `auto-update-public` scenarios explicitly;
7. artifact collection and byte verification complete before publication;
8. seven Desktop artifacts remain immutable and `SHASUMS256.txt` is published
   last as the completion marker.

This Issue implements items 3-8 and the reference behavior needed by items
1-2; it intentionally records items 1-2 as an unclaimed integration boundary.

The current `0.7.16` compatibility entry binds migration fingerprint
`3152669d55bd95e21d1aee03f0dada1d433ad28c4004ecd9c68030e4da72d2b5`
and immutable fixtures back through `0.6.5`.

## Failure-Closed Cases

- Unknown manifest/envelope schema or extra fields: reject.
- Missing, malformed, unknown-key, or invalid signature: reject.
- Candidate artifact version differs from release version: reject.
- Actual artifact ids differ from the expected frozen set: reject.
- Installed updater is below `minimumUpdaterVersion`: reject before staging.
- Release/database epoch is outside the declared forward boundary: reject.
- Installed release cannot read the candidate database epoch: reject rollback
  admission before switching.
- Drain exceeds its deadline: fail before switch.
- Probe exceeds its attempt cap or fixed deadline: require rollback.
- Active Runs remain, drain token changes, or manifest digest changes: reject
  atomic switch.
- Candidate probe fails: never commit; restore LKG inside the declared boundary.
- LKG probe/restore fails: persist `recovery_required`.

## Evidence

`scripts/release-set-protocol.test.mjs` independently covers the signed-envelope
schema and semantic-validator boundary, signature rejection, exact
artifact/version binding, updater minimum, forward and rollback epochs, fixed
Electron handoff, bounded retries and deadlines, zero-Run drain, digest/token
fencing, probe failure, LKG rollback, and recovery-required state.
Existing checksum, package-map, native version, Desktop smoke, migration, and
release workflow tests remain the adjacent regression gates.
