---
title: Release Pipeline Latency And Version Handoff
date: 2026-07-22
kind: fix-plan
status: completed
area: deployment
entities:
  - release_automation
  - npm_publishing
  - desktop_release
  - version_handoff
issue:
related_plans:
  - 2026-03-17-release-automation-and-versioning.md
  - 2026-04-24-release-desktop-npm-distribution.md
supersedes: []
related_code:
  - .agents/skills/maintainer/release-maintainer/SKILL.md
  - .github/workflows/ci.yml
  - .github/workflows/release.yml
  - .github/workflows/desktop-release.yml
  - scripts/release.sh
  - scripts/release-lib.sh
commit_refs:
  - "perf(release): cut redundant release validation"
updated_at: 2026-07-22
---

# Release Pipeline Latency And Version Handoff

## Problem

Release automation repeats the full operating-system test matrix even when CI
already verified the exact source commit. A stale committed base version is
therefore discovered only after roughly twenty minutes of duplicated checks.
Stable and canary dispatches also use different concurrency groups, so they can
publish npm packages and build Desktop releases at the same time.

After a stable release, the repository remains on the just-published version
until a maintainer manually prepares the next patch version. During this gap,
every main-branch canary is guaranteed to fail.

## Scope

1. Start automatic canaries only after the main-branch CI workflow succeeds.
2. For manual stable requests, resolve the source to an immutable commit and
   require a successful CI run for that exact commit before release work.
3. Run version and authorization preflight before dependency installation or
   package builds.
4. Serialize npm/Desktop release orchestration across canary and stable jobs.
5. After a stable publish, create an idempotent pull request that advances all
   public packages to the next patch base.
6. Cache the prepared PostgreSQL 18.4 Desktop runtime payload on macOS and
   Windows runners.
7. Update the repository release skill and release documentation so the
   version handoff is part of the normal completion contract.
8. Keep source-ref preflight and dry-run jobs read-only, and fail closed until
   repository reviewers, branch protection, and Actions pull-request creation
   have been configured and attested.

Cross-run npm tarball promotion is intentionally excluded. npm publication is
not transactional, so promoting a dry-run artifact needs a separate candidate
manifest, digest verification, retention policy, and partial-publish recovery
design before it can safely replace the current build path.

Resumable partial npm publication is also deferred to that candidate design.
The current per-package publish is not transactional; adding a skip-existing
mode without verifying package digests/provenance could attach a release tag to
the wrong immutable payload.

## Safety Constraints

- This change must not trigger a canary or stable publication during local
  verification.
- A real stable publish still requires the exact `PUBLISH STABLE` confirmation.
- CI reuse is valid only for the exact immutable source commit and a successful
  `CI` workflow conclusion.
- The post-stable version change is proposed through a pull request, never
  pushed directly to protected `main`.
- Failure to open the follow-up pull request must be visible, but must not
  pretend an already-published stable release was rolled back.

## Regression Coverage

- Static workflow contract tests for the CI handoff, early preflight,
  cross-channel concurrency, and Desktop runtime cache.
- Unit tests for next-patch planning and idempotent version-bump behavior.
- Existing canary guard tests continue to prove stale stable bases fail before
  canary derivation.
- Black-box checks run the new version-handoff helper in temporary git
  repositories without contacting production services.

## Validation

- targeted release-script tests
- workflow YAML parse and action linting when available
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- independent release review and black-box verification

## Rollback

Revert the workflow and helper commit. No schema, migration, or persisted user
data is involved. Existing stable tags and npm versions remain immutable.

## Validation Results

- Passed: release workflow and script regression suite (22 focused tests).
- Passed: `actionlint v1.7.12` for CI, Release, and Desktop Release workflows.
- Passed: `bash -n scripts/release.sh` and
  `node --check scripts/prepare-next-release.mjs`.
- Passed: `pnpm -r typecheck`.
- Passed: `pnpm build`.
- Passed: `pnpm product-logic:check` and `pnpm product-logic:test`.
- Passed: `pnpm lint:changed`.
- Known repository baseline: `pnpm lint` reports the pre-existing import order
  in `ui/src/pages/Chat.workspace-helpers.test.tsx`, outside this change.
- Full serial tests: 559 files passed; only
  `server/src/__tests__/heartbeat-run-concurrency.test.ts` failed two timing
  waits. The focused release suite passes independently.
- Independent release review and black-box verification found no remaining
  blocking P0/P1 issues.
