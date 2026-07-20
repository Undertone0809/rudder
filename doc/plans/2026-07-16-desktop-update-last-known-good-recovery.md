---
title: Desktop Update Last-Known-Good Recovery
date: 2026-07-16
kind: proposal
status: proposed
area: desktop
entities:
  - desktop_updates
  - desktop_update_rollback
  - startup_recovery
  - support_diagnostics
issue:
related_plans:
  - 2026-05-16-runtime-cache-retention.md
  - 2026-05-28-layered-desktop-updates.md
  - 2026-07-15-desktop-startup-loading-recovery.md
  - 2026-07-16-desktop-prod-startup-diagnostics-fix.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/runtime/install.ts
  - desktop/src/desktop-update-flow.ts
  - desktop/src/main.ts
  - desktop/src/post-update-reload.ts
  - desktop/src/runtime-cache.ts
  - desktop/scripts/smoke.mjs
  - packages/db/src/client.ts
commit_refs:
  - docs: propose desktop update recovery
updated_at: 2026-07-16
---

# Desktop Update Last-Known-Good Recovery

## Overview

Make a packaged Rudder Desktop update a recoverable transaction instead of an
irreversible app replacement. An existing installation that cannot prove a new
candidate healthy should restore and launch the last-known-good release without
asking the operator to repair the installation. A fresh installation with no
known-good local release should offer a confirmed install of the release
manifest's recommended fallback.

"Previous version" does not mean the numerically preceding semver. The recovery
unit is the last complete release set that this machine proved healthy:

```text
Desktop asset
+ exact server runtime
+ PostgreSQL payload
+ platform / architecture / channel
+ compatible data state or verified pre-update checkpoint
```

The full product promise requires a stable recovery helper outside the candidate
app. A candidate can fail before Electron main starts, before the boot window
exists, or before the renderer can report an error; code owned only by that
candidate cannot reliably recover itself.

## What Is The Problem?

The current update flow downloads and checksum-verifies a portable Desktop
asset, waits for active Agent Runs, replaces the installed application, and
launches the update child. It does not retain a transactional last-known-good
release set or wait for the new Desktop, runtime, database, migrations, and
renderer to become ready before declaring the handoff successful.

The `0.4.6-canary.11` incident exposed the impact. The version-specific runtime
cache did not contain a usable PostgreSQL 18.4 payload. Packaged Desktop selected
the otherwise version-matching runtime, fell back to an npm PostgreSQL binary
that macOS blocked, and could not start the local API. The direct root-cause fix
is tracked separately, but one bad update was still enough to leave an existing
operator unable to open Rudder.

Existing caches are useful but are not a rollback contract:

- Desktop asset retention keeps a previous entry heuristically, without a
  durable version lineage.
- Runtime retention keeps exact versions, but does not pin the exact complete
  release set until a candidate commits.
- The post-update marker identifies the target version, but it is not an atomic
  update journal and does not record recovery attempts or outcomes.
- PostgreSQL migrations are forward-only. An old server can misread a newer
  schema as usable, so restoring binaries without proving data compatibility can
  corrupt or further damage the installation.

The result is a trust failure: the product can offer an update without proving
that it can either boot the candidate or return the operator to the version that
was working immediately before the update.

## Product Decisions

1. Existing users recover automatically when all safety gates pass. The old
   version should open first; the explanation and feedback request appear after
   recovery is healthy.
2. Fresh users explicitly confirm a fallback download. Rudder must not silently
   install a different version on a machine that has no local known-good state.
3. A failed target is quarantined for the installation. Rudder must not offer or
   reinstall it again until a newer eligible release exists or the operator
   explicitly clears the quarantine.
4. One update transaction may automatically roll back only once. Rudder must not
   loop through multiple historical releases.
5. Email and GitHub feedback open editable drafts only. GitHub is labeled public,
   and both paths use the same bounded, allowlisted diagnostic record.
6. The fallback target comes from authenticated recovery policy, including
   revocation and `minSafeVersion`. Asset checksums are bound into that policy;
   a checksum file by itself is not policy authority. Rudder does not guess the
   target from semver ordering alone.

## What Will Be Changed?

### Recovery foundation

- Add a stable updater/recovery helper that survives candidate replacement and
  owns prepare, launch, readiness, commit, and restore.
- Persist an atomic update journal outside the app bundle, scoped to the
  installation, with `updateId`, source and target release sets, checkpoints,
  checksums, policy authorization, phase, attempts, failure classification,
  quarantine, and rollback outcome.
- Upgrade install metadata from current-release-only state to `current`,
  `lastKnownGood`, and prepared `candidate` release sets while retaining backward
  read compatibility.
- Pin the last-known-good Desktop asset and exact runtime until the candidate is
  committed or rollback has completed.
- Add a main-owned readiness handshake and short stability window. Process spawn
  and `/api/health` alone are not proof that the Desktop is usable.
- Add failed-version quarantine to update selection and startup prompting. The
  helper persists quarantine after it attributes the failure to the candidate
  and passes rollback eligibility, but before it starts the previous release.

### Existing-user recovery

- Before replacement, stop the owned local runtime, prove no Agent Runs still
  own the instance, and prepare a data-safe rollback point when required.
- Launch the candidate in probation mode. Block user writes, Agent Runs,
  automations, schedulers, and plugin jobs until the update commits.
- On eligible startup failure, restore the last-known-good data state when
  required, restore the complete release set, launch it, and wait for its
  readiness proof.
- Once the restored version is ready, show one recovery notice with continue,
  email, public GitHub Issue, and technical-diagnostic actions.

### Fresh-install recovery

- When the recovery host can start but the candidate cannot, show the exact
  recommended fallback version from release metadata and require confirmation
  before downloading or installing it.
- Preserve retry, Email support, public GitHub Issue, releases-page, and copyable
  install-instruction fallbacks. Network failure must not erase the original
  startup diagnostic.
- Treat recovery from failures that occur before any app-owned helper can run as
  installer/bootstrap scope. A plain candidate `.app` cannot promise a dialog if
  the operating system cannot execute it.

## Update Transaction

The normal path is:

```text
healthy(vN)
-> candidate_downloaded(vN+1)
-> last_known_good_pinned(vN)
-> instance_quiesced
-> data_safety_proven
-> candidate_installed
-> candidate_probation
-> candidate_ready
-> commit(vN+1)
```

The recovery path is:

```text
candidate_failed
-> classify_failure
-> rollback_eligibility_check
-> quarantine(vN+1)
-> data_restore_if_required
-> restore_release_set(vN)
-> launch(vN)
-> rollback_ready
-> recovery_notice
```

The helper must resume idempotently from every persisted phase after its own
crash or a machine restart. A phase transition is durable before the next
destructive action begins. Each transaction has one immutable
`rollbackOperationId`; phase-specific completion markers and checksum-verified
temporary destinations make restore steps idempotent. Restarting the helper
continues the same logical rollback operation. Only a terminally failed logical
rollback consumes the one-automatic-attempt budget; a process crash during an
incomplete operation does not create or consume another attempt.

## Readiness And Data Safety

Candidate readiness requires all of the following:

- running Desktop and server versions match the candidate release set;
- the expected PostgreSQL payload is available and PostgreSQL is ready;
- migrations settled successfully;
- the local API is healthy;
- the main application renderer loaded and its narrow IPC bridge is responsive;
- the candidate remains healthy for a bounded stability window.

Directly launching old code after candidate database work is unsafe. A failed or
partial migration, startup normalization, or history reconciliation can mutate
schema or data without advancing the migration watermark. Before the candidate
can execute any database-mutating code, the helper durably enters a
`database_mutation_started` journal phase. If that phase was entered, the helper
must restore the verified pre-candidate checkpoint before starting the old
server, unless authenticated release policy explicitly declares the exact
source/target pair backward-compatible. Migration watermark comparison remains
useful diagnostic evidence, but it is never the sole restore gate.

For a truly fresh profile with no prior data, candidate startup uses an isolated
probation data directory. If the candidate fails, Rudder quarantines or deletes
that candidate-owned directory and initializes the fallback against a separate
empty directory; it never lets the fallback inherit a partially initialized
candidate schema. A "fresh install" pointed at an existing or imported
`RUDDER_HOME` is treated as data-bearing and must pass the same checkpoint or
explicit-compatibility gate as an existing installation.

The first implementation should support packaged Desktop using the managed
`prod_local/default` instance and embedded PostgreSQL only. External
`DATABASE_URL` installations are excluded until Rudder has an explicit snapshot
and compatibility contract for externally owned data.

Automatic rollback is blocked when:

- the candidate already committed and accepted normal writes;
- no compatible checkpoint exists after a migration-risk update;
- the last-known-good asset or runtime is missing or fails checksum validation;
- the fallback is revoked or below `minSafeVersion`;
- the failure is version-independent, such as disk exhaustion, profile damage,
  permissions, or another runtime still owning the instance;
- active Agent Runs have not quiesced;
- the transaction already completed one terminal logical rollback attempt; a
  helper restart that resumes the same `rollbackOperationId` is not a new
  attempt.

Blocked recovery must preserve the diagnostic and present an honest guided
repair path. It must not silently launch old code against unproven data.

## Recovery Policy Authenticity

Recovery policy is a signed, versioned document rooted in a trust key bundled
with the recovery helper. It binds release channel, platform, architecture,
candidate and eligible fallback versions, asset/runtime checksums, revocations,
`minSafeVersion`, monotonic policy sequence, issue time, expiry, and key id. The
helper rejects invalid signatures, sequence rollback, mismatched artifacts, and
expired online policy. Trusted transport can improve availability but is not a
substitute for policy authenticity or replay protection.

An existing-user update may begin only while policy is fresh. During prepare,
the helper persists a signed transaction authorization bound to `updateId`, the
exact source/target release sets, and their checksums. Once destructive apply
begins, that authorization remains valid for resuming the same transaction and
restoring the exact release that was running before the update, including while
offline; it cannot authorize another target or another update. This preserves
offline recovery without treating a stale general release manifest as current
policy.

A fresh installation has no transaction-bound known-good authorization. It may
download or install a fallback offline only when an unexpired cached signed
policy authorizes the exact local asset. If cached policy is expired or missing,
Rudder keeps the diagnostic and offers releases/manual-install guidance, but it
does not automatically install the cached package.

## User Experience Walkthrough

### Existing user

1. While the candidate is being evaluated, the recovery host shows `Rudder
   vX could not start. Restoring vY...` only if recovery takes long enough to
   need visible status.
2. The helper restores and launches the last-known-good release.
3. After vY is healthy, Rudder shows once:

   ```text
   Rudder restored vY

   vX could not start, so Rudder reopened the last working version.
   Your data was preserved. Updates to vX are paused.
   ```

4. Actions are `Continue with vY`, `Email support`, `Report on GitHub`, and
   `Technical details`. The GitHub action says that issues are public.
5. Technical details show and copy the same bounded diagnostic used by both
   feedback drafts: failure id, source/target version, failure stage/category,
   platform/architecture, checkpoint result, and rollback result. They exclude
   secrets, raw logs, config contents, databases, prompts, and private paths.

### Fresh user

1. The recovery host explains: `This version could not start on this computer.`
2. It offers: `Rudder can install the recommended previous stable release vY.`
3. The primary action is `Install vY`; the download starts only after explicit
   confirmation. Secondary actions are retry, Email support, public GitHub Issue,
   and releases/install help.
4. Cancelling leaves the failure surface intact. Offline recovery is possible
   only when an eligible verified fallback asset and unexpired signed policy are
   already local.

## Success Criteria For Change

- A packaged existing-user update that fails before readiness returns to the
  exact last-known-good release and opens a healthy board without manual file or
  CLI repair.
- The previous release remains bootable offline from pinned verified assets and
  the transaction-bound signed recovery authorization captured before apply.
- A candidate is never committed merely because its process launched.
- A migrated embedded database is never opened by the old server unless
  compatibility is declared or the verified checkpoint was restored.
- A failed target is not offered again for that installation.
- Recovery attempts are bounded and resumable after helper or machine failure.
- Fresh users see the exact recommended fallback and must confirm its install.
- Email and GitHub drafts contain useful bounded diagnostics, encode correctly,
  and never send or submit automatically.

## Out Of Scope

- Recursive rollback through multiple releases.
- Automatic rollback after a candidate committed and later crashed during
  normal use; that is post-start crash recovery.
- External PostgreSQL in the first implementation.
- Treating an unverified cached file or semver `n-1` as an eligible fallback.
- Silent telemetry, automatic email, automatic GitHub submission, or raw crash
  dump upload.
- Claiming full Windows and Linux installer recovery before platform-specific
  packaged black-box suites exist. The first delivery should establish the
  complete contract on macOS and then port the same transaction semantics.

## Non-Functional Requirements

- **Availability:** Recovery must work without the candidate API or renderer and
  resume after helper or machine interruption.
- **Data integrity:** Journal writes and release-set selection are atomic;
  database rollback requires a verified compatibility or checkpoint gate.
- **Security:** Assets and runtimes are checksum-verified against signed,
  replay-protected policy rooted in a bundled trust key; diagnostics are
  allowlisted and bounded.
- **Usability:** Recovery has one primary action per state, accurately labels
  public feedback, and does not require terminal knowledge.
- **Observability:** Each update and rollback has a stable failure id, phase,
  outcome, and safe diagnostic without silently uploading it.
- **Maintainability:** One transaction model owns install, candidate probation,
  commit, quarantine, and rollback. App and CLI paths must not implement
  divergent recovery rules.

## Delivery Sequence

1. **Foundation:** helper, atomic journal, last-known-good release set, explicit
   cache pinning, readiness handshake, probation, quarantine, and safe recovery
   diagnostics.
2. **Existing-user MVP:** packaged macOS Desktop, managed
   `prod_local/default`, embedded PostgreSQL, no active runs, one rollback, and
   either declared compatibility or a verified checkpoint.
3. **Fresh-install MVP:** bootstrap-owned confirmed fallback from release
   metadata, starting with macOS.
4. **Platform and failure expansion:** Windows/Linux, process-never-started,
   renderer hang/crash watchdogs, and externally owned PostgreSQL after their
   safety contracts exist.

Reusing the new shell with the previous runtime can cover some managed server
startup failures earlier, and lets the new shell show feedback over an old UI.
It is not the definition of done for the product promise because a broken new
Electron shell still cannot recover itself. Full release-set restoration under
an external helper remains the target architecture.

## What Is Your Testing Plan (QA)?

### Goal

Prove rollback as a black-box packaged transaction, including data integrity,
feedback safety, interruption recovery, and the highest-risk failure stages.

### Test Scenarios / Cases

- candidate server throws before health;
- candidate process exits before readiness;
- process remains alive but readiness never arrives;
- main renderer never becomes ready;
- migration fails after a verified embedded-database checkpoint;
- candidate mutates schema before a migration watermark advances, then fails;
- fresh candidate partially initializes its isolated data directory, then the
  fallback starts with a separate clean directory;
- previous asset/runtime is missing, corrupt, revoked, or below `minSafeVersion`;
- signed-policy signature, monotonic sequence, expiry, transaction binding, and
  stale offline-policy failures;
- helper crashes at each destructive journal phase and resumes the same logical
  `rollbackOperationId` without consuming another attempt;
- rollback succeeds offline from the pinned release set;
- failed target is not offered or reinstalled again;
- active runs prevent replacement and rollback ownership conflicts;
- Email and GitHub encoding, public labeling, and secret exclusion;
- fresh-user fallback confirmation, cancellation, download failure, and retry;
- rollback itself fails and exposes a bounded manual-repair path without loops.

### Expected Results

Every eligible existing-user failure restores one healthy last-known-good
release with preserved data and one recovery notice. Every ineligible failure
stops before unsafe old-code access, preserves evidence, and explains the next
operator action. No test relies only on process launch or a mocked renderer.

### Pass / Fail

Pending implementation. The capability is not complete until packaged black-box
coverage passes for the full candidate-to-rollback sequence.

## Documentation Changes

When implementation lands:

- add `CONTROL.DESKTOP.UPDATE.ROLLBACK.001` under
  `doc/product/domains/operating-layer/` and register it in
  `doc/product/registry.yml`;
- make `ORG.DESKTOP.UPDATE.001` reference candidate probation, commit,
  quarantine, and rollback ownership;
- make `CONTROL.DESKTOP.STARTUP.RECOVERY.001` reference update rollback while
  retaining ownership of failure presentation and feedback;
- update Desktop engineering, release, and public troubleshooting docs with the
  supported recovery matrix and exact limitations.

The Product Logic Registry describes implemented current behavior, so the new
active contract should be added with the implementation rather than by this
proposal alone.

## Open Issues

The proposal recommends the following defaults for implementation approval:

1. Existing users auto-rollback without confirmation when every safety gate
   passes: **yes**.
2. First MVP is limited to packaged local/default Desktop with embedded
   PostgreSQL: **yes**.
3. Candidate probation blocks all normal writes and work execution until commit:
   **yes**.
