# 2026-03-31 Semver Reset And Release Alignment

## Goal

Reset all Rudder workspace package versions to `0.1.0` and switch release automation from calendar-version publish-time rewriting to a committed semver workflow owned by Rudder.

This is a product and distribution cleanup move:

- stop carrying forward Paperclip-era package versions
- make repo version state match published version state
- establish a simple semver line that Rudder can maintain intentionally

## Approved Decisions

- All Rudder workspace packages move to `0.1.0`
- Release automation moves to semver-based publishing
- `stable` publishes the committed package version as `latest`
- `canary` publishes a prerelease derived from the committed version, for example `0.1.0-canary.0`
- Keep dist-tags (`latest`, `canary`)
- Minimal diff, no unrelated release-system redesign

## Why This Change

Today the repo has two version systems:

1. committed package versions in workspace manifests
2. calendar versions generated during release

That split is confusing and easy to break. A builder looking at the repo cannot tell what version users actually install.

This change makes version truth boring again:

- the version in git is the version we mean
- stable release tags map directly to package versions
- docs and release workflow speak the same language

## What Already Exists

- [scripts/release.sh](/Users/zeeland/projects/rudder/scripts/release.sh) orchestrates verify, build, version rewrite, publish, npm verification, and git tagging
- [scripts/release-package-map.mjs](/Users/zeeland/projects/rudder/scripts/release-package-map.mjs) discovers public packages and rewrites versions plus workspace dependency pins
- [scripts/release-lib.sh](/Users/zeeland/projects/rudder/scripts/release-lib.sh) owns shared release helpers like npm auth, tag lookup, and package discovery
- [.github/workflows/release.yml](/Users/zeeland/projects/rudder/.github/workflows/release.yml) runs canary on `main` pushes and stable via manual dispatch
- [scripts/build-npm.sh](/Users/zeeland/projects/rudder/scripts/build-npm.sh) generates a publishable CLI manifest from the committed CLI package metadata

Reuse plan:

- keep package discovery and publish ordering
- keep publish verification and dist-tags
- remove calendar-version computation
- remove stable release publish-time version rewrite
- keep CLI bundle generation, but ensure CLI version comes from committed semver

## Scope

### In Scope

- Set every workspace package version to `0.1.0`
- Align CLI displayed version with committed semver
- Update release scripts to publish committed semver for stable releases
- Update canary flow to derive semver prereleases from committed version
- Update GitHub workflow copy and expectations from calendar versioning to semver
- Update release/publishing docs that currently describe calendar versioning
- Update tests and fixtures that hardcode old package versions

### NOT in Scope

- Redesigning package boundaries or publish surface
- Introducing Changesets or a new release manager
- Per-package independent versioning
- Republishing historical versions or backfilling npm history
- Changing desktop artifact tagging beyond keeping it compatible with the new semver tags

## Package Set

Target package manifests:

- [cli/package.json](/Users/zeeland/projects/rudder/cli/package.json)
- [desktop/package.json](/Users/zeeland/projects/rudder/desktop/package.json)
- [packages/agent-runtime-utils/package.json](/Users/zeeland/projects/rudder/packages/agent-runtime-utils/package.json)
- [packages/agent-runtimes/claude-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/claude-local/package.json)
- [packages/agent-runtimes/codex-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/codex-local/package.json)
- [packages/agent-runtimes/cursor-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/cursor-local/package.json)
- [packages/agent-runtimes/gemini-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/gemini-local/package.json)
- [packages/agent-runtimes/openclaw-gateway/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/openclaw-gateway/package.json)
- [packages/agent-runtimes/opencode-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/opencode-local/package.json)
- [packages/agent-runtimes/pi-local/package.json](/Users/zeeland/projects/rudder/packages/agent-runtimes/pi-local/package.json)
- [packages/db/package.json](/Users/zeeland/projects/rudder/packages/db/package.json)
- [packages/plugins/create-rudder-plugin/package.json](/Users/zeeland/projects/rudder/packages/plugins/create-rudder-plugin/package.json)
- [packages/plugins/examples/plugin-authoring-smoke-example/package.json](/Users/zeeland/projects/rudder/packages/plugins/examples/plugin-authoring-smoke-example/package.json)
- [packages/plugins/examples/plugin-file-browser-example/package.json](/Users/zeeland/projects/rudder/packages/plugins/examples/plugin-file-browser-example/package.json)
- [packages/plugins/examples/plugin-hello-world-example/package.json](/Users/zeeland/projects/rudder/packages/plugins/examples/plugin-hello-world-example/package.json)
- [packages/plugins/examples/plugin-kitchen-sink-example/package.json](/Users/zeeland/projects/rudder/packages/plugins/examples/plugin-kitchen-sink-example/package.json)
- [packages/plugins/sdk/package.json](/Users/zeeland/projects/rudder/packages/plugins/sdk/package.json)
- [packages/shared/package.json](/Users/zeeland/projects/rudder/packages/shared/package.json)
- [server/package.json](/Users/zeeland/projects/rudder/server/package.json)
- [ui/package.json](/Users/zeeland/projects/rudder/ui/package.json)

## Implementation Plan

### 1. Reset committed package versions

- Update every workspace package manifest to `0.1.0`
- Update any source constants or tests that surface version numbers
- Keep root [package.json](/Users/zeeland/projects/rudder/package.json) unchanged because it is a private workspace root, not a published package

### 2. Make stable releases publish committed semver

- Remove stable date-based version resolution
- Remove stable publish-time manifest rewrites
- Make stable release require the committed public package versions to be aligned
- Tag stable releases as `v<committed-version>`
- Keep release notes file lookup semver-based

### 3. Keep canary useful without reintroducing dual truth

- Derive canary version from committed stable version
- Example:

```text
committed version: 0.1.0
canary publish:    0.1.0-canary.0
stable publish:    0.1.0
```

- Rewrite public package manifests only for the ephemeral canary publish payload
- Restore the worktree after publish as the current script already does

### 4. Update workflow and docs

- Rewrite workflow_dispatch text to ask for source ref, not release date
- Remove calendar-version examples from release docs
- Replace them with semver examples (`0.1.0`, `0.1.1`, `0.2.0`, `0.1.0-canary.0`)

## Architecture Diagram

```text
STABLE RELEASE
==============

git commit
  │
  ├── package.json versions already set in repo
  │       │
  │       └── release.sh reads committed version
  │               │
  │               ├── verify
  │               ├── build
  │               ├── publish @ committed semver
  │               ├── verify npm visibility
  │               └── tag v<version>
  │
  └── source of truth stays in git


CANARY RELEASE
==============

git commit @ 0.1.0
  │
  └── release.sh canary
          │
          ├── derive 0.1.0-canary.N
          ├── temporary rewrite public package payloads
          ├── publish under dist-tag canary
          ├── verify npm visibility
          └── restore worktree + tag canary/v0.1.0-canary.N
```

## Code Paths And Failure Modes

```text
[+] Package version reset
    ├── package.json version updates
    ├── CLI displayed version update
    └── fixture/test constant update

[+] Stable release path
    ├── read public package list
    ├── assert aligned committed versions
    ├── build artifacts
    ├── publish committed version
    ├── verify npm package visibility
    └── create stable git tag

[+] Canary release path
    ├── read committed base version
    ├── compute next canary prerelease
    ├── temporary rewrite public package payloads
    ├── publish prerelease
    ├── verify npm package visibility
    └── restore worktree and create canary tag
```

Failure modes:

| Codepath | Realistic failure | Test/guard plan | User impact |
|---|---|---|---|
| package reset | one package stays on old version | script-driven search + typecheck | inconsistent metadata |
| CLI version display | CLI still prints old version | targeted test fixture update | users see wrong install version |
| stable publish | public packages have mismatched committed versions | fail fast before publish | broken release, avoid partial publish |
| canary derive | prerelease sequence collides with npm | query npm and increment next slot | publish fails if wrong |
| canary cleanup | temporary rewritten manifests leak into worktree | keep cleanup trap and dry-run path | dirty tree, accidental bad commit |
| release docs | docs still mention calendar versions | explicit doc updates | operator confusion |

Critical silent-failure gap to avoid:

- publishing one package at a different committed semver than the rest with no preflight check

## Test Plan

### Unit / Script-Level

- update CLI install/version tests in [cli/src/__tests__/install.test.ts](/Users/zeeland/projects/rudder/cli/src/__tests__/install.test.ts)
- update release script helpers with targeted assertions where coverage exists
- verify `node scripts/release-package-map.mjs list` still returns the correct public package order

### Integration / Dry Run

- `./scripts/release.sh stable --dry-run`
  - should use committed semver
  - should not attempt date resolution
- `./scripts/release.sh canary --dry-run`
  - should derive `<version>-canary.N`
  - should restore workspace after dry-run

### Full Verification

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Parallelization

Sequential implementation, no parallelization opportunity.

Reason:

- version reset, release script alignment, workflow text, and release docs all touch the same distribution story
- splitting this would create more merge risk than speed

## Minimal Diff Strategy

- Prefer updating existing release helpers over introducing a new release tool
- Keep publish ordering and auth checks as-is
- Keep current cleanup trap model
- Do not add new release metadata files or abstractions unless existing code cannot express the semver flow cleanly

## Success Criteria

- every workspace package manifest is `0.1.0`
- CLI reports `0.1.0`
- stable release flow publishes committed semver without calendar version generation
- canary release flow publishes semver prereleases
- release docs no longer describe calendar versioning
- full verification passes
