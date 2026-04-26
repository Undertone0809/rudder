# Releasing Rudder

Maintainer runbook for shipping Rudder across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every push to `main` publishes a canary automatically, except explicit release-infra maintenance commits marked `[skip release]`.
2. Stable releases are manually promoted from a chosen tested commit or canary tag.
3. Stable release notes live in `releases/vX.Y.Z.md`.
4. Stable releases get user-facing GitHub Releases; canaries may get prerelease GitHub Releases for Desktop portable assets.

## Versioning Model

Rudder uses semver directly:

- stable: `X.Y.Z`
- canary: `X.Y.Z-canary.N`

Examples:

- first Rudder stable: `0.1.0`
- next patch: `0.1.1`
- fourth canary for the `0.1.0` line: `0.1.0-canary.3`

Important constraints:

- stable source commits must have one committed public package version
- all public packages must share that same stable semver before release
- canary publishes derive the next prerelease from the committed stable version

## Release Surfaces

Every stable release has five separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `@rudderhq/cli` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release
4. **Desktop** — macOS, Windows, and Linux portable assets are attached to the stable GitHub Release
5. **Website / announcements** — the stable changelog is published externally and announced

A stable release is done only when all five surfaces are handled.

Canaries cover verification, npm, a traceability tag, and Desktop portable assets.

## Core Invariants

- canaries publish from `main`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vX.Y.Z.md`
- canary GitHub Releases are only for traceability and Desktop portable assets
- canaries never require changelog generation

## TL;DR

### Canary

Every push to `main` runs the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml), unless the head commit message contains `[skip release]`.

It:

- verifies the pushed commit
- derives the next canary prerelease from the committed semver
- publishes under npm dist-tag `canary`
- creates a git tag `canary/vX.Y.Z-canary.N`
- starts the Desktop release workflow for `canary/vX.Y.Z-canary.N`
- creates or updates the canary GitHub Release with display title `vX.Y.Z-canary.N`

The release workflow dispatches the Desktop workflow explicitly after pushing the
canary tag. Do not rely on a tag push made by `GITHUB_TOKEN` to trigger another
workflow.

Users install canaries with:

```bash
npx @rudderhq/cli@canary onboard
# or
npx @rudderhq/cli@canary onboard --data-dir "$(mktemp -d /tmp/rudder-canary.XXXXXX)"
```

### Stable

Use [`.github/workflows/release.yml`](../.github/workflows/release.yml) from the Actions tab with the manual `workflow_dispatch` inputs.

[Run the action here](https://github.com/Undertone0809/rudder/actions/workflows/release.yml)

Inputs:

- `source_ref`
  - commit SHA, branch, or tag
- `dry_run`
  - preview only when true

Before running stable:

1. pick the canary commit or tag you trust
2. confirm the committed public package version is the stable version you want to ship
3. create or update `releases/vX.Y.Z.md` on that source ref
4. run the stable workflow from that source ref

Example:

- `source_ref`: `main`
- resulting stable version: `0.1.0`

The workflow:

- re-verifies the exact source ref
- publishes the committed `X.Y.Z` under npm dist-tag `latest`
- creates git tag `vX.Y.Z`
- creates or updates the GitHub Release from `releases/vX.Y.Z.md`
- starts the desktop release workflow for `vX.Y.Z`

Users install stable Rudder with:

```bash
npx @rudderhq/cli@latest start
```

By default this checks for newer Rudder CLI releases, prepares the matching
persistent `rudder` CLI globally, and downloads/opens the matching Rudder
Desktop portable app from the GitHub Release when needed.
After the persistent CLI exists, `rudder start` is equivalent to the `npx`
command above. More generally, `npx @rudderhq/cli@latest <command>` and
`rudder <command>` are the same CLI surface when they resolve to the same
version; the `npx` form is mainly the first-run and explicit dist-tag form.
Use `--no-desktop` or `--no-cli` only for targeted maintainer checks.

## Local Commands

### Preview a canary locally

```bash
./scripts/release.sh canary --dry-run
```

### Preview a stable locally

```bash
./scripts/release.sh stable --dry-run
```

### Publish a stable locally

This is mainly for emergency/manual use. The normal path is the GitHub workflow.

```bash
./scripts/release.sh stable
git push public-gh refs/tags/v0.1.0
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh 0.1.0
gh workflow run desktop-release.yml --ref v0.1.0 -f release_tag=v0.1.0
```

## Stable Changelog Workflow

Stable changelog files live at:

- `releases/vX.Y.Z.md`

Canaries do not get changelog files.

Recommended local generation flow:

```bash
VERSION="$(./scripts/release.sh stable --print-version)"
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Rudder. Read doc/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Do not create a canary changelog."
```

The repo intentionally does not run this through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

## Smoke Testing

For a canary:

```bash
RUDDER_VERSION=canary ./scripts/docker-onboard-smoke.sh
```

For the current stable:

```bash
RUDDER_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Useful isolated variants:

```bash
HOST_PORT=3232 DATA_DIR=./data/release-smoke-canary RUDDER_VERSION=canary ./scripts/docker-onboard-smoke.sh
HOST_PORT=3233 DATA_DIR=./data/release-smoke-stable RUDDER_VERSION=latest ./scripts/docker-onboard-smoke.sh
```

Automated browser smoke is also available:

```bash
gh workflow run release-smoke.yml -f rudder_version=canary
gh workflow run release-smoke.yml -f rudder_version=latest
```

Minimum checks:

- `npx @rudderhq/cli@latest start --no-open` prepares the persistent CLI and installs the checksum-verified portable desktop app
- `npx @rudderhq/cli@canary onboard` installs the canary CLI path
- onboarding completes without crashes
- authenticated login works with the smoke credentials
- the browser lands in onboarding on a fresh instance
- company creation succeeds
- the first CEO agent is created
- the first CEO heartbeat run is triggered

## Rollback

Rollback does not unpublish versions.

It only moves the `latest` dist-tag back to a previous stable:

```bash
./scripts/rollback-latest.sh 0.1.0 --dry-run
./scripts/rollback-latest.sh 0.1.0
```

Then fix forward with a new stable semver.

## Failure Playbooks

### If the canary publishes but smoke testing fails

Do not run stable.

Instead:

1. fix the issue on `main`
2. merge the fix
3. wait for the next automatic canary
4. rerun smoke testing

### If stable npm publish succeeds but tag push or GitHub release creation fails

This is a partial release. npm is already live.

Do this immediately:

1. push the missing tag
2. rerun `PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh 0.1.0`
3. verify the GitHub Release notes point at `releases/v0.1.0.md`

Do not republish the same version.

### If `latest` is broken after stable publish

Roll back the dist-tag:

```bash
./scripts/rollback-latest.sh 0.1.0
```

Then fix forward with a new stable release.

## Related Files

- [`scripts/release.sh`](../scripts/release.sh)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/PUBLISHING.md`](PUBLISHING.md)
- [`doc/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
