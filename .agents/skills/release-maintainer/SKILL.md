---
name: release-maintainer
description: >
  Maintain and execute Rudder releases across npm, GitHub Releases, and Desktop
  installers. Use this skill whenever the user asks about 发版, release,
  publishing to npm, canary/stable promotion, GitHub Release assets, Desktop
  distribution, `npx @rudder/cli@latest start`, version bumps, rollback, or
  release workflow failures. Prefer this skill for both planning and hands-on
  release operations in the Rudder repository, even when the user only asks
  "现在要做什么" or "帮我发版".
---

# Release Maintainer

Help the user ship Rudder without losing track of release surfaces.

Rudder's release model has several moving parts: npm packages, git tags, GitHub
Releases, Desktop installers, release notes, and smoke tests. Your job is to
turn the current repo and remote state into a concrete release plan, then
execute only the steps the user has authorized.

## First Principles

- npm publishes the CLI and public runtime/workspace packages.
- Desktop binaries are GitHub Release assets, not npm packages.
- The stable user entrypoint is `npx @rudder/cli@latest start`.
- After the persistent CLI exists, `rudder <command>` and
  `npx @rudder/cli@latest <command>` are the same CLI surface when they resolve
  to the same CLI version. The `npx` form is the first-run or explicit dist-tag
  form.
- Canaries publish from `main` automatically and use npm dist-tag `canary`.
- Stables are manually promoted from an explicitly chosen source ref and use
  npm dist-tag `latest`.
- Stable tags point at the original source commit, not at a generated release
  commit.
- A stable release is not done until verification, npm, GitHub Release, Desktop
  assets, and public notes/announcement are all handled.

## Required Context

Start by reading only the context needed for the user's request:

- `doc/RELEASING.md` for the main maintainer runbook.
- `doc/PUBLISHING.md` for npm/package internals.
- `doc/RELEASE-AUTOMATION-SETUP.md` for one-time GitHub/npm setup.
- `.github/workflows/release.yml` when diagnosing canary/stable workflow behavior.
- `.github/workflows/desktop-release.yml` when diagnosing Desktop artifacts.
- `scripts/release.sh`, `scripts/release-package-map.mjs`,
  `scripts/create-github-release.sh`, and `scripts/rollback-latest.sh` when
  you need exact command behavior.

Use live checks for anything that may have changed, such as npm package
versions, GitHub Actions status, tags, and Release assets. Do not rely on
memory for those.

## Fast State Check

Before giving release instructions, collect the current state when local tools
are available:

```bash
git status --short --branch
git log --oneline --decorate --graph -8
git tag --list 'v*' --sort=-version:refname | head -10
node scripts/release-package-map.mjs list
./scripts/release.sh stable --print-version
```

When the task depends on remote truth, also check:

```bash
gh workflow list
gh run list --workflow release.yml --limit 10
gh run list --workflow desktop-release.yml --limit 10
npm view @rudder/cli dist-tags --json
npm view @rudder/cli versions --json
```

If the worktree has unrelated dirty files, explicitly say you will ignore them
and only touch release files needed for the task.

## Decision Flow

### One-Time Setup

Use this when the user is preparing release automation for the first time.

1. Confirm `.github/workflows/release.yml`,
   `.github/workflows/desktop-release.yml`, and `.github/CODEOWNERS` are merged
   to `main`.
2. Confirm npm package existence for every public package:
   `node scripts/release-package-map.mjs list`.
3. If packages already exist, configure npm trusted publishing for each package
   with repository `Undertone0809/rudder` and workflow `.github/workflows/release.yml`.
4. If packages do not exist, explain that a bootstrap publish is needed before
   trusted publishing can be attached to those package names.
5. Configure GitHub environments:
   - `npm-canary`: no reviewer, selected branch `main`.
   - `npm-stable`: maintainer approval, selected branch `main`.
6. Keep long-lived `NPM_TOKEN` out of the steady-state workflow once trusted
   publishing is verified.

### Canary Release

Canary releases should normally be automatic.

1. Confirm the change is merged to `main`.
2. Watch the `Release` workflow canary job.
3. Confirm npm `canary` points at the new prerelease.
4. Confirm tag `canary/vX.Y.Z-canary.N` exists.
5. Smoke test with:

```bash
npx @rudder/cli@canary onboard
```

If canary smoke fails, do not promote stable. Fix forward on `main`, wait for
the next canary, and smoke again.

### Stable Release

Prefer the GitHub Actions workflow over local stable publishing.

1. Pick a source ref: exact commit SHA, `main`, or a trusted canary source.
2. Confirm public packages all share the intended stable semver:

```bash
node scripts/release-package-map.mjs list
./scripts/release.sh stable --print-version
```

3. Confirm `releases/vX.Y.Z.md` exists on the source ref.
4. Run the `Release` workflow with `dry_run: true`.
5. If dry-run passes, rerun with `dry_run: false`.
6. Wait for or request `npm-stable` approval.
7. Verify npm `latest`, git tag `vX.Y.Z`, GitHub Release notes, Desktop release
   workflow, and assets.
8. Smoke test:

```bash
npx @rudder/cli@latest start --no-open
rudder start --no-open
```

The second command is only expected to work after the persistent CLI exists.

### Version Bump

Use this before the next stable line.

```bash
node scripts/release-package-map.mjs set-version X.Y.Z
pnpm -r typecheck
pnpm test:run
pnpm build
```

Then commit only the intended version and release-note changes.

### Rollback

Rollback moves npm `latest`; it does not unpublish packages or rewrite tags.

```bash
./scripts/rollback-latest.sh X.Y.Z --dry-run
./scripts/rollback-latest.sh X.Y.Z
```

After rollback, fix forward with a new stable semver.

### Partial Release Failures

- npm published but tag/GitHub Release failed: do not republish npm. Push or
  recreate the missing tag/release for the same version.
- GitHub Release exists but Desktop assets failed: rerun `desktop-release.yml`
  for the same `vX.Y.Z`; do not republish npm.
- Desktop assets exist but checksum missing or stale: rerun `desktop-release.yml`
  and verify `SHASUMS256.txt`.
- `latest` is broken: rollback the dist-tag, then fix forward.

## Safety Rules

- Do not run a real stable publish without an explicit user request.
- Do not unpublish npm packages as a rollback strategy.
- Do not republish an npm version that already exists.
- Do not force-push release tags unless the user explicitly approves the exact
  tag and reason.
- Do not treat a canary as a stable release.
- Do not claim a stable is complete until all release surfaces are verified.
- Do not edit unrelated dirty files; stage/commit only release-maintainer scope
  files for skill maintenance, or only release-scope files during release work.
- When using relative dates like "today", include the concrete date in the
  final release plan or report.

## Default Answer Shape

When the user asks "what do I do now?", answer in this order:

1. **Current State**: branch, target version, package versions, known workflow/tag/npm state.
2. **Blockers**: missing release notes, unmerged workflow, unconfigured npm trust,
   failing checks, dirty release files, or missing Desktop artifacts.
3. **Next Actions**: numbered, executable steps with exact commands or GitHub UI
   actions.
4. **Human Gates**: approvals, npm login/trusted-publisher setup, GitHub
   environment approval, announcement copy.
5. **Verification**: exact checks that prove the release surface is complete.

For hands-on release execution, keep short status updates while working, then
finish with:

- version/ref released or prepared
- what was verified
- what failed or remains manual
- exact links or commands for the next action

## Examples

**Stable readiness check**

User: `我要发 stable，现在要做什么？`

Expected behavior:
- inspect local and remote state
- identify target version with `./scripts/release.sh stable --print-version`
- require `releases/vX.Y.Z.md`
- recommend GitHub Actions dry-run before real publish
- include Desktop and npm verification steps

**Desktop failure**

User: `npm latest 已经发了，但是 mac/windows/linux 包没挂到 release 上。`

Expected behavior:
- treat as partial stable release
- do not republish npm
- rerun `desktop-release.yml` for the existing stable tag
- verify Release assets and `SHASUMS256.txt`

**Entrypoint confusion**

User: `npx @rudder/cli@latest start 和 rudder start 是什么关系？`

Expected behavior:
- explain they are the same CLI surface when versions match
- explain `npx` is first-run/dist-tag resolution and `rudder` is persistent
  direct execution
- remind that Desktop binaries still come from GitHub Releases
