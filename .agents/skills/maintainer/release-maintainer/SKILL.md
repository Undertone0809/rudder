---
name: release-maintainer
description: >
  Maintain and execute Rudder releases across npm, GitHub Releases, and Desktop
  portable assets. Use this skill whenever the user asks about 发版, release,
  publishing to npm, canary/stable promotion, GitHub Release assets, Desktop
  distribution, `npx @rudderhq/cli@latest start`, `npx @rudderhq/cli start`,
  broken npm `latest` dist-tags, full Desktop install smoke tests, GitHub
  Release API/rate-limit failures, version bumps, rollback, obsolete canary
  GitHub Release/tag cleanup after stable promotion, first-time package
  bootstrap, npm token-based fallback publishing, or release workflow failures.
  Prefer this skill for both planning and hands-on release operations in the
  Rudder repository, even when the user only asks "现在要做什么" or "帮我发版".
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
- After a stable `vX.Y.Z` is published and verified, older canary GitHub
  Releases and `canary/*` git tags for released-or-older base versions should
  be cleaned up unless the user asks to preserve them. This cleanup does not
  unpublish npm package versions; npm `*-canary.*` versions are immutable
  package history and should remain published.
- For stable releases, `main` is only a selector until you resolve it. Before
  the real publish, lock the source to an immutable commit SHA or stable tag and
  use that same ref for dry-run, publish, Desktop recovery, and verification.
  Do not chase newer `main` commits or newer canaries during the stable unless
  the user explicitly asks to retarget the release.
- A stable release is not done until verification, npm, GitHub Release, Desktop
  assets, and public notes/announcement are all handled.
- Stable release notes are used directly as the GitHub Release body. Do not
  include the duplicate opening block shown by GitHub itself: no initial
  `# Rudder vX.Y.Z` heading, no `Released: YYYY-MM-DD` line, and no standalone
  summary paragraph before the first section. Start the file with useful
  sections such as `## Highlights`, then install or upgrade notes.
- Pre-stable public canaries may temporarily be the default `latest` install
  path if there is no stable npm version yet and the user explicitly wants
  `npx @rudderhq/cli@latest start` or bare `npx @rudderhq/cli start` to work
  immediately. Call this out as an alpha/bootstrap exception, not the normal
  canary policy.
- During the pre-stable bootstrap exception, npm `latest` must not move to a
  canary until the matching Desktop GitHub Release has all portable assets and
  `SHASUMS256.txt`. Otherwise `npx @rudderhq/cli@latest start` can resolve a CLI
  version whose Desktop release is not installable yet.
- A `--dry-run` smoke only proves version and asset selection. It does not prove
  download, checksum, extraction, symlink preservation, quarantine cleanup, or
  app launchability. Do not claim the public Desktop install path is fixed until
  a non-dry-run isolated `npx ... start --no-open` install succeeds on the
  available platform, or until you explicitly state which platform could not be
  tested.
- GitHub REST `403` during release lookup can mean anonymous API rate limiting,
  not a missing Release. Before declaring a release absent, verify with
  authenticated `gh release view` and, when possible, a direct asset URL check.
- Local npm auth is not guaranteed. If `npm whoami` fails and a dist-tag must be
  moved, use the repository `npm-dist-tag.yml` workflow instead of pretending the
  local shell can publish or repair npm state.
- Release-maintenance commits that should not publish another canary must
  include `[skip release]`, then be verified as skipped in `release.yml`.
- If a normal `main` push is already running while you make release-maintenance
  changes, watch it to completion. It may publish the next canary, and that
  canary still needs npm, tag, Desktop, and Release-title verification. After
  any emergency dist-tag repair, recheck `latest` after in-progress `release.yml`
  runs finish or explicitly report the remaining overwrite risk.
- Once a stable source ref is locked, unrelated later `main` pushes are not a
  reason to retarget the stable. Track them only as overwrite or verification
  risk. After the first stable exists, ordinary canary promotion should not move
  npm `latest`; verify that invariant instead of waiting indefinitely for every
  unrelated canary smoke.
- A stable promotion is not proven by npm, GitHub Release assets, and dry-run
  smoke alone when the changed area can affect Desktop update behavior. If the
  release fixes or depends on Desktop update/install behavior, run a real
  Desktop update drill from an older installed build to the candidate before
  saying the stable is ready.

## Required Context

Start by reading only the context needed for the user's request:

- `doc/RELEASING.md` for the main maintainer runbook.
- `doc/PUBLISHING.md` for npm/package internals.
- `doc/RELEASE-AUTOMATION-SETUP.md` for one-time GitHub/npm setup.
- `.github/workflows/release.yml` when diagnosing canary/stable workflow behavior.
- `.github/workflows/desktop-release.yml` when diagnosing Desktop artifacts.
- `.github/workflows/npm-dist-tag.yml` when repairing `latest` or `canary`
  dist-tags through GitHub Actions.
- `scripts/release.sh`, `scripts/release-package-map.mjs`,
  `scripts/create-github-release.sh`, `scripts/promote-npm-dist-tag.mjs`,
  `scripts/wait-for-desktop-release-assets.mjs`, and
  `scripts/rollback-latest.sh` when you need exact command behavior.

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
./scripts/release.sh canary --print-version
```

When the task depends on remote truth, also check:

```bash
gh workflow list
gh run list --workflow release.yml --limit 10
gh run list --workflow desktop-release.yml --limit 10
gh run list --workflow npm-dist-tag.yml --limit 5
gh release list --repo Undertone0809/rudder --limit 20
git ls-remote --tags origin 'refs/tags/canary/v*'
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
   same canary for every public package. If it does not and the matching Desktop
   assets are already complete, run the `npm Dist Tag` workflow for that version
   and verify again:

```bash
gh workflow run npm-dist-tag.yml \
  --repo Undertone0809/rudder \
  --ref main \
  -f version=0.1.0-canary.N \
  -f tag=latest \
  -f dry_run=false
```

   Watch the resulting run to completion, then verify all public packages, not
   just `@rudderhq/cli`.
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

8. Smoke test CLI resolution with isolated HOME and npm cache:

```bash
tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-canary.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-canary.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli@canary start --dry-run --no-open
```

If canary smoke fails, do not promote stable. Fix forward on `main`, wait for
the next canary, and smoke again.

For pre-stable alpha releases, also smoke the user-facing `latest` path after
confirming the `latest` dist-tag moved. Use a full install smoke, not only
`--dry-run`, before telling a user that `npx @rudderhq/cli@latest start` works:

```bash
tmp_home="$(mktemp -d /tmp/rudder-npx-home.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npx-cache.XXXXXX)"
tmp_prefix="$(mktemp -d /tmp/rudder-npx-prefix.XXXXXX)"
tmp_output="$(mktemp -d /tmp/rudder-npx-output.XXXXXX)"
tmp_install="$(mktemp -d /tmp/rudder-npx-install.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_prefix="$tmp_prefix" npm_config_yes=true PATH="$tmp_prefix/bin:$PATH" \
  npx --prefer-online --yes @rudderhq/cli@latest start --no-open \
    --output-dir "$tmp_output" \
    --desktop-install-dir "$tmp_install"
```

On macOS, also verify the installed app is structurally usable:

```bash
app="$tmp_install/Rudder.app"
test -d "$app"
xattr -dr com.apple.quarantine "$app"
link="$app/Contents/Resources/server-package/node_modules/zod"
if [ -L "$link" ]; then
  target="$(readlink "$link")"
  case "$target" in
    /tmp/*|/private/tmp/*|/var/folders/*) echo "bad absolute temp symlink: $target"; exit 1 ;;
  esac
  test -e "$link"
fi
```

If the user reported that installation succeeds but the app is unusable, do a
controlled launch check from the temporary install path and terminate only the
processes started from that path before claiming the app opens.

### Stable Release

Prefer the GitHub Actions workflow over local stable publishing.

1. Pick a source ref: exact commit SHA, `main`, or a trusted canary source.
   If `main` is used, immediately resolve it to a commit SHA and record that as
   the release source. From this point on, use the immutable SHA unless the user
   explicitly authorizes retargeting.
2. Confirm public packages all share the intended stable semver:

```bash
node scripts/release-package-map.mjs list
./scripts/release.sh stable --print-version
```

3. Confirm `releases/vX.Y.Z.md` exists on the source ref and is formatted for
   direct GitHub Release body rendering:
   - starts with the first useful section, normally `## Highlights`
   - does not start with `# Rudder vX.Y.Z`
   - does not include `Released: YYYY-MM-DD`
   - does not include a standalone summary paragraph before `## Highlights`
   If an older draft has that front matter, remove it before the dry-run or
   manual GitHub Release update.
4. Check recent and in-progress `release.yml` runs. If there are unrelated
   `main` push canaries in progress, decide whether they are true blockers:
   - before npm stable exists, they can temporarily move `latest` to a canary,
     but the stable publish will move it to the stable version;
   - after npm stable exists, ordinary canaries should leave `latest` alone via
     `--only-if-no-stable`;
   - do not wait for unrelated canaries merely to adopt their newer commits.
5. If the stable contains Desktop startup, install, update, profile, migration,
   or release-shell changes, choose a canary candidate and run the Desktop
   update drill below before real stable publish. If the drill cannot run on
   the local platform, name the missing platform and treat stable readiness as
   not fully proven.
6. Run the `Release` workflow with `dry_run: true`, using the locked SHA as
   `source_ref`.
7. If dry-run passes, rerun with `dry_run: false`, again using the same locked
   SHA as `source_ref`.
8. Wait for or request `npm-stable` approval.
9. Verify npm `latest`, git tag `vX.Y.Z`, GitHub Release title/body shape,
   Desktop release workflow, and assets.
10. Clean up obsolete canary GitHub Releases and `canary/*` tags for the stable
    base and any older base versions after the stable is proven. Preserve the
    active next-line canary, for example keep `canary/v0.2.6-canary.N` after
    stable `v0.2.5`, and never unpublish npm canary package versions as part of
    this cleanup.
11. Smoke test:

```bash
npx @rudderhq/cli@latest start --no-open
rudder start --no-open
```

The second command is only expected to work after the persistent CLI exists.

If the workflow fails after npm publish, do not rerun the whole stable workflow
without first classifying the partial state. Stable npm versions are immutable;
repair the missing downstream surfaces for the same version and tag.

#### Post-Stable Canary Cleanup

Use this after a stable release succeeds, or when the user asks why old canary
versions still appear in GitHub Releases.

1. Read the current stable and active canary dist-tags:

```bash
npm view @rudderhq/cli dist-tags --json
```

   Treat npm `latest` as the current stable and npm `canary` as the active
   prerelease line. Do not delete the canary line that matches the active npm
   `canary` version unless the user explicitly asks for a broader purge.
2. List GitHub Releases and remote canary tags:

```bash
gh release list --repo Undertone0809/rudder --limit 100
git ls-remote --tags origin 'refs/tags/canary/v*'
```

3. Select obsolete canaries: releases/tags whose base version is less than or
   equal to the current stable base. For example, when `latest=0.2.5` and
   `canary=0.2.6-canary.9`, delete `canary/v0.2.5-canary.*` and older canary
   releases/tags, but preserve `canary/v0.2.6-canary.*`.
4. Delete GitHub Releases with tag cleanup:

```bash
gh release delete 'canary/v0.2.5-canary.N' \
  --repo Undertone0809/rudder \
  --cleanup-tag \
  -y
```

5. Run a separate orphan-tag pass because `gh release delete --cleanup-tag` only
   removes tags attached to Releases that still existed:

```bash
git ls-remote --tags origin 'refs/tags/canary/v*'
git push origin ':refs/tags/canary/v0.2.5-canary.N'
```

6. Verify the cleanup did not move npm dist-tags and did not remove the active
   canary line:

```bash
gh release list --repo Undertone0809/rudder --limit 100
git ls-remote --tags origin 'refs/tags/canary/v*'
npm view @rudderhq/cli dist-tags --json
```

Report the exact retained active canary, deleted release/tag ranges, and the
npm dist-tag state. If the user says "delete all previous canaries", interpret
that as all canary GitHub Releases/tags older than the active canary line, not
as npm unpublish authority.

#### Desktop Update Drill Before Stable Promotion

Use this gate when the stable is meant to prove installed Desktop behavior, not
just package availability. A candidate canary is ready for stable only after the
operator can update an already-installed app without a user-visible main-process
error or data/profile loss.

Minimum drill on the available local platform:

1. Record the starting installed app path and version, for example
   `/Users/zeeland/Applications/Rudder.app` plus the About/settings version.
2. Install or launch an older release that should discover the candidate update.
3. Use the app UI, preferably with Computer Use when available, to run
   "Check for update" from About/settings.
4. Download the update, click "Restart to update", and wait for the app to
   exit, replace itself, and reopen.
5. Verify the reopened app reports the candidate version and still points at
   the expected data/profile/workspace.
6. Inspect logs or UI for Electron main-process errors such as `EPIPE`,
   `ERR_STREAM_DESTROYED`, broken progress pipes, failed replacement, checksum
   failures, or repeated relaunch loops.
7. When practical, verify active-work safeguards: an active run should block,
   defer, or clearly explain update timing instead of silently killing work.

Evidence to report:

- candidate canary tag/version and stable target version
- installed app path, old version, new version, and platform
- screenshots, logs, or Computer Use notes for check/download/restart/reopen
- whether data/profile/workspace persisted
- any skipped drill item and why it could not run locally

Do not substitute a `--dry-run` or asset-list check for this drill when the
known risk is the in-app update path itself.

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
- npm published and the stable tag exists, but GitHub Release creation failed:
  do not republish npm and do not rerun the whole stable workflow. Inspect the
  job log for the failing command. If the failure is a missing `GH_TOKEN` or
  `gh` authentication problem after `vX.Y.Z` was pushed, create or update the
  GitHub Release manually from `releases/vX.Y.Z.md`, then trigger
  `desktop-release.yml` for that exact stable tag:

```bash
gh release create vX.Y.Z \
  --repo Undertone0809/rudder \
  --title vX.Y.Z \
  --notes-file releases/vX.Y.Z.md \
  --target <locked-source-sha>

gh workflow run desktop-release.yml \
  --repo Undertone0809/rudder \
  --ref main \
  -f release_tag=vX.Y.Z \
  -f source_ref=vX.Y.Z
```

- GitHub Release exists but Desktop assets failed: rerun `desktop-release.yml`
  for the same `vX.Y.Z` or `canary/vX.Y.Z-canary.N`; do not republish npm.
- A later `main` canary fails because an earlier concurrent canary already
  published the same prerelease version. Treat it as a canary concurrency
  incident, not as evidence that the locked stable source is bad. Verify npm
  dist-tags, the stable tag, and the selected release source before deciding
  whether stable should proceed.
- `GitHub Release ... was not found (403)` from the CLI: do not stop at the CLI
  error. Check whether GitHub API rate limits are exhausted and whether the
  Release and direct assets are actually public:

```bash
curl -sS https://api.github.com/rate_limit
gh release view 'canary/v0.1.0-canary.N' \
  --repo Undertone0809/rudder \
  --json tagName,name,url,isPrerelease,isDraft,assets
```

  If authenticated `gh release view` succeeds and direct asset download works,
  treat the problem as a CLI download/lookup bug or API-rate-limit issue, not as
  a missing Release.
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
- `latest` is broken: if a prior stable exists, rollback the dist-tag, then fix
  forward. During the pre-stable canary bootstrap exception, repair `latest` to
  the newest canary that already has complete Desktop assets by using
  `npm-dist-tag.yml`, then verify all package dist-tags and run the full npx
  Desktop smoke.

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
gh release view '<tag>' --json tagName,name,body,url,isPrerelease,isDraft,assets
gh release list --repo Undertone0809/rudder --limit 100
git ls-remote --tags origin 'refs/tags/canary/v*'
```

Also check whether any `release.yml` run is still in progress and could publish
a newer canary or move npm tags after your verification:

```bash
gh run list --workflow release.yml --limit 10
```

For stable releases, report in-progress unrelated canary or smoke workflows
separately from the fixed stable result. Do not keep retargeting or revalidating
against newer `main` commits after `vX.Y.Z` points at the locked source SHA.
For stable GitHub Releases, verify the title is the clean version tag and the
body starts at the changelog content instead of repeating the version title,
release date, or one-paragraph overview that GitHub already frames.
Also report whether obsolete canary GitHub Releases/tags were cleaned up or why
they were intentionally preserved; include the retained active canary line and
confirm npm dist-tags were not changed by cleanup.
If a supplemental cross-platform public install smoke is still running after the
stable npm/tag/Release/Desktop surfaces and at least the available local full
install smoke are verified, state that residual status explicitly instead of
blocking forever or implying the stable tag moved.

For first-public canary bootstrap where `latest` intentionally equals canary,
run both smoke checks. The `--dry-run` form is a fast resolver check; the
non-dry-run `latest` form is the install proof:

```bash
tmp_home="$(mktemp -d /tmp/rudder-cli-smoke-canary-start.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npm-cache-canary-start.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_yes=true \
  npx --prefer-online --yes @rudderhq/cli@canary start --dry-run --no-open

tmp_home="$(mktemp -d /tmp/rudder-npx-home-latest.XXXXXX)"
tmp_cache="$(mktemp -d /tmp/rudder-npx-cache-latest.XXXXXX)"
tmp_prefix="$(mktemp -d /tmp/rudder-npx-prefix-latest.XXXXXX)"
tmp_output="$(mktemp -d /tmp/rudder-npx-output-latest.XXXXXX)"
tmp_install="$(mktemp -d /tmp/rudder-npx-install-latest.XXXXXX)"
HOME="$tmp_home" npm_config_cache="$tmp_cache" npm_config_prefix="$tmp_prefix" npm_config_yes=true PATH="$tmp_prefix/bin:$PATH" \
  npx --prefer-online --yes @rudderhq/cli@latest start --no-open \
    --output-dir "$tmp_output" \
    --desktop-install-dir "$tmp_install"
```

The smoke should show the resolved Rudder release tag, target platform/arch, and
the persistent CLI version it installed. If it still resolves an old npm cache
entry, rerun with an isolated `npm_config_cache` and `--prefer-online`. If the
install succeeds but the app is suspected unusable, inspect installed portable
app symlinks and perform a controlled launch check from the temporary install
path.

## Safety Rules

- Do not run a real stable publish without an explicit user request.
- Do not unpublish npm packages as a rollback strategy.
- Do not unpublish npm canary package versions as a post-stable cleanup
  strategy. Cleanup means GitHub Releases and git `canary/*` tags unless the
  user gives separate, explicit npm unpublish authority and the npm policy
  allows it.
- Do not delete the active next-line canary GitHub Release/tag during
  post-stable cleanup unless the user explicitly asks to remove the current
  canary too.
- Do not republish an npm version that already exists.
- Do not force-push release tags unless the user explicitly approves the exact
  tag and reason.
- Do not treat a canary as a stable release.
- Do not claim a stable is complete until all release surfaces are verified.
- Do not claim a canary is complete until npm, tag, and Desktop assets are
  verified when the Desktop workflow is configured for canary tags. Also verify
  the GitHub Release title is clean and the Release is marked prerelease.
- Do not claim `npx @rudderhq/cli@latest start` is fixed from a dry-run alone.
  A user-facing Desktop install fix requires a real isolated install smoke, and
  when practical a minimal app-start check.
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
- GitHub Release URL/title/body-shape, npm dist-tag state, and whether Desktop
  assets match the expected set
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
- require the release notes to start at `## Highlights`, without a duplicate
  H1 title, release date, or introductory summary block
- recommend GitHub Actions dry-run before real publish
- include Desktop and npm verification steps

**Stable source lock with moving main**

User: `发 0.1.0 stable`

Observed state:
- dry-run passed for `main` when it resolved to `abc123`
- another unrelated commit later landed on `main` and started a canary run

Expected behavior:
- record `abc123` as the locked stable source unless the user explicitly
  retargets
- run the real stable publish with `source_ref=abc123`
- monitor later canary runs only for npm tag overwrite risk
- do not wait for the newer canary merely to adopt its commit into the stable

Must not:
- silently retarget stable to the newer `main`
- keep delaying stable to chase unrelated canaries
- imply the stable tag moved after `vX.Y.Z` points at the locked source

**Desktop failure**

User: `npm latest 已经发了，但是 mac/windows/linux 包没挂到 release 上。`

Expected behavior:
- treat as partial stable release
- do not republish npm
- rerun `desktop-release.yml` for the existing stable tag
- verify Release assets and `SHASUMS256.txt`

**Stable GitHub Release creation failure after npm publish**

Observed state:
- stable workflow published every `@rudderhq/*@0.1.0`
- workflow pushed `v0.1.0`
- `gh release create` failed because `GH_TOKEN` was missing in the job

Expected behavior:
- classify this as partial release recovery
- verify npm `latest=0.1.0` across all public packages
- verify `v0.1.0` points at the locked source SHA
- manually create or update the GitHub Release from `releases/v0.1.0.md`
- trigger `desktop-release.yml` for `release_tag=v0.1.0`

Must not:
- rerun the full stable workflow and attempt to republish `0.1.0`
- unpublish or rewrite the stable tag
- call the release done before Desktop assets and checksums are attached

**Broken npx latest install**

User: `npx @rudderhq/cli@latest start 还是报 GitHub Release not found (403)，你自己测一下。`

Expected behavior:
- check npm `latest` and `canary` dist-tags across all public packages
- check recent `release.yml`, `desktop-release.yml`, and `npm-dist-tag.yml` runs
- verify the exact GitHub Release and assets with `gh release view`
- treat GitHub API `403` as possible rate limiting until proven otherwise
- if `latest` points to a canary without complete Desktop assets, repair it via
  `npm-dist-tag.yml` only after choosing a canary whose assets and checksums are
  complete
- run a real isolated `npx --prefer-online --yes @rudderhq/cli@latest start --no-open`
  install with temporary HOME/cache/prefix/output/install directories
- on macOS, verify quarantine cleanup and that portable app symlinks resolve
- report the exact resolved version, Release tag, workflow run IDs, smoke exit
  code, and any in-progress release runs that could still affect `latest`

**Old canary cleanup after stable**

User: `发正式版的时候把之前的 Canary 版本都删掉，这个事情现在没有做到吗？为什么我能看到很多 0.2.5 版本之前的 Canary version，帮我把之前的都删了`

Observed state:
- npm `latest=0.2.5`
- npm `canary=0.2.6-canary.9`
- GitHub Releases still include `canary/v0.2.5-canary.0..14`

Expected behavior:
- explain that prior canary cleanup was not a stable-release completion gate if
  old GitHub Releases/tags remain visible after the stable
- delete obsolete GitHub Releases with `gh release delete --cleanup-tag`
- run a separate remote tag pass for orphaned `refs/tags/canary/*`
- preserve the active next-line canary, here `canary/v0.2.6-canary.*`
- verify `npm view @rudderhq/cli dist-tags --json` still reports
  `latest=0.2.5` and `canary=0.2.6-canary.9`

Must not:
- unpublish npm `0.2.5-canary.*` package versions
- delete the active `0.2.6` canary line without explicit user authority
- claim cleanup is complete without checking both GitHub Releases and remote
  tags

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
  both `npx @rudderhq/cli@canary start --dry-run --no-open` and a real isolated
  `npx @rudderhq/cli@latest start --no-open` Desktop install smoke
