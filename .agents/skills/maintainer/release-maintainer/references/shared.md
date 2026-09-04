# Shared Release Workflow

## Canonical Sources

Read only what the selected branch needs:

- `doc/engineering/RELEASING.md`: maintainer lifecycle.
- `doc/engineering/PUBLISHING.md`: package map and npm internals.
- `doc/engineering/RELEASE-AUTOMATION-SETUP.md`: one-time setup.
- `.github/workflows/release.yml`: stable/canary orchestration.
- `.github/workflows/ci.yml`: exact-source Test qualification.
- `.github/workflows/docs-production.yml`: immutable production docs deployment.
- `.github/workflows/npm-dist-tag.yml`: dist-tag repair.
- `scripts/release.sh`: version resolution and preflight.
- `scripts/release-package-map.mjs`: public package set.
- `scripts/prepare-next-release.mjs`: post-stable handoff.
- `scripts/create-github-release.sh`: GitHub Release creation.
- `scripts/promote-npm-dist-tag.mjs` and `scripts/rollback-latest.sh`: dist-tags.
- `scripts/collect-desktop-release-assets.mjs`: Desktop candidate collection.

During an active release, workflows and scripts are executable truth. Record
and repair documentation drift after the locked release is safe.

## Fast State Check

Collect local state:

```bash
git status --short --branch
git log --oneline --decorate --graph -8
node scripts/release-package-map.mjs list
./scripts/release.sh stable --print-version
./scripts/release.sh stable --preflight
./scripts/release.sh canary --print-version
./scripts/release.sh canary --preflight
```

Collect remote truth when applicable:

```bash
gh run list --workflow release.yml --limit 10
gh run list --workflow ci.yml --limit 10
gh run list --workflow docs-production.yml --limit 10
gh run list --workflow npm-dist-tag.yml --limit 5
gh release list --repo Undertone0809/rudder --limit 100
git ls-remote --tags origin 'refs/tags/canary/v*'
npm view @rudderhq/cli dist-tags --json
npm view @rudderhq/cli versions --json
```

Run preflight before dependency installation or expensive builds. A stale base,
existing immutable version, missing stable notes, or wrong source should fail
early.

## Source And Concurrency

- On an explicit stable release request, resolve and freeze the immutable SHA
  before drafting notes or waiting on unrelated `main` work. Later commits are
  next-release candidates unless the user explicitly retargets the release.
- Manual stable dispatch accepts the full 40-character commit SHA only. This
  gives automatic canary and manual stable runs the same concurrency identity;
  a real stable dispatch replaces duplicate automatic work for that source.
- Canary and stable share the non-cancelling `release-publish` concurrency
  group in the current workflow.
- Do not let an in-flight canary for the same or an older base hold a ready
  stable release behind Desktop asset generation. After the locked stable SHA
  passes exact-source CI and stable preflight, record whether canary npm/tag
  mutation completed, then cancel or stop the canary's remaining wait and
  dispatch stable. Never unpublish its npm version; stable cleanup handles its
  obsolete Release/tag.
- Do not stop an active next-line canary or a canary from a source the stable
  release does not supersede.
- GitHub concurrency is not FIFO and retains only one pending job. If a stable
  run is superseded, rerun the same locked SHA after the active publish ends.
- A `GITHUB_TOKEN` tag push does not trigger another workflow automatically;
  the unified Release uploads its own verified Desktop artifacts and explicitly
  dispatches only the post-stable Test handoff.
- After a stable campaign begins, release-only candidate repairs use
  `[skip release]` unless canary publication is explicitly required. Confirm CI
  for the repair SHA and confirm the automatic Release workflow was skipped.

## Progressive Qualification And Candidate Identity

`Test` uses `scripts/ci-impact-plan.mjs` and always exposes the aggregate
`Qualification summary` job. Bounded pull requests use affected families;
docs-only changes add docs qualification; workflow, release, dependency,
shared-contract, database, native, Desktop, and unbounded changes escalate to
the full family set. `merge_group`, exact-source manual runs, and pushes to
`main` are full qualification profiles. Release promotion requires the
successful aggregate receipt for the exact source SHA.

The Release workflow creates one immutable candidate manifest for the 15 npm
and seven Desktop artifacts. It binds source commit and tree, qualification
run, candidate run, release workflow source, runtime identity, sizes, SHA-256
digests, checksums, and a seven-day expiry. `candidate-verify` and each publish
job re-verify the downloaded candidate from the recorded run ID. A stable
promotion with `candidate_run_id` may reuse those bytes, but an expired or
mismatched manifest must fail before npm, Git, GitHub Release, Desktop, COS,
or docs mutation.

## Convergence Budget

- Do not dispatch stable while exact-source CI is still running. One candidate
  SHA gets one exact-source CI and one production stable execution.
- Do not run manual stable and automatic canary gates concurrently for the same
  SHA. Use the full SHA so workflow concurrency can replace the duplicate path.
- The three-fixture historical migration runtime must finish within five
  minutes per platform and emit its current phase every ten seconds. The full
  prepublish platform job has a 25-minute hard ceiling, including packaged
  Desktop verification.
- A timeout is a failure with a named last phase, not permission to increase the
  timeout. Fix the blocked lifecycle or process ownership before rerunning.
- After two failures at the same stage with unchanged inputs, stop dispatching.
  Record the run IDs, last phase, elapsed time, and candidate SHA; make one
  scoped repair and start again from exact-source CI.

## Single Stable Execution

An explicit stable imperative authorizes one production execution. Run
exact-source CI, stable preflight, version immutability checks, and package
validation before the first publish mutation, then continue in the same
workflow/run. Do not dispatch a preview workflow and later repeat checkout,
dependency installation, and validation in a second workflow.

If the executable workflow still exposes a legacy `dry_run` input, use the real
stable path only after the equivalent exact-source gates have passed and record
the workflow consolidation as follow-up work. Do not replace machine validation
with human confidence.

## Package And Desktop Verification

Verify the complete package map, not only the CLI. Verify exact versions and
the intended dist-tag for every public package.

Expected Desktop asset family (portable and shell assets where the platform
produces both):

- Linux x64 AppImage
- macOS arm64 portable zip
- macOS x64 portable zip
- Windows x64 portable zip
- `SHASUMS256.txt`

A package preview proves resolution only. User-facing install claims require a real
isolated `npx ... start --no-open` download/install smoke on the available
platform. When update behavior changed, also perform an older-installed-build
to candidate update drill.

## Safety

- Never print or persist npm tokens. Use a temporary npmrc when bootstrap
  credentials are explicitly supplied, then remove it and recommend rotation.
- Do not unpublish as rollback or cleanup.
- Do not force-push/retarget published tags without exact authority.
- Do not delete the active next-line canary during stable cleanup.
- Do not treat anonymous GitHub REST `403` as proof that a Release is absent;
  check authenticated `gh release view` and direct asset state.
- Do not use a package preview as proof of download, checksum, extraction, symlink,
  quarantine, or launch behavior.

## Final Evidence

Before completion, record:

- version, channel, locked SHA, and tag target;
- CI/release/Desktop/docs workflow run IDs and conclusions;
- npm version/dist-tags across the package map;
- GitHub Release name, prerelease/draft flags, and assets;
- install/update proof appropriate to the changed area;
- obsolete canary cleanup and retained active line;
- next-version main handoff and its CI;
- stable Discord announcement server, channel, direct message URL, ping state,
  follower cross-post state, and rendered readback;
- preserved unrelated work or remaining blockers.
