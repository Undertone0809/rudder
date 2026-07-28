# Shared Release Workflow

## Canonical Sources

Read only what the selected branch needs:

- `doc/engineering/RELEASING.md`: maintainer lifecycle.
- `doc/engineering/PUBLISHING.md`: package map and npm internals.
- `doc/engineering/RELEASE-AUTOMATION-SETUP.md`: one-time setup.
- `.github/workflows/release.yml`: stable/canary orchestration.
- `.github/workflows/desktop-release.yml`: Desktop assets.
- `.github/workflows/npm-dist-tag.yml`: dist-tag repair.
- `scripts/release.sh`: version resolution and preflight.
- `scripts/release-package-map.mjs`: public package set.
- `scripts/prepare-next-release.mjs`: post-stable handoff.
- `scripts/create-github-release.sh`: GitHub Release creation.
- `scripts/promote-npm-dist-tag.mjs` and `scripts/rollback-latest.sh`: dist-tags.
- `scripts/wait-for-desktop-release-assets.mjs`: Desktop completion.

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
gh run list --workflow desktop-release.yml --limit 10
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

- Resolve branches to immutable SHAs before publish.
- Canary and stable share the non-cancelling `release-publish` concurrency
  group. Do not start a competing publish path.
- GitHub concurrency is not FIFO and retains only one pending job. If a stable
  run is superseded, rerun the same locked SHA after the active publish ends.
- A `GITHUB_TOKEN` tag push does not trigger another workflow automatically;
  dispatch Desktop explicitly where the workflow requires it.
- Release-maintenance commits that should not publish canary use
  `[skip release]`, and the resulting release workflow must be observed as
  skipped.

## Package And Desktop Verification

Verify the complete package map, not only the CLI. Verify exact versions and
the intended dist-tag for every public package.

Expected Desktop asset family:

- Linux x64 AppImage
- macOS arm64 portable zip
- macOS x64 portable zip
- Windows x64 portable zip
- `SHASUMS256.txt`

A dry-run proves resolution only. User-facing install claims require a real
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
- Do not use a dry-run as proof of download, checksum, extraction, symlink,
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
- preserved unrelated work or remaining blockers.
