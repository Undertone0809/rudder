# Releasing Rudder

Maintainer runbook for shipping Rudder across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every successful `CI` run for a `main` push publishes a canary automatically, except explicit release-infra maintenance commits marked `[skip release]`.
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
- after publishing stable `X.Y.Z`, the workflow prepares the public package
  version bump on a protected PR branch, for example `X.Y.Z -> X.Y.(Z+1)`,
  marks the maintenance commit `[skip release]`, and explicitly dispatches CI
  for it
- `./scripts/release.sh canary --print-version` fails if the committed canary
  base already exists as stable npm package `X.Y.Z` or remote git tag `vX.Y.Z`

## Release Surfaces

Every stable release has five separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `@rudderhq/cli` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release record
4. **Desktop** — macOS, Windows, and Linux portable assets are attached to the stable GitHub Release
5. **Website / announcements** — the release is publicly announced, and any
   in-scope website/docs content is published

A stable release is done only when all five surfaces are handled.

For the announcement surface, the public GitHub Release notes may be the
announcement channel when there is no separate website post or social/customer
announcement in scope. If a separate announcement or docs-site publish is
expected, record the channel and owner in the release issue before closeout. If
that surface is intentionally skipped, record who made that decision and why.

Docs production deploy failures caused by Vercel account or token access are an
external release blocker for docs-site publishing. Do not silently count a
failed docs workflow as handled; either escalate the credential/account issue to
the Vercel owner or explicitly scope docs-site publishing out of that release.

## Authorization Gates

Release preparation and release execution are separate operations:

1. **Review Ready** — identify the exact source SHA, complete verification,
   prepare release notes/screenshots, push the feature branch, and open the PR.
2. **Landing/Staging Gate** — obtain explicit permission before merging to
   `main` when that merge publishes a canary or updates docs staging.
3. **Production Gate** — report the exact source ref, version/tag, production
   targets, successful and failing checks, and rollback point; then stop and wait
   for an operator to explicitly approve the production release.

Instructions such as `start`, `continue`, `proceed`, `implement`, or approval of
a plan do not satisfy the production gate. A staging approval is not production
approval. Agents and automation must not set `dry_run: false`, enter workflow
confirmation strings, or synthesize a release tag as evidence of approval. The
operator's explicit authorization must exist before those values are supplied.
That stable-release authorization also covers creating the deterministic
post-release PR that advances `main` to the next patch base; it does not
authorize bypassing that PR's review or CI.

The workflow also fails closed unless `npm-stable` has required reviewers,
`main` is protected, and GitHub Actions can create the generated post-stable
version PR and dispatch its CI. These repository settings are part of the
release gate, not optional documentation.

Even when an initial request or plan includes production deployment, always
pause at the production gate after presenting the reviewed source, target,
checks, known failures, and rollback point. Only the operator's latest explicit
approval for that described release authorizes proceeding.

## Docs Site Releases

The public docs site uses separate staging and production channels:

- `staging.docs.rudderhq.dev` follows the latest `main` docs commit.
  [`.github/workflows/docs-staging.yml`](../.github/workflows/docs-staging.yml)
  runs automatically on `main` pushes that touch the docs tree or docs deployment
  workflow.
- `docs.rudderhq.dev` is production. It does not auto-follow `main`.
  An approved stable release invokes
  [`.github/workflows/docs-production.yml`](../.github/workflows/docs-production.yml)
  against its immutable `vX.Y.Z` tag after the npm, GitHub Release, and Desktop
  asset steps succeed. Other docs changes still publish manually from the
  Actions tab.

Production docs publishes create a git tag in the form `docs/vYYYY.MM.DD`, for
example `docs/v2026.05.27`. If the default date tag already exists for a
different commit, pass a more specific `tag_name` input such as
`docs/v2026.05.27.2`. A stable-release docs deployment uses the immutable,
versioned marker `docs/release/vX.Y.Z` instead.

Canaries cover verification, npm, a traceability tag, and Desktop portable assets.

## Core Invariants

- canaries publish from `main`
- stables publish from an explicitly chosen source ref
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vX.Y.Z.md`
- stable public changelog entries are always present in both `docs/releases.mdx`
  and `docs/zh/releases.mdx`
- stable docs production is promoted from the matching immutable `vX.Y.Z` tag
  only after explicit docs-domain authorization
- canary GitHub Releases are only for traceability and Desktop portable assets
- canaries never require changelog generation

## TL;DR

### Canary

Every successful `CI` workflow for a `main` push starts the canary path inside [`.github/workflows/release.yml`](../.github/workflows/release.yml), unless the head commit message contains `[skip release]`.

It:

- reuses the successful CI result for the exact pushed commit
- runs a fast version/tag/npm preflight before installing dependencies
- derives the next canary prerelease from the committed semver
- publishes under npm dist-tag `canary`
- while no stable npm version exists yet, also points npm dist-tag `latest` at
  the same canary so the alpha `npx @rudderhq/cli@latest start` path works
- creates a git tag `canary/vX.Y.Z-canary.N`
- starts the Desktop release workflow for `canary/vX.Y.Z-canary.N`
- creates or updates the canary GitHub Release with display title `vX.Y.Z-canary.N`

The release workflow dispatches the Desktop workflow explicitly after pushing the
canary tag. Do not rely on a tag push made by `GITHUB_TOKEN` to trigger another
workflow.

Canary and stable publication use the same non-cancelling concurrency group, so
their npm/Desktop orchestration cannot run at the same time. GitHub retains at
most one pending job per group rather than a FIFO queue. If a pending manual
stable is superseded by a newer pending run, rerun the same locked stable SHA
after the active publication finishes; do not silently retarget it.

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
- `confirm_stable`
  - leave empty for dry runs
  - after explicit production authorization, enter `PUBLISH STABLE` for the
    real stable release
- `confirm_docs`
  - leave empty for dry runs
  - after separately approving the `docs.rudderhq.dev` deployment for this
    exact stable source, enter `PUBLISH DOCS`

Before running stable:

1. pick the canary commit or tag you trust
2. confirm the committed public package version is the stable version you want to ship
3. create or update `releases/vX.Y.Z.md`, `docs/releases.mdx`, and
   `docs/zh/releases.mdx` on that source ref
4. confirm that exact source commit has a successful `CI` run
5. run the workflow with `dry_run: true`
6. present the exact source ref, version, checks, targets, and rollback point;
   obtain explicit production approval
7. obtain a separate explicit approval to deploy that exact changelog to
   `docs.rudderhq.dev`
8. run the workflow with `dry_run: false`, `confirm_stable: PUBLISH STABLE`,
   and `confirm_docs: PUBLISH DOCS`
9. after stable and the docs deployment are both published, confirm the
   workflow opened the protected next-patch-base PR and its explicitly
   dispatched CI succeeded

Example:

- `source_ref`: `main`
- resulting stable version: `0.1.0`
- follow-up version bump before the next canary line: `0.1.0 -> 0.1.1`

The workflow:

- resolves the source ref to an immutable SHA and requires successful CI for
  that exact commit
- runs release-specific version/tag/npm preflight before dependency install
- publishes the committed `X.Y.Z` under npm dist-tag `latest`
- creates git tag `vX.Y.Z`
- creates or updates the GitHub Release from `releases/vX.Y.Z.md`
- starts the desktop release workflow for `vX.Y.Z`
- invokes docs production from the same `vX.Y.Z` source and verifies the public
  docs domains before advancing the next release base
- deletes obsolete `canary/v*` GitHub Releases and git tags whose canary base is
  the released stable version or older, while preserving the current npm
  `@rudderhq/cli@canary` target if the next-base canary has not been published
  yet
- prepares the next canary/stable base on an `automation/release-vX.Y.Z` branch
  with `[skip release]`, opens a protected pull request, and dispatches the
  trusted CI workflow with the immutable bump SHA, unless `main` already
  advanced
- makes the website changelog deployment a required stable-release surface;
  canary releases never deploy it

Users install stable Rudder with:

```bash
npx @rudderhq/cli@latest start
```

During the pre-stable alpha period, `latest` may temporarily point at the newest
canary so the same first-run command keeps working before a real stable exists.
After the first stable npm version is published, `latest` returns to stable-only
semantics and canaries remain on `@canary`.

By default this checks for newer Rudder CLI releases, prepares the matching
persistent `rudder` CLI globally, and downloads/opens the matching Rudder
Desktop portable app from the GitHub Release when needed.
After the persistent CLI exists, `rudder start` is equivalent to the `npx`
command above. More generally, `npx @rudderhq/cli@latest <command>` and
`rudder <command>` are the same CLI surface when they resolve to the same
version; the `npx` form is mainly the first-run and explicit dist-tag form.
Use `--no-desktop` or `--no-cli` only for targeted maintainer checks.

The release workflow runs the public install smoke after npm publish and Desktop
assets are available. The smoke executes `npx ... start --no-open` on Linux,
Windows, and macOS using isolated temporary HOME, npm cache, npm prefix, output,
and Desktop install directories. Maintainers can also run it manually from the
`Public Install Smoke` workflow with a package spec such as
`@rudderhq/cli@latest`, `@rudderhq/cli@canary`, or an exact version.

After a stable release, the workflow also runs:

```bash
node scripts/cleanup-obsolete-canaries.mjs --stable-version X.Y.Z
```

This cleans up canary GitHub Releases and `canary/*` tags for the released
stable base and older bases. It intentionally does not unpublish npm canary
versions. By default, it preserves the canary release currently selected by the
npm `canary` dist-tag, because `@rudderhq/cli@canary` still needs matching
Desktop assets until a next-base canary is published.

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

The public docs changelog must be updated in the same stable-release pass:

- `docs/releases.mdx`
- `docs/zh/releases.mdx`

Canaries do not get changelog files.

`./scripts/release.sh stable --preflight` fails closed unless all three stable
release narratives exist on the selected source: `releases/vX.Y.Z.md`, the
English `## vX.Y.Z` entry, and the Chinese `## vX.Y.Z` entry. The public entries
must include the version's GitHub Release link and the `New Features`,
`Improvements`, and `Bug Fixes` sections in that order.

Use this body shape for `releases/vX.Y.Z.md` because GitHub already renders the
release title, tag, author, and publish date around the notes:

```md
## New Features

- ...

## Improvements

- ...

## Bug Fixes

- ...
```

Do not add an initial `# Rudder vX.Y.Z` heading, `Released: YYYY-MM-DD` line, or
standalone prose summary before `## New Features`.

For the public docs changelog, keep `## vX.Y.Z` as the version heading, then
use the same changelog categories inside that version entry:

```md
## vX.Y.Z

Released: YYYY-MM-DD

[GitHub Release](...)

### New Features

- ...

### Improvements

- ...

### Bug Fixes

- ...
```

Do not use release-section labels such as `Highlights`, `Install`, or
`重点变化` in `releases/vX.Y.Z.md`, `docs/releases.mdx`, or
`docs/zh/releases.mdx`. The stable changelog taxonomy is always `New Features`,
`Improvements`, and `Bug Fixes`, in that order.

Recommended local generation flow:

```bash
VERSION="$(./scripts/release.sh stable --print-version)"
claude --print --output-format stream-json --verbose --dangerously-skip-permissions --model claude-opus-4-6 "Use the release-changelog skill to draft or update releases/v${VERSION}.md for Rudder. Read doc/engineering/RELEASING.md and .agents/skills/release-changelog/SKILL.md, then generate the stable changelog for v${VERSION} from commits since the last stable tag. Use exactly these top-level sections in order: ## New Features, ## Improvements, ## Bug Fixes. Do not create a canary changelog."
```

The repo intentionally does not run this through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

If stable npm publication succeeds but the docs-production child workflow
fails, do not publish the same npm version again. Fix the docs deployment and
use **Re-run failed jobs** for the original Release workflow so it reuses the
existing `vX.Y.Z` tag. The next-release-base job remains blocked until the
matching public changelog deploy passes. For historical releases such as
`v0.5.1`, which predate this automation, run `Docs production` manually from
the immutable stable tag after explicit docs-domain approval.

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
- the first default/lead agent is created
- the first default/lead agent heartbeat run is triggered

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
- [`scripts/cleanup-obsolete-canaries.mjs`](../scripts/cleanup-obsolete-canaries.mjs)
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh)
- [`doc/engineering/PUBLISHING.md`](PUBLISHING.md)
- [`doc/engineering/RELEASE-AUTOMATION-SETUP.md`](RELEASE-AUTOMATION-SETUP.md)
