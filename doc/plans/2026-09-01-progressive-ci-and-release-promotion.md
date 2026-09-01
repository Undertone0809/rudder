---
title: Progressive CI Qualification And Immutable Release Promotion
date: 2026-09-01
kind: proposal
status: proposed
area: developer_workflow
entities:
  - ci_workflow
  - release_pipeline
  - github_actions
  - release_candidate
issue:
related_plans:
  - 2026-05-01-cross-platform-github-actions-ci.md
  - 2026-07-22-release-pipeline-latency.md
  - 2026-08-13-unified-release-ci.md
supersedes: []
related_code:
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - .github/workflows/docs-production.yml
  - .github/CODEOWNERS
  - scripts/release-workflow-contract.test.mjs
  - scripts/release-package-map.mjs
  - scripts/release.sh
  - doc/engineering/RELEASING.md
  - doc/engineering/RELEASE-AUTOMATION-SETUP.md
commit_refs: []
updated_at: 2026-09-01
---

# Progressive CI Qualification And Immutable Release Promotion

## Overview

Rudder should keep `main` continuously releasable, give ordinary pull requests
fast and relevant feedback, perform exhaustive qualification once at the merge
boundary, and publish the exact immutable artifacts that were already built and
accepted.

The governing objective is not a fixed duration. It is to minimize the real
critical path to a correct stable release without weakening product,
cross-platform, packaged-runtime, recovery, or public-surface evidence.

This proposal did not modify the `0.7.16` release. Release run `33480587746`
completed successfully under the existing workflow for exact source
`5266e8c2ef60f3fe28fbd431e8d681c9004a9758`, including public-surface
verification, canary cleanup, and the `0.7.17` base handoff. Repository
implementation therefore starts from that post-release `0.7.17` base.

## What Is The Problem?

### Release has become a development environment

The `0.7.16` campaign repeatedly found Windows, macOS x64, PostgreSQL isolation,
workspace build concurrency, native-test contention, and packaged Terminal
qualification problems after release work had already started. Each source
repair created a new candidate SHA and correctly invalidated prior CI,
reviewer, verifier, and delivery receipts. The identity rule is sound, but the
late discovery point made every repair expensive.

### `main` is not protected as a releasable invariant

As observed on 2026-09-01:

- GitHub reports no branch protection and no repository ruleset for `main`.
- Among the latest 50 `Test` runs, 34 were `main` push runs; 2 succeeded, 15
  failed, and 16 were cancelled by later pushes.
- The final exact-source `0.7.16` Test run `33476601754` succeeded, but took
  about 45 minutes from dispatch to completion.

Cancelled runs are not automatically defects, but this distribution proves
that direct `main` pushes and post-push qualification allow `main` to spend
substantial time without a current green receipt.

### Every pull request pays for unrelated heavy checks

The current `Test` workflow triggers the same broad job graph for every
`pull_request`. A narrow UI change can start docs qualification, three operating
system builds, four native-foundation jobs, and packaged Desktop smoke even
when those surfaces are not in its dependency or risk path. This delays useful
feedback and encourages bypass pressure.

### Stable rebuilds work that should already be immutable

Exact-source Test qualifies source behavior, while Release installs dependencies
again and builds the npm and four-platform Desktop candidates in the publication
run. This is safer than publishing unqualified output, but it leaves stable
publication responsible for construction and discovery instead of promotion.

The 2026-07-22 latency plan intentionally deferred cross-run artifact promotion
because the repository did not yet have a candidate manifest, digest
verification, retention contract, or partial-publish recovery design. Those
missing contracts must be implemented before promotion replaces rebuilds.

## First-Principles Decisions

1. The release goal remains active until the requested version is released or
   an external authority/resource makes completion impossible. A failure changes
   the execution state; it does not abandon the outcome.
2. `main` is an always-releasable integration boundary, not a remote test bench.
3. Fast feedback and exhaustive qualification belong at different lifecycle
   points and should share test definitions without sharing the same cost.
4. Stable publishes bytes, not confidence. Every published byte must match an
   accepted candidate manifest bound to one source SHA and workflow identity.
5. Repeating the same failed input is not progress. Diagnose unchanged-input
   failures; repair changed inputs; continue toward release.
6. Duration is an observed optimization signal, not a pass/fail contract.

## What Will Be Changed?

### 1. Protect `main` after the qualifying check exists

Create a GitHub ruleset for `main` only after the repository contains and has
verified the new aggregate check.

The ruleset will:

- require pull requests;
- require merge queue when the repository plan supports it;
- require one stable check name, `Qualification summary`;
- require branches to be current before merge;
- block force pushes and deletion;
- block direct human pushes;
- restrict bypass to a dedicated release automation identity, if a bypass is
  still needed after next-version handoff is converted to a pull request.

Do not enable protection before `merge_group` handling and the aggregate check
have passed live dry-run verification. Otherwise protection could deadlock
merges or the post-stable version handoff.

### 2. Add progressive qualification profiles

Keep `Test` as the visible workflow. Add `merge_group` to its triggers and use
one repository-owned impact planner to select a qualification profile.

Proposed profiles:

| Profile | Trigger | Purpose |
| --- | --- | --- |
| `pr_affected` | pull request synchronize/open/reopen | Fast, dependency-aware feedback for the changed surface |
| `merge_full` | merge queue synthetic commit | Exhaustive cross-platform qualification for the exact merge candidate |
| `exact_source` | trusted workflow dispatch | Requalification for a named immutable release or recovery source |
| `main_attest` | push to `main` | Confirm the integrated SHA and begin release-candidate construction |

The impact planner should be a deterministic script, for example
`scripts/ci-impact-plan.mjs`, with fixture tests. It should output the selected
profile, required job families, changed ownership areas, escalation reasons,
and comparison SHA.

`pr_affected` always runs cheap repository invariants plus affected checks:

- architecture regression check;
- formatting/lint for changed source;
- typecheck/build for affected workspace packages and their dependents;
- focused unit/integration tests for affected packages;
- relevant browser E2E for changed user-visible workflows;
- workflow contract tests when workflow/release files change.

The planner escalates to full qualification when impact cannot be bounded or
when changes include shared contracts, lockfiles, database schema/migrations,
native code, Desktop packaging/startup, release workflows, or other explicitly
high-blast-radius roots.

A normal UI-only change must not start unrelated native x64 or packaged release
jobs. A change to `packages/shared`, package resolution, Desktop/native, DB, or
workflow control must fail closed into broader qualification.

`merge_full` runs the complete existing Test graph exactly once when a reviewed
PR enters the merge queue. Pull-request iteration therefore remains fast while
the repository still prevents unqualified merges.

### 3. Use one aggregate required check

Add a final `Qualification summary` job that runs with `if: always()` and knows
the selected profile. It passes only when every job family required by that
profile passed and every non-required job was intentionally skipped.

Branch protection depends on this one stable name rather than individual
matrix labels. The summary must print the profile, required jobs, conclusions,
source SHA, comparison SHA, and impact-plan digest.

### 4. Build an attested stable release candidate from green `main`

After the integrated `main` SHA has a successful full qualification receipt,
construct the stable-version npm tarballs and Desktop artifacts without
publishing them. Store a candidate manifest with:

- source commit and tree SHA;
- release version;
- qualification run ID and conclusion;
- candidate workflow run ID and workflow source SHA;
- Node, pnpm, Rust, Electron, and packaging identities where relevant;
- every npm package name, version, filename, size, and SHA-256;
- every Desktop filename, platform, architecture, size, and SHA-256;
- checksum file digest;
- packaged-smoke scenarios and terminal conclusions;
- artifact retention expiry.

The candidate run remains read-only. It must not publish npm, create or move a
tag, create a GitHub Release, deploy docs, clean canaries, or contact Tencent
COS.

### 5. Promote only an accepted candidate

Extend manual stable dispatch with an immutable candidate run identity. Stable
preflight must download the manifest and verify:

- candidate source equals the requested full source SHA;
- source is reachable from `main` history;
- exact-source qualification succeeded;
- version matches committed package and release-note identity;
- every downloaded artifact matches its manifest digest;
- the candidate was produced by the trusted workflow on the expected default
  branch workflow definition;
- public npm versions and stable tag do not already conflict;
- the requested COS policy is explicit.

When `mirror_cos=false`, stable must continue through `checksum-stable`, skip
all Tencent credentials and jobs, and publish the verified GitHub checksum
marker directly.

Stable then publishes the exact candidate artifacts. It must not run package or
Desktop builds. Partial recovery uses the same candidate manifest and resumes
from the first missing public surface without republishing immutable npm
versions.

### 6. Keep one release objective through repair and recovery

Represent the campaign as a state machine:

```text
QUALIFYING -> CANDIDATE_READY -> PUBLISHING -> VERIFYING -> RELEASED
      |              |              |
      v              v              v
  REPAIRING      REPAIRING       RECOVERING
      |              |              |
      +----------> QUALIFYING <------+
```

- An unchanged-input repeat is allowed only for a classified transient
  infrastructure failure and must retain both observations.
- A source, workflow, or harness repair creates a new named identity and reruns
  only the evidence invalidated by that change.
- A product artifact change invalidates all artifact-dependent evidence.
- A verifier-harness-only change invalidates verifier evidence, not unrelated
  source review, provided product artifact identity is independently unchanged.
- A release-workflow change invalidates control-plane qualification and requires
  workflow contract plus dry-run evidence.
- Once any immutable public package exists, recovery never rebuilds or
  republishes it.

The owner continues the same release goal across these states. `REPAIRING` is a
mode of progress, not a terminal failure or a handoff with no owner.

### 7. Measure before setting expectations

Record structured timing and result data for each job family and lifecycle
transition. Use rolling distributions and critical-path analysis to identify
regressions, repeated setup, cache misses, and platform-specific contention.

Do not make an arbitrary elapsed-time number a correctness gate. A stable
10-minute-30-second path is acceptable when it is the optimized measured path;
a faster path is not acceptable if it drops required evidence. Optimize the
largest measured repeated cost first.

## Success Criteria For Change

- `main` has an active ruleset that requires pull requests and the aggregate
  qualification check, and ordinary direct pushes are rejected.
- `Test` handles `merge_group` and qualifies the exact synthetic merge commit.
- An isolated UI-only fixture selects `pr_affected` without native or packaged
  release jobs while still running its affected UI tests and E2E.
- Shared, lockfile, DB, Desktop/native, and workflow fixtures escalate to full
  qualification.
- `Qualification summary` rejects a missing, failed, or unexpectedly skipped
  required job and accepts intentional non-required skips.
- A green `main` SHA produces one complete candidate manifest and artifact
  family without any public mutation.
- Stable dry-run downloads that candidate, verifies every digest and identity,
  and performs no rebuild or public mutation.
- A real stable promotion publishes byte-identical candidate artifacts and
  completes npm, tag, GitHub Release, checksum, docs, install, cleanup, and
  next-version handoff evidence.
- COS-off dry-run and real promotion do not request Tencent credentials or run
  mirror jobs.
- Source repair, harness repair, infrastructure retry, and partial-publication
  fixtures enter the correct continuing state without abandoning the release
  objective or reusing stale evidence.
- Timing reports identify actual critical paths but do not fail a correct run
  solely because it exceeded a theoretical duration.

## Rollout And Current Release Isolation

### Phase 0: Preserve `0.7.16` (completed)

- The locked `0.7.16` source, workflows, GitHub rules, and release environments
  were not changed by this proposal during run `33480587746`.
- The run reached terminal success with public-surface, cleanup, and
  next-release handoff receipts.
- This proposal remains isolated on its own branch from the `0.7.17` base.

### Phase 1: Progressive Test and protected `main`

After `0.7.16` completion:

1. implement the impact planner, `merge_group` trigger, conditional job
   families, aggregate summary, and contract tests on an isolated branch;
2. exercise representative UI-only, shared-contract, DB, Desktop/native, docs,
   and workflow fixtures without changing GitHub rules;
3. merge the verified workflow implementation;
4. create the `main` ruleset requiring `Qualification summary` and merge queue;
5. verify PR merge, direct-push rejection, queue qualification, and controlled
   release-automation behavior.

### Phase 2: Candidate manifest and read-only promotion rehearsal

1. build the candidate manifest and immutable artifact upload path;
2. run it against a `0.7.17`-line green source without publication;
3. run stable dry-run using the candidate run identity;
4. independently verify source, workflow, manifest, downloaded bytes, packaged
   smoke evidence, retention, and zero-public-mutation behavior;
5. keep the current stable rebuild path available as rollback.

### Phase 3: Enable build-once stable promotion

Enable candidate promotion for a real stable release only after Phase 2 has an
accepted reviewer receipt and black-box verifier PASS on the exact workflow and
candidate format. If that evidence is not ready for `0.7.17`, release `0.7.17`
through the current known-safe workflow and continue the rollout. Do not make a
real release the first test of the new promotion path.

### Phase 4: Remove redundant construction

After one successful candidate promotion and recovery rehearsal:

- remove stable rebuild paths that duplicate candidate construction;
- retain explicit partial recovery from the accepted manifest;
- update release documentation and maintainer skill guidance;
- compare observed feedback and critical-path data before further optimization.

## Out Of Scope

- changing or restarting the active `0.7.16` release;
- weakening exact-source, cross-platform, packaged-runtime, migration, public
  install, checksum, or public-surface gates;
- changing current product behavior or `doc/product/**` contracts;
- changing npm package names, version semantics, or public update channels;
- enabling Tencent COS by default;
- treating elapsed time alone as success or failure;
- replacing GitHub Actions with another CI provider before measured evidence
  shows the provider is the limiting factor.

## Non-Functional Requirements

- **Correctness:** required evidence remains bound to explicit source,
  artifact, workflow, harness, and run identities.
- **Fast feedback:** ordinary PR iterations run only always-required and
  dependency-affected checks; uncertainty escalates rather than silently
  omitting risk.
- **Availability:** infrastructure failures are classified and retryable without
  turning product failures into flaky passes.
- **Security:** workflow and release-script changes remain CODEOWNERS-governed;
  npm trusted publishing and environment boundaries remain unchanged.
- **Maintainability:** one impact planner and one aggregate result own selection
  semantics; workflows do not duplicate risk rules in many `if` expressions.
- **Observability:** every selection, skip, retry, state transition, and artifact
  digest is inspectable.
- **Recoverability:** current stable rebuild remains available until candidate
  promotion and recovery have independent acceptance evidence.

## User Experience Walkthrough

### Contributor

1. Open a UI-only pull request.
2. Receive fast UI-scoped checks with a visible explanation of why unrelated
   native and packaged jobs were skipped.
3. Mark the reviewed pull request ready; merge queue runs complete
   cross-platform qualification once on the exact merge candidate.
4. Merge occurs only after `Qualification summary` passes.

### Release operator

1. Select the intended stable version and green source.
2. See the candidate run, manifest digest, qualification receipt, artifact
   family, and COS policy before mutation.
3. Start stable promotion.
4. The workflow verifies and publishes the existing candidate bytes, then
   verifies every public surface.
5. If a stage fails, the same release objective enters repair or recovery and
   resumes from the earliest invalid or missing boundary.

## Implementation

### Product Or Technical Architecture Changes

The proposal changes contributor and release control planes only. It adds no
product API, database schema, runtime protocol, or user-facing behavior.

The intended ownership split is:

```text
changed source + dependency graph
              |
              v
       CI impact planner
              |
              v
 conditional job families -> Qualification summary -> merge permission
                                                        |
                                                        v
                                            immutable candidate builder
                                                        |
                                                        v
                                            manifest-bound promotion
```

Selection policy lives in a tested script. Execution stays in the current
`Test`, `Release`, and `Docs Release` workflows so the public workflow surface
does not grow merely to express internal profiles.

### Breaking Change

There is no product, API, runtime, or storage breaking change. Contributor
behavior changes when branch protection is activated: direct human pushes to
`main` stop working and changes must use a pull request plus merge queue.

The post-stable next-version handoff must either use a protected automation
identity with narrow bypass or create an automatically mergeable pull request.
The implementation must choose and verify one path before protection is
enabled.

### Security

- Introduce no new third-party runtime dependency for the impact planner.
- Keep npm OIDC trusted publishing and existing environment isolation.
- Keep Tencent OIDC unavailable to COS-off jobs.
- Limit any ruleset bypass to a dedicated GitHub App or workflow identity; do
  not grant broad administrator bypass.
- Verify downloaded candidate artifacts by digest before any publish command.
- Treat workflow source identity as part of candidate provenance so an artifact
  built by an untrusted workflow revision cannot be promoted silently.

## What Is Your Testing Plan (QA)?

### Goal

Prove that feedback is selectively faster without weakening merge or release
qualification, and that stable promotion publishes the exact accepted bytes.

### Prerequisites

- a clean isolated worktree based on the post-`0.7.16` next-version source;
- GitHub Actions access for branch and workflow verification;
- npm and GitHub release operations disabled for all rehearsals;
- current release workflow retained as rollback during rollout;
- no Tencent credentials exposed to COS-off tests.

### Test Scenarios / Cases

- impact-plan fixtures for UI-only, docs-only, shared package, lockfile, DB
  migration, Desktop, native, and workflow changes;
- dependency-chain fixture where a shared package affects server, CLI, and UI;
- uncertain/malformed comparison input escalating to full qualification;
- aggregate summary with pass, failure, cancellation, required skip, and
  intentional non-required skip combinations;
- real PR fast run and real merge-queue full run;
- branch rules API readback and controlled direct-push rejection evidence;
- candidate manifest with missing file, wrong digest, wrong version, wrong
  source, expired artifact, and untrusted workflow identity;
- stable dry-run proving zero npm/tag/Release/docs/COS mutation;
- byte-for-byte comparison between candidate files and promotion inputs;
- repair flow after source change, harness-only change, and classified
  infrastructure failure;
- recovery after simulated partial npm/GitHub/docs completion without duplicate
  immutable publication;
- COS-off checksum path and explicit COS-on path kept separate.

### Expected Results

- narrow PRs receive relevant feedback without unrelated heavy jobs;
- merge queue remains exhaustive and fail-closed;
- protected `main` contains only qualified merge candidates;
- candidate construction is read-only and fully attested;
- stable promotion uses candidate bytes without rebuilding;
- failure changes state and evidence scope while preserving one release owner
  and objective;
- current `0.7.16` receipts remain unchanged.

### Pass / Fail

Implementation evidence is intentionally pending. Each rollout phase requires
the repository validation appropriate to its changed files, workflow contract
tests, a stage reviewer verdict, exact-candidate black-box verification, and a
final reviewer verdict before activation.

## Documentation Changes

If implemented, update:

- `doc/engineering/DEVELOPING.md` for PR Fast, merge queue, and protected-main
  contributor behavior;
- `doc/engineering/RELEASING.md` for candidate construction, promotion, repair,
  and recovery states;
- `doc/engineering/RELEASE-AUTOMATION-SETUP.md` for rulesets and automation
  bypass configuration;
- `.agents/skills/maintainer/release-maintainer/**` for candidate manifests and
  promotion evidence;
- `AGENTS.md` if contributor verification commands or commit/push expectations
  change.

No `doc/product/**` edit is expected because this proposal changes engineering
delivery control rather than product behavior.

## Open Issues

1. Confirm merge queue availability for the repository plan. If unavailable,
   design an equivalent protected pre-merge full-qualification check without
   allowing a stale PR head to merge.
2. Choose the protected next-version handoff mechanism: narrow GitHub App
   bypass or generated pull request. Prefer the pull request unless measured
   operational evidence requires direct automation.
3. Set artifact retention from observed release cadence and recovery needs;
   do not use a theoretical duration that can expire the newest accepted
   candidate before promotion.
4. Define the trusted workflow identity and provenance check supported by the
   current GitHub artifact APIs.
5. Determine whether candidate construction belongs at the end of `Test` or in
   a read-only mode of `Release` while retaining only three visible workflows.
6. Decide how to compare source-review and verifier-harness identities without
   weakening exact published-artifact binding.
