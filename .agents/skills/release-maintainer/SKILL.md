---
name: release-maintainer
description: >
  Maintain and execute Rudder releases across npm, GitHub Releases, and Desktop
  portable assets. Use this skill whenever the user asks about 发版, release,
  publishing to npm, canary/stable promotion, GitHub Release assets, Desktop
  distribution, `npx @rudderhq/cli@latest start`, `npx @rudderhq/cli start`,
  version bumps, rollback, first-time package bootstrap, npm token-based
  fallback publishing, or release workflow failures. Prefer this skill for both
  planning and hands-on release operations in the Rudder repository, even when
  the user only asks "现在要做什么" or "帮我发版".
---

# Release Maintainer

Help the user ship Rudder without losing track of release surfaces.

Rudder's release model has several moving parts: npm packages, git tags, GitHub
Releases, Desktop portable assets, release notes, and smoke tests. Your job is to
turn the current repo and remote state into a concrete release plan, then
execute only the steps the user has authorized.

When the user authorizes hands-on release work, operate with local and remote
tools instead of stopping at guidance. Prefer `git`, `gh`, `npm`, and repository
scripts for discoverable state. Ask the user only for secrets or decisions that
cannot be safely inferred.

## First Principles

- npm publishes the CLI and public runtime/workspace packages.
- Desktop binaries are GitHub Release assets, not npm packages.
- Canary git tags keep the `canary/` namespace, for example
  `canary/v0.1.0-canary.2`, but the GitHub Release display title should be the
  clean version name, for example `v0.1.0-canary.2`.
- The public npm scope is `@rudderhq`. Treat old examples using `@rudder` as
  stale unless the repository explicitly reintroduces that scope.
- The stable user entrypoint is `npx @rudderhq/cli@latest start`. Bare
  `npx @rudderhq/cli start` resolves npm's `latest` dist-tag.
- After the persistent CLI exists, `rudder <command>` and
  `npx @rudderhq/cli@latest <command>` are the same CLI surface when they resolve
  to the same CLI version. The `npx` form is the first-run or explicit dist-tag
  form.
- Canaries publish from `main` automatically and use npm dist-tag `canary`.
- Canary git tags use `canary/vX.Y.Z-canary.N`. The matching GitHub Release
  display title should be clean `vX.Y.Z-canary.N`, not the full tag name, and
  it should be marked prerelease.
- A tag pushed by GitHub Actions' `GITHUB_TOKEN` does not trigger another
  workflow by itself. If canary npm publish creates the tag, `release.yml` must
  explicitly dispatch `desktop-release.yml`, or the maintainer must do it.
- Stables are manually promoted from an explicitly chosen source ref and use
  npm dist-tag `latest`.
- Stable tags point at the original source commit, not at a generated release
  commit.
- A stable release is not done until verification, npm, GitHub Release, Desktop
  assets, and public notes/announcement are all handled.
- Pre-stable public canaries may temporarily be the default `latest` install
  path if there is no stable npm version yet and the user explicitly wants
  `npx @rudderhq/cli@latest start` or bare `npx @rudderhq/cli start` to work
  immediately. Call this out as an alpha/bootstrap exception, not the normal
  canary policy.
- During the pre-stable bootstrap exception, npm `latest` must not move to a
  canary until the matching Desktop GitHub Release has all portable assets and
  `SHASUMS256.txt`. Otherwise `npx @rudderhq/cli@latest start` can resolve a CLI
  version whose Desktop release is not installable yet.
- Release-maintenance commits that should not publish another canary must
  include `[skip release]`, then be verified as skipped in `release.yml`.
- If a normal `main` push is already running while you make release-maintenance
  changes, watch it to completion. It may publish the next canary, and that
  canary still needs npm, tag, Desktop, and Release-title verification.

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

If the docs and live workflow disagree, inspect the workflow and scripts before
acting, then report the mismatch. The workflow is the executable truth during an
active release; docs should be updated after the release if policy changed.

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
gh release list --repo Undertone0809/rudder --limit 20
npm view @rudderhq/cli dist-tags --json
npm view @rudderhq/cli versions --json
```

If the worktree has unrelated dirty files, explicitly say you will ignore them
and only touch release files needed for the task.

For hands-on publishing from a dirty local repo, prefer a clean temporary clone
or worktree, then keep the user's main workspace untouched:

```bash
tmp="$(mktemp -d /tmp/rudder-release-XXXXXX)"
git clone <repo-url> "$tmp"
cd "$tmp"
git switch main
git pull --ff-only
```

Only stash or restore files in the user's main checkout when they explicitly
asked you to switch or sync that checkout. Never drop unrelated user changes.

## Decision Flow

### One-Time Setup

Use this when the user is preparing release automation for the first time.

1. Confirm `.github/workflows/release.yml`,
   `.github/workflows/desktop-release.yml`, and `.github/CODEOWNERS` are merged
   to `main`.
2. Confirm npm package existence for every public package:
   `node scripts/release-package-map.mjs list`.
3. If packages already exist, configure npm trusted publishing for each package
   with owner `Undertone0809`, repository `rudder`, and workflow filename
   `release.yml`. npm expects only the workflow filename, not the
   `.github/workflows/` path.
4. If packages do not exist, explain that a bootstrap publish is needed before
   trusted publishing can be attached to those package names.
5. Configure GitHub environments:
   - `npm-canary`: no reviewer, selected branch `main`.
   - `npm-stable`: maintainer approval, selected branch `main`.
6. If trusted publishing is not ready, add an environment secret named
   `NPM_TOKEN` to both release environments as a temporary fallback, using an
   npm automation token with publish access to the `@rudderhq` packages.
7. Keep long-lived `NPM_TOKEN` out of the steady-state workflow once trusted
   publishing is verified.

### First-Time npm Bootstrap

Use this when packages do not exist yet, trusted publishing cannot be attached
yet, or the user has explicitly provided a one-time npm token.

1. Confirm the package names with:

```bash
node scripts/release-package-map.mjs list
```

2. Check existing npm state for every package before publishing. Missing
   packages are expected on the first release; an existing version is a hard
   stop for that package/version.
3. If using a token, write it only to a temporary npmrc or environment-scoped
   npm config. Do not echo it, commit it, store it in shell history, or leave it
   behind. Remove the temp npmrc after publish and tell the user to revoke or
   rotate any token pasted into chat.
4. Publish all public packages in release-package-map order using the chosen
   version and dist-tag. Do not retry a package/version that npm already
   accepted; continue by verifying and repairing tags/releases instead.
5. For a pre-stable public canary where no stable npm version exists and the
   user wants `npx @rudderhq/cli@latest start` or bare `npx @rudderhq/cli start`
   to work, move both `canary` and `latest` to the same canary version across
   every public package. After the first stable release exists, ordinary
   canaries should only move `canary`.
6. Immediately verify all dist-tags across the whole package set with a script,
   not just `@rudderhq/cli`.

```bash
RUDDER_EXPECTED_VERSION=0.1.0-canary.1 RUDDER_VERIFY_LATEST=1 node - <<'NODE'
const { execFileSync } = require('node:child_process');
const expected = process.env.RUDDER_EXPECTED_VERSION;
const rows = execFileSync('node', ['scripts/release-package-map.mjs', 'list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
let failed = false;
for (const row of rows) {
  const pkg = row.split(/\s+/)[1];
  const tags = JSON.parse(execFileSync('npm', ['--prefer-online', 'view', pkg, 'dist-tags', '--json'], { encoding: 'utf8' }));
  const ok = tags.canary === expected && (!process.env.RUDDER_VERIFY_LATEST || tags.latest === expected);
  console.log(`${ok ? 'ok' : 'bad'}\t${pkg}\tlatest=${tags.latest}\tcanary=${tags.canary}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
NODE
```

### Canary Release

Canary releases should normally be automatic.

1. Confirm the change is merged to `main`.
2. Watch the `Release` workflow canary job. If the triggering commit is a
   release-maintenance commit with `[skip release]`, verify the run is skipped
   before assuming no canary was produced. For pre-stable public canaries, the
   canary job is not complete until it has dispatched the Desktop release,
   verified the Desktop assets, and only then promoted npm `latest`.
3. Confirm npm `canary` points at the new prerelease for every public package,
   not just `@rudderhq/cli`:

```bash
RUDDER_EXPECTED_VERSION=0.1.0-canary.N node - <<'NODE'
const { execFileSync } = require('node:child_process');
const expected = process.env.RUDDER_EXPECTED_VERSION;
const rows = execFileSync('node', ['scripts/release-package-map.mjs', 'list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
let failed = false;
for (const row of rows) {
  const pkg = row.split(/\s+/)[1];
  const version = execFileSync('npm', ['--prefer-online', 'view', `${pkg}@${expected}`, 'version'], { encoding: 'utf8' }).trim();
  const tags = JSON.parse(execFileSync('npm', ['--prefer-online', 'view', pkg, 'dist-tags', '--json'], { encoding: 'utf8' }));
  const ok = version === expected && tags.canary === expected;
  console.log(`${ok ? 'ok' : 'bad'}\t${pkg}\tversion=${version}\tlatest=${tags.latest}\tcanary=${tags.canary}`);
  if (!ok) failed = true;
}
process.exit(failed ? 1 : 0);
NODE
```

4. If no stable npm version exists yet, confirm npm `latest` also points at the
   same canary for every public package. If it does not, run the `npm Dist Tag`
   workflow for that version and verify again.
5. Confirm tag `canary/vX.Y.Z-canary.N` exists locally and remotely.
6. Confirm `desktop-release.yml` ran for the canary tag. If it did not, dispatch
   it explicitly; do not rely on the tag push to trigger it:

```bash
gh workflow run desktop-release.yml \
  --ref main \
  -f release_tag='canary/v0.1.0-canary.N' \
  -f source_ref=main
```

7. Verify the canary GitHub Release uses the clean display title
   `vX.Y.Z-canary.N`, is prerelease, and has all Desktop assets:

```bash
gh release view 'canary/v0.1.0-canary.N' \
  --repo Undertone0809/rudder \
  --json tagName,name,url,isPrerelease,isDraft,assets \
  --jq '{tagName,name,url,isPrerelease,isDraft,assets:[.assets[].name]}'
```

Expected canary Desktop assets:

- `Rudder-X.Y.Z-canary.N-linux-x64.AppImage`
- `Rudder-X.Y.Z-canary.N-macos-arm64-portable.zip`
- `Rudder-X.Y.Z-canary.N-macos-x64-portable.zip`
- `Rudder-X.Y.Z-canary.N-windows-x64-portable.zip`
- `SHASUMS256.txt`

8. Smoke test the actual start path with isolated HOME and npm cache:

```bash
tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-canary.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-canary.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli@canary start --dry-run --no-open
```

If canary smoke fails, do not promote stable. Fix forward on `main`, wait for
the next canary, and smoke again.

For pre-stable alpha releases, also smoke the user-facing `latest` path after
confirming the `latest` dist-tag moved:

```bash
tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-latest.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-latest.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli@latest start --dry-run --no-open
```

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
npx @rudderhq/cli@latest start --no-open
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
  for the same `vX.Y.Z` or `canary/vX.Y.Z-canary.N`; do not republish npm.
- GitHub Release title is `canary/vX.Y.Z-canary.N` or prerelease is false:

```bash
gh release edit 'canary/vX.Y.Z-canary.N' \
  --repo Undertone0809/rudder \
  --title 'vX.Y.Z-canary.N' \
  --prerelease
```

- Desktop assets exist but checksum missing or stale: rerun `desktop-release.yml`
  and verify `SHASUMS256.txt`.
- A failed or skipped run may be harmless, but only after checking whether a
  newer canary was already published. Check npm dist-tags, tags, and recent
  Release workflow runs before declaring no release happened.
- `latest` is broken: rollback the dist-tag, then fix forward.

Useful rerun command:

```bash
gh workflow run desktop-release.yml \
  --ref main \
  -f release_tag='canary/v0.1.0-canary.1' \
  -f source_ref=main
```

For Desktop releases, verify the Release object directly:

```bash
gh release view 'canary/v0.1.0-canary.1' \
  --repo Undertone0809/rudder \
  --json tagName,name,url,isPrerelease,isDraft,assets \
  --jq '{tagName,name,url,isPrerelease,isDraft,assets:[.assets[].name]}'
```

When Desktop packaging fails:

- macOS x64 should use the current Intel runner from the workflow, not an
  unavailable legacy runner label.
- canary macOS builds may be unsigned; verify `desktop/package.json` and the
  release policy before assuming signing is required.
- x64 DMG collection must look for the architecture-specific Electron Builder
  output such as `release/mac-x64` as well as any generic `release/mac` path.
- Windows builds frequently expose script portability problems; prefer Node
  scripts over shell-only assumptions in packaging steps.

### Final Release Verification

Before claiming a release is done, verify every surface that applies to the
channel:

```bash
git status --short --branch
node scripts/release-package-map.mjs list
npm view @rudderhq/cli dist-tags --json
gh release view '<tag>' --json tagName,url,isPrerelease,isDraft,assets
```

For first-public canary bootstrap where `latest` intentionally equals canary,
run both smoke checks:

```bash
tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-canary-start.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-canary-start.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli@canary start --dry-run --no-open

tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-latest-start.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-latest-start.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli start --dry-run --no-open
```

The smoke should show the resolved Rudder release tag, target platform/arch, and
the persistent CLI version it would install. If it still resolves an old npm
cache entry, rerun with an isolated `npm_config_cache` and `--prefer-online`.

## Safety Rules

- Do not run a real stable publish without an explicit user request.
- Do not unpublish npm packages as a rollback strategy.
- Do not republish an npm version that already exists.
- Do not force-push release tags unless the user explicitly approves the exact
  tag and reason.
- Do not treat a canary as a stable release.
- Do not claim a stable is complete until all release surfaces are verified.
- Do not claim a canary is complete until npm, tag, and Desktop assets are
  verified when the Desktop workflow is configured for canary tags. Also verify
  the GitHub Release title is clean and the Release is marked prerelease.
- Do not ignore already-running `release.yml` runs on `main`; they can publish a
  newer canary while you are repairing docs or automation.
- Do not edit unrelated dirty files; stage/commit only release-maintainer scope
  files for skill maintenance, or only release-scope files during release work.
- Do not print npm tokens in logs or final answers. If a token was pasted into
  the conversation, finish by telling the user to revoke or rotate it.
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
- GitHub Actions run IDs for the release and Desktop workflows when publishing
  was involved
- GitHub Release URL/title, npm dist-tag state, and whether Desktop assets match
  the expected set
- whether the local working tree was left clean, or which unrelated files were
  already dirty and preserved
- a token rotation reminder if token-based publishing was used

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

User: `npx @rudderhq/cli@latest start 和 rudder start 是什么关系？`

Expected behavior:
- explain they are the same CLI surface when versions match
- explain `npx` is first-run/dist-tag resolution and `rudder` is persistent
  direct execution
- remind that Desktop binaries still come from GitHub Releases

**First canary bootstrap**

User: `之前没发过这些包，这是第一次发包。我要 0.1.0 canary，并且 npx @rudderhq/cli start 要能直接跑。`

Expected behavior:
- use `@rudderhq/*` package names from `scripts/release-package-map.mjs`
- detect that trusted publishing cannot exist until package names exist
- if the user provides/authorizes an npm token, use a temporary npmrc and remove
  it after publishing
- publish `0.1.0-canary.1` once, under `canary`, without retrying already
  accepted packages
- because this is first-public bootstrap and the user wants bare `npx`, move
  `latest` to the same canary across all packages and explicitly label this as
  an exception
- verify all package dist-tags, the canary GitHub Release Desktop assets, and
  both `npx @rudderhq/cli@canary start --dry-run --no-open` and
  `npx @rudderhq/cli start --dry-run --no-open`
