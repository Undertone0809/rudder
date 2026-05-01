---
title: Cross-Platform GitHub Actions CI
date: 2026-05-01
kind: implementation
status: completed
area: developer_workflow
entities:
  - ci_workflow
  - github_actions
issue:
related_plans:
  - 2026-04-24-release-desktop-npm-distribution.md
  - 2026-04-27-unified-npx-portable-desktop-install.md
supersedes: []
related_code:
  - .github/workflows/ci.yml
  - doc/DEVELOPING.md
commit_refs:
  - ci: add cross-platform verification workflow
updated_at: 2026-05-01
---

# Cross-Platform GitHub Actions CI

## Summary

Add a normal GitHub Actions CI gate that verifies Rudder on Linux, macOS, and
Windows before release automation is involved. The intended end state is that
pull requests, `main` pushes, and manual runs all prove the repository can
install dependencies, typecheck, run unit tests, and build on the three hosted
operating systems.

## Problem

The release workflow already publishes npm packages and dispatches Desktop
release builds, and the Desktop release workflow already builds portable assets
on macOS, Windows, and Linux. That is release-path coverage, not day-to-day
CI coverage. There is no standalone PR/main quality gate showing that the
normal development verification commands work across the three supported
operator platforms.

## Scope

- In scope: a new `.github/workflows/ci.yml` workflow with a three-OS matrix.
- In scope: install, typecheck, unit test, and build checks using existing repo
  scripts.
- In scope: following the existing lockfile policy from `doc/DEVELOPING.md`.
- Out of scope: packaging Desktop release assets; that remains owned by
  `.github/workflows/desktop-release.yml`.
- Out of scope: browser E2E and release-smoke jobs; those can be added as
  separate workflow lanes once the basic cross-platform CI baseline is stable.

## Implementation Plan

1. Add `.github/workflows/ci.yml`.
2. Trigger it on `pull_request`, `push` to `main`, and `workflow_dispatch`.
3. Use a matrix of `ubuntu-latest`, `macos-latest`, and `windows-latest`.
4. Set `fail-fast: false` so one platform failure does not hide the others.
5. Use Node 24 and pnpm 9.15.4, matching the release workflows.
6. Run:
   - `pnpm install --no-frozen-lockfile --lockfile=false`
   - `pnpm -r typecheck`
   - `pnpm test:run --maxWorkers=1`
   - `pnpm build`
7. Parse workflow YAML locally and run the standard local verification commands
   before hand-off.

## Design Notes

The workflow should use Bash for `run` steps on all platforms. Some package
scripts currently use POSIX commands such as `chmod` and `mkdir -p`; Windows
hosted runners include Git Bash, while Node still reports `process.platform` as
`win32` for platform-sensitive tests.

The dependency install command intentionally follows the repository's current
GitHub Actions policy: PR and `main` CI install without relying on a committed
lockfile mutation path.

The unit-test step intentionally bounds Vitest to one worker in CI. Several
test projects initialize embedded PostgreSQL clusters; a strict OS matrix should
produce platform signal, not fail because too many local clusters are starting
at once on a hosted runner.

## Success Criteria

- CI exposes separate Linux, macOS, and Windows job results.
- All three jobs run the same install, typecheck, test, and build phases.
- Desktop release packaging remains separate from normal CI.
- The new workflow is valid YAML.
- Local verification passes or any unrelated failures are recorded.

## Validation

- Passed: parsed `.github/workflows/ci.yml` with Ruby YAML.
- Passed: `pnpm -r typecheck`.
- Passed: `pnpm test:run --maxWorkers=1`.
- Passed: `pnpm build`.
- Failed as expected under local resource pressure: unbounded `pnpm test:run`
  and `pnpm test:run --maxWorkers=2` hit embedded PostgreSQL initialization
  failures. This is why CI starts with a single Vitest worker.

## Open Issues

- If the first GitHub-hosted Windows or macOS run exposes existing
  platform-specific failures, those should be fixed as follow-up CI hardening
  work rather than weakening the matrix.
