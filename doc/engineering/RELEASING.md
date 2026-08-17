# Releasing Rudder

Maintainer runbook for shipping Rudder across npm, GitHub, and the website-facing changelog surface.

The release model is now commit-driven:

1. Every successful `Test` run for a `main` push publishes a canary automatically, except explicit release-infra maintenance commits marked `[skip release]`.
2. Stable releases are manually promoted from a chosen tested commit SHA.
3. Stable release notes live in `releases/vX.Y.Z.md`.
4. Stable releases get user-facing GitHub Releases; canaries may get prerelease GitHub Releases for Desktop portable assets.

Database compatibility is an explicit pre-publish gate. For the exact locked
source, the release workflow must pass the migration manifest immutability check,
the historical schema matrix (including production-shaped data and restart
verification), the recovery-point/restore drill, and packaged upgrade smoke on
Linux, macOS, and Windows before the first npm publish, tag push, or GitHub
Release mutation. A later Desktop build cannot retroactively make a published
database migration safe.

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
- after publishing stable `X.Y.Z`, the workflow commits the public package
  version bump directly to `main`, for example `X.Y.Z -> X.Y.(Z+1)`, marks the
   maintenance commit `[skip release]`, and explicitly dispatches Test for it
- `./scripts/release.sh canary --print-version` fails if the committed canary
  base already exists as stable npm package `X.Y.Z` or remote git tag `vX.Y.Z`

## Release Surfaces

Every stable release has six separate surfaces:

1. **Verification** — the exact git SHA passes typecheck, tests, and build
2. **npm** — `@rudderhq/cli` and public workspace packages are published
3. **GitHub** — the stable release gets a git tag and GitHub Release record
4. **Desktop** — macOS, Windows, and Linux portable assets are attached to the stable GitHub Release
5. **China mirror** — the same frozen Desktop assets are immutable and
   byte-verified in Tencent COS before the GitHub checksum completion marker
6. **Website / announcements** — the release is publicly announced, and any
   in-scope website/docs content is published

A stable release is done only when all six surfaces are handled.

For the announcement surface, the public GitHub Release notes may be the
announcement channel when there is no separate website post or social/customer
announcement in scope. If a separate announcement or docs-site publish is
expected, record the channel and owner in the release issue before closeout. If
that surface is intentionally skipped, record who made that decision and why.

Docs Release deploy failures caused by Vercel account or token access are an
external release blocker for docs-site publishing. Do not silently count a
failed docs workflow as handled; either escalate the credential/account issue to
the Vercel owner or explicitly scope docs-site publishing out of that release.

## Release Command Contract

Release preparation and release execution are separate operations:

1. **Review Ready** — identify the exact source SHA, complete verification, and
   prepare release notes/screenshots.
2. **Release execution** — an explicit release/publish request authorizes
   immediately freezing the reviewed source, committing and pushing any
   release-only narratives directly to `main`, waiting for exact-source Test,
   running preflight and package validation, and publishing all standard
   surfaces in one production execution.
3. **Status and verification** — report the exact source ref, version/tag,
   targets, successful and failing checks, and rollback point. An explicit
   release/publish imperative authorizes the release agent to complete the
   standard GitHub Actions publish and verification without a second approval.
   If the version is omitted, infer the single consistent stable target from the
   current release context and repository scripts, state it, and proceed.

Instructions such as `start`, `continue`, `proceed`, `implement`, or approval of
a plan do not request publication. Imperatives such as `release`, `publish`,
`发版`, and `发布` do. Once that request exists, the release agent completes all
standard release surfaces, including production docs and the deterministic
post-release version commit on `main`, without returning PR or authorization
tasks to the operator.

The workflow still fails closed on machine evidence: the release source must be
reachable from `main`, have successful exact-source Test, pass stable preflight,
and preserve immutable npm/tag semantics. The `npm-stable` environment remains
main-only and non-interactive, with no reviewer click or wait timer.

### Fast Stable Operating Model

Use this model for an explicit stable release:

1. Freeze one immutable source SHA immediately. Do not extend the release window
   to absorb later unrelated `main` commits.
2. If release narratives are missing, assign one bounded release-notes subagent
   to draft `releases/vX.Y.Z.md`, `docs/releases.mdx`, and
   `docs/zh/releases.mdx` from the locked diff while the primary agent runs
   read-only preflight. The primary agent reviews and integrates the drafts.
3. Require successful exact-source Test, stable preflight, immutable npm/tag
   checks, and package validation before publication.
4. Use `[skip release]` on release-only candidate repair commits after the
   stable campaign starts, unless a canary is explicitly required. This keeps
   exact-source Test while suppressing a duplicate automatic canary release.
5. Run one production stable execution with the full 40-character source SHA.
   Do not make a separate dry-run workflow
   a human or agent hand-off and then repeat checkout, dependency installation,
   and validation in a second run.
6. Preserve every public-surface verification gate, especially the real
   Windows/macOS/Linux install smoke.

The historical migration runtime emits its current fixture and phase every ten
seconds. It has a five-minute ceiling for all three historical fixtures on one
platform; the complete per-platform prepublish gate has a 25-minute ceiling.
Treat either timeout as a defect in the named stage, not as a reason to extend
the budget. After two failures at the same stage on unchanged inputs, stop
dispatching, record both run IDs and the last phase, fix the cause, and rerun one
new immutable candidate from exact-source Test.

The workflow still exposes `dry_run` for read-only preview requests and
troubleshooting. For an already-authorized release whose equivalent machine
gates passed, use the production path directly; `dry_run: true` is not a
mandatory first dispatch.

Only an explicit production-release instruction authorizes proceeding. Once it
exists and the reviewed source, resolved target, checks, known failures, and
rollback point are recorded, the agent owns the remaining landing, publish,
recovery, verification, cleanup, and closeout steps end to end.
Separate authority is still required for destructive or nonstandard actions
such as npm unpublish, force-pushing published tags, deleting the active canary
line, weakening repository protections, or expanding the release scope.

## Docs Site Releases

The public docs site has one delivery workflow. `docs.rudderhq.dev` does not
auto-follow `main`. An approved stable release invokes `Docs Release` from
[`.github/workflows/docs-production.yml`](../../.github/workflows/docs-production.yml)
against its immutable `vX.Y.Z` tag after npm, the stable tag, the GitHub Release,
and verified Desktop assets exist. It runs in parallel with the three-platform
public install smoke, and both remain required before the next release base
advances. Other docs changes publish manually from the Actions tab using an
immutable commit or tag.

Production docs publishes create a git tag in the form `docs/vYYYY.MM.DD`, for
example `docs/v2026.05.27`. If the default date tag already exists for a
different commit, pass a more specific `tag_name` input such as
`docs/v2026.05.27.2`. A stable-release docs deployment uses the immutable,
versioned marker `docs/release/vX.Y.Z` instead.

Canaries cover verification, npm, a traceability tag, and Desktop portable assets.

## Core Invariants

- canaries publish from `main`
- stables publish from an explicitly chosen full commit SHA
- tags point at the original source commit, not a generated release commit
- stable notes are always `releases/vX.Y.Z.md`
- stable public changelog entries are always present in both `docs/releases.mdx`
  and `docs/zh/releases.mdx`
- public changelog entries describe user-visible outcomes, omit empty
  categories, and keep release-engineering details in maintainer documentation
- stable Docs Release is promoted from the matching immutable `vX.Y.Z` tag
  only after explicit docs-domain authorization
- canary GitHub Releases are only for traceability and Desktop portable assets
- canaries never require changelog generation

## TL;DR

### Canary

Every successful `Test` workflow for a `main` push starts the canary path inside [`.github/workflows/release.yml`](../../.github/workflows/release.yml), unless the head commit message contains `[skip release]`.

It:

- reuses the successful Test result for the exact pushed commit, including docs
  structure and static-search qualification
- runs a fast version/tag/npm preflight before installing dependencies
- derives the next canary prerelease from the committed semver
- publishes under npm dist-tag `canary`
- while no stable npm version exists yet, also points npm dist-tag `latest` at
  the same canary so the alpha `npx @rudderhq/cli@latest start` path works
- creates a git tag `canary/vX.Y.Z-canary.N`
- builds and verifies the four-platform Desktop candidates before npm or tag mutation
- creates or updates the canary GitHub Release with display title
  `vX.Y.Z-canary.N` and uploads only those exact verified binaries
- runs `mirror-canary` in Environment `desktop-release-mirror`, using GitHub
  OIDC and Tencent STS to mirror and verify all eight COS objects
- uploads GitHub `SHASUMS256.txt` only after that mirror succeeds, then runs the
  three-platform public install smoke

Canary and stable publication use the same non-cancelling concurrency group. A
stable still takes priority over same-base or older canary publication after
the locked source passes exact-source Test and preflight. Record any completed
public mutation before stopping obsolete remaining orchestration; never
unpublish the canary npm version or stop an active next-base canary.

GitHub retains at most one pending job per group rather than a FIFO queue. If a
pending manual stable is superseded, rerun the same locked stable SHA; do not
silently retarget it.

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
  - full 40-character commit SHA; moving branches and tags are rejected
- `dry_run`
  - optional read-only preview when true; an authorized stable release normally
    uses `false` after equivalent exact-source gates pass

Before running stable:

1. freeze the tested canary commit as a full immutable SHA immediately
2. confirm the committed public package version is the stable version you want
   to ship
3. if narratives are missing, start a bounded release-notes subagent in
   parallel with read-only preflight; review and commit
   `releases/vX.Y.Z.md`, `docs/releases.mdx`, and `docs/zh/releases.mdx`
4. confirm that exact final source commit has successful `Test`, stable preflight,
   package validation, and no existing immutable npm version/tag
5. present the exact source ref, version, checks, targets, data impact, and
   rollback point as a progress update
6. if a same-base canary is only waiting for Desktop assets, record its npm/tag
   state and stop the remaining wait; do not unpublish it
7. run one production workflow with `dry_run: false` and the full SHA; the existing release
   request remains the npm, GitHub, Desktop, and production-docs authorization
8. continue without another confirmation unless the user excluded
   `docs.rudderhq.dev` or a genuinely ambiguous/nonstandard decision appears
9. after stable and the docs deployment are both published, confirm the
   workflow committed the next-patch base directly to `main` and its explicitly
   dispatched CI succeeded

Example:

- `source_ref`: `0123456789abcdef0123456789abcdef01234567`
- resulting stable version: `0.1.0`
- follow-up version bump before the next canary line: `0.1.0 -> 0.1.1`

The workflow:

- resolves the source ref to an immutable SHA and requires successful Test for
  that exact commit; CI qualifies docs structure and static search once instead
  of repeating those checks in the stable publish job
- runs release-specific version/tag/npm preflight before dependency install
- publishes the committed `X.Y.Z` under npm dist-tag `latest`
- creates git tag `vX.Y.Z`
- creates or updates the GitHub Release from `releases/vX.Y.Z.md` and uploads
  the exact Desktop binaries already built and verified by this run
- runs `mirror-stable` against the same frozen Actions artifacts, then publishes
  GitHub `SHASUMS256.txt` as the completion marker
- invokes Docs Release from the same `vX.Y.Z` source in parallel with the real
  Linux, Windows, and macOS public install smoke
- deletes obsolete `canary/v*` GitHub Releases and git tags whose canary base is
  the released stable version or older, while preserving the current npm
  `@rudderhq/cli@canary` target if the next-base canary has not been published
  yet
- commits the next canary/stable base directly to `main` with `[skip release]`
  and dispatches the trusted Test workflow with the immutable bump SHA, unless
  `main` already advanced
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
Desktop portable app from Tencent COS or GitHub when needed. GitHub always
supplies the trusted `SHASUMS256.txt`; COS is only a byte transport.
After the persistent CLI exists, `rudder start` is equivalent to the `npx`
command above. More generally, `npx @rudderhq/cli@latest <command>` and
`rudder <command>` are the same CLI surface when they resolve to the same
version; the `npx` form is mainly the first-run and explicit dist-tag form.
Use `--no-desktop` or `--no-cli` only for targeted maintainer checks.

The Release workflow builds and smokes Desktop artifacts before any public
mutation. It uploads immutable GitHub binaries, completes the OIDC/STS-backed
COS mirror, and uploads GitHub `SHASUMS256.txt` last. Only then may the public
install matrix run. Docs Release may run after stable publication while the
mirror completes. The install lanes
execute `npx ... start --no-open` on Linux, Windows, and macOS and download the
real portable Desktop artifact, using isolated temporary HOME, npm cache, npm
prefix, output, and Desktop install directories. Recovery reruns the original
Release with `resume_missing: true`; there is no standalone install workflow.

The final next-release handoff is a convergence gate, not a timer: it waits for
the verified COS mirror, completed GitHub Desktop assets, production docs, the
three-platform public install smoke, and obsolete-canary cleanup. A failure in
any downstream surface leaves the release
partial and resumable without republishing an immutable npm version.

Each Desktop asset is also gated before collection by a packaged `upgrade` smoke.
That gate starts the built Electron app against an isolated instance, exercises
the upgrade migration path, leaves a stale PostgreSQL pid file to model an
interrupted shutdown, and verifies the next launch reaches the board. Packaging
also fails if the shell, server, bundled CLI, or first-party bundled packages
are not version-compatible. This catches the recurring local-database startup
failure before the asset can be attached to a release.

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

### Emergency local package and Release creation

This is an incomplete emergency path and does not create validated Desktop
assets. The normal and only complete product release path is the GitHub Release
workflow.

```bash
./scripts/release.sh stable
git push public-gh refs/tags/v0.1.0
PUBLISH_REMOTE=public-gh ./scripts/create-github-release.sh 0.1.0
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
English `## vX.Y.Z` entry, and the Chinese `## vX.Y.Z` entry. Each public entry
must include the version's GitHub Release link, a one-sentence user-facing
summary, and at least one non-empty change category.

Use this body shape for `releases/vX.Y.Z.md` because GitHub already renders the
release title, tag, author, and publish date around the notes:

```md
This release helps users ...

## New

- ...

## Improved

- ...

## Fixed

- ...
```

Do not add an initial `# Rudder vX.Y.Z` heading, `Released: YYYY-MM-DD` line, or
installation instructions. Omit any category that has no user-facing item.

For public docs, wrap every release in Mintlify's `Update` component so the
page retains its date-and-version timeline. Put the localized release date in
`label`, the version in `description`, and the non-empty change categories in
`tags`. Keep `## vX.Y.Z` inside the component because the release gate and
stable links use that version heading. English uses `New`, `Improved`, `Fixed`,
and optional `Upgrade notes`; Chinese uses `新功能`, `改进`, `问题修复`, and
optional `升级说明`. Only include categories that contain meaningful
user-facing changes:

```mdx
<Update label="Month D, YYYY" description="vX.Y.Z" tags={["New","Fixed"]}>

## vX.Y.Z

[GitHub Release](...)

One sentence describing the release's value to users.

### New

- ...

### Fixed

- ...

</Update>
```

```mdx
<Update label="YYYY年M月D日" description="vX.Y.Z" tags={["新功能","问题修复"]}>

## vX.Y.Z

[GitHub Release](...)

一句话说明这个版本为用户带来的价值。

### 新功能

- ...

### 问题修复

- ...

</Update>
```

Write from the user's perspective: what they can now do, what became easier or
more reliable, and whether they need to take action. Do not expose release
plumbing such as CI checks, source locking, branch history, workflow inputs,
account approvals, deployment authorization, or maintainer-only cleanup.
Put those details in engineering docs or the release closeout record.

Recommended agent generation flow:

1. Freeze the stable SHA and previous stable tag.
2. Start one release-notes subagent with that exact diff and the three required
   output paths. Ask it to draft only user-visible outcomes, localized
   naturally, with no release plumbing.
3. In parallel, keep the primary agent on version/tag/npm preflight and CI
   evidence.
4. Have the primary agent review factual coverage, integrate the three files,
   and run stable preflight plus docs checks.

The subagent drafts narratives but does not select or retarget the release
source, publish, or push independently. The repo intentionally does not generate
notes through GitHub Actions because:

- canaries are too frequent
- stable notes are the only public narrative surface that needs LLM help
- maintainer LLM tokens should not live in Actions

If stable npm publication succeeds but the Docs Release child workflow
fails, do not publish the same npm version again. Fix the docs deployment and
use **Re-run failed jobs** for the original Release workflow so it reuses the
existing `vX.Y.Z` tag. The next-release-base job remains blocked until the
matching public changelog deploy passes. For historical releases such as
`v0.5.1`, which predate this automation, run `Docs Release` manually from
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

### If GitHub binaries exist but the COS mirror fails

Do not upload or overwrite `SHASUMS256.txt` manually and do not republish npm.
Fix the OIDC/STS, CAM policy, COS availability, or immutable-object conflict,
then re-run the failed `mirror-stable` or `mirror-canary` job. Stable partial
recovery must use the original Release `candidate_run_id`, which downloads the
same frozen Desktop artifacts. The recovery workflow must run from a reviewed
main-history revision, while `source_ref` identifies the original stable tag
commit. The mirror step verifies the downloaded artifacts against the existing
GitHub Release before upload. Identical existing GitHub/COS bytes are accepted;
any same-name content conflict blocks completion.

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
