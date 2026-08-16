# Release Automation Setup

This document covers the GitHub and npm setup required for the current Rudder release model:

- automatic canaries from `main`
- manual stable promotion from a full locked commit SHA
- npm trusted publishing via GitHub OIDC
- Tencent COS Desktop mirroring via GitHub OIDC and Tencent STS
- direct-main release execution with exact-source Test

Repo-side files that depend on this setup:

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/docs-production.yml`
- `.github/CODEOWNERS`

The `Release` workflow needs `actions: write` because it inspects exact-source
Test runs and starts Test for the generated post-stable version commit. It needs
`contents: write` to push release tags and the direct version handoff commit to
`main`. A tag or branch push performed with `GITHUB_TOKEN` will not, by itself,
trigger a second workflow run, so the workflow dispatches handoff Test
explicitly.

Note:

- Release candidate jobs use `pnpm install --frozen-lockfile` because the exact
  source commit must already have passed Test dependency resolution
- canary publishing begins from the successful `Test` workflow-run SHA; manual
  stable dispatches query Test for the exact immutable source before installing
  dependencies
- release-specific preflight rejects stale versions and missing notes before
  package installation or build work
- stable preflight also rejects a missing English or Chinese public changelog
  entry, and an approved stable invokes Docs Release from the
  immutable stable tag

## 1. Merge the Repo Changes First

Before touching GitHub or npm settings, merge the release automation code so the referenced workflow filenames already exist on the default branch.

Required files:

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/docs-production.yml`
- `.github/CODEOWNERS`

## 2. Configure npm Trusted Publishing

Do this for every public package that Rudder publishes.

At minimum that includes:

- `@rudderhq/cli`
- `@rudderhq/server`
- public packages under `packages/`

### 2.1. In npm, open each package settings page

For each package:

1. open npm as an owner of the package
2. go to the package settings / publishing access area
3. add a trusted publisher for the GitHub repository `Undertone0809/rudder`

### 2.2. Add one trusted publisher entry per package

npm currently allows one trusted publisher configuration per package.

Configure:

- workflow filename: `release.yml`

Repository:

- owner or organization: `Undertone0809`
- repository: `rudder`

Environment name:

- leave the npm trusted-publisher environment field blank

Why:

- the single `release.yml` workflow handles both canary and stable publishing
- GitHub environments `npm-canary` and `npm-stable` still isolate publishing
  credentials and restrict deployments to their configured branches
- npm asks for only the workflow filename, not `.github/workflows/release.yml`

### 2.3. Verify trusted publishing before removing old auth

After the workflows are live:

1. run a canary publish
2. confirm npm publish succeeds without any `NPM_TOKEN`
3. run a stable dry-run
4. run one real stable publish
5. confirm the Release workflow attaches portable assets to GitHub, mirrors them
   to Tencent COS, and publishes `SHASUMS256.txt` only after the mirror succeeds

Only after that should you remove old token-based access.

### 2.4. Desktop portable assets and COS completion gate

The unified Release workflow publishes checksum-verified portable assets:

- macOS `.zip` containing `Rudder.app`
- Windows `.zip` containing the unpacked Electron app
- Linux `.AppImage`
- `SHASUMS256.txt`

The current Desktop channel is an unsigned portable alpha. Apple Developer ID,
notarization, and Windows code-signing reputation are intentionally deferred;
when those credentials exist, signed installer assets can be added as a separate
release path without changing npm publishing.

GitHub Releases remain authoritative for tags, version metadata, filenames, and
`SHASUMS256.txt`. The publish job first uploads only the seven `Rudder-*`
binaries. A separate job using the `desktop-release-mirror` Environment obtains
GitHub OIDC and Tencent STS credentials, copies the same frozen Actions artifacts
to COS without overwrite, and verifies authenticated and anonymous reads. Only
then does it upload GitHub `SHASUMS256.txt` as the completion marker. A COS copy
of the checksum supports network probing but never becomes the CLI trust root.
Before that transfer, the mirror compares each local binary with the GitHub
Release asset's API-provided SHA-256 digest when available. Older API responses
fall back to downloading the asset for the same byte-level check, so a slow
GitHub asset network cannot make the normal path spend the entire mirror timeout
re-downloading binaries.

Temporary fallback:

- If trusted publishing is not configured yet, add an environment secret named
  `NPM_TOKEN` to both `npm-canary` and `npm-stable`.
- Use a granular npm automation token with publish access to the `@rudderhq`
  packages.
- Remove the token once trusted publishing has been verified.

## 3. Remove Legacy npm Tokens

After trusted publishing works:

1. revoke any repository or organization `NPM_TOKEN` secrets used for publish
2. revoke any personal automation token that used to publish Rudder
3. if npm offers a package-level setting to restrict publishing to trusted publishers, enable it

Goal:

- no long-lived npm publishing token should remain in GitHub Actions

## 4. Create GitHub Environments

Create three environments in the GitHub repository:

- `npm-canary`
- `npm-stable`
- `desktop-release-mirror`

Path:

1. GitHub repository
2. `Settings`
3. `Environments`
4. `New environment`

### 4.1. Configure `desktop-release-mirror`

Store no Tencent SecretId or SecretKey. Add these non-sensitive Environment
variables:

- `TENCENT_CLOUD_OIDC_PROVIDER_ID`
- `TENCENT_CLOUD_ROLE_ARN`
- `TENCENT_COS_BUCKET`
- `TENCENT_COS_REGION` (`ap-shanghai`)

Allow deployments from `main`, `v*`, and `canary/v*`. The current unified
workflow executes the mirror jobs from `main`; tag rules preserve a constrained
recovery path if a future workflow is tag-triggered.

Create Tencent CAM OIDC provider `github-actions-rudder` with:

- issuer: `https://token.actions.githubusercontent.com`
- audience: `sts.cloud.tencent.com`
- automatic public-key rotation enabled

Role `rudder-github-release-mirror` must trust only
`name/sts:AssumeRoleWithWebIdentity` from that provider and require both claims:

```text
oidc:aud = sts.cloud.tencent.com
oidc:sub = repo:Undertone0809/rudder:environment:desktop-release-mirror
```

Attach a resource policy granting only `name/cos:HeadObject`,
`name/cos:GetObject`, and `name/cos:PutObject` on
`qcs::cos:ap-shanghai:uid/<APPID>:rudder-releases-cn-<APPID>/releases/*`.
Do not grant bucket listing, deletion, ACL mutation, or overwrite management.
COS maps the signed `HEAD Object` existence check to the distinct
`name/cos:HeadObject` action; `name/cos:GetObject` alone returns `403` even
when the object is absent. Verify both the `HEAD` check and a real object read
with the STS session before accepting a new environment or role configuration.

The `publish-canary` and `publish-stable` jobs also request GitHub's
`id-token: write` permission solely for npm provenance used by
`npm publish --provenance`. They run in the npm environments and do not receive
Tencent variables or call Tencent STS. Only `mirror-canary` and
`mirror-stable`, both in `desktop-release-mirror`, use that permission for the
Tencent OIDC exchange.

Create `rudder-releases-cn-<APPID>` in Shanghai using single-AZ standard
storage. Keep its ACL private, enable SSE-COS, and leave versioning, access logs,
and lifecycle deletion disabled. Its bucket policy may grant anonymous
`name/cos:GetObject` only on `releases/*`; anonymous listing and writes must
return `403`.

Set a monthly RMB 20 budget with alerts at 50%, 80%, and 100% to the default
finance contact and Message Center. This budget only alerts. It must not delete
immutable release objects or bypass the mirror gate.

## 5. Configure `npm-canary`

Recommended settings for `npm-canary`:

- environment name: `npm-canary`
- required reviewers: none
- wait timer: none
- deployment branches and tags:
  - selected branches only
  - allow `main`

Reasoning:

- every push to `main` should be able to publish a canary automatically
- no human approval should be required for canaries

## 6. Configure `npm-stable`

Required settings for `npm-stable`:

- environment name: `npm-stable`
- required reviewers: none
- prevent self-review: disabled
- admin bypass: disabled
- wait timer: none
- deployment branches and tags:
  - selected branches only
  - allow `main`

Reasoning:

- an explicit release/publish request is the human authorization gate; when the
  version is omitted, the agent may infer the single consistent stable target
  from the repository release state and state it before publishing
- locked source SHA, exact successful Test, and immutable-version checks form the
  mandatory machine gate
- the environment isolates stable credentials and limits use to `main` without
  introducing an account switch or reviewer click

## 7. Direct `main` Release Flow

Stable release work does not require a PR, branch-protection approval, repository
attestation variable, or workflow confirmation phrase. The release agent pushes
the validated source directly to `main`; the workflow then requires that exact
SHA to have a successful `main` Test run before it can publish.

The generated post-stable `[skip release]` version commit is also pushed
directly to `main`, followed by an explicit CI dispatch for its immutable SHA.

## 8. CODEOWNERS

`.github/CODEOWNERS` remains useful for optional review routing, but the standard
release path does not require a CODEOWNERS approval.

## 9. Protect Release Infrastructure Specifically

These files should always trigger code owner review:

- `.github/workflows/release.yml`
- `.github/workflows/ci.yml`
- `.github/workflows/docs-production.yml`
- `scripts/release.sh`
- `scripts/release-lib.sh`
- `scripts/release-package-map.mjs`
- `scripts/create-github-release.sh`
- `scripts/cleanup-obsolete-canaries.mjs`
- `scripts/collect-desktop-release-assets.mjs`
- `scripts/mirror-desktop-release-to-cos.mjs`
- `scripts/publish-github-release-assets-immutable.mjs`
- `scripts/rollback-latest.sh`
- `doc/engineering/RELEASING.md`
- `doc/engineering/PUBLISHING.md`

If you want stronger controls, add a repository ruleset that explicitly blocks direct pushes to:

- `.github/workflows/**`
- `scripts/release*`

## 10. Do Not Store a Claude Token in GitHub Actions

Do not add a personal Claude or Anthropic token for automatic changelog generation.

Recommended policy:

- stable changelog generation happens locally from a trusted maintainer machine
- canaries never generate changelogs

This keeps LLM spending intentional and avoids a high-value token sitting in Actions.

## 11. Verify the Canary Workflow

After setup:

1. merge a harmless commit to `main`
2. confirm the exact push passes the `Test` workflow
3. open the `Release` workflow run triggered by that successful Test run and
   confirm its preflight reports the same source SHA
4. confirm publish succeeds under the `npm-canary` environment
5. confirm npm now shows a new `canary` release
6. confirm a git tag named `canary/v0.1.0-canary.N` was pushed
7. confirm the Release candidate matrix built and smoked all four platform assets before npm publication
8. confirm the canary GitHub Release contains macOS, Windows, Linux, and `SHASUMS256.txt` assets from that matrix
9. confirm `mirror-canary` used `desktop-release-mirror` and published all eight
   byte-identical objects under `releases/canary/v0.1.0-canary.N/`
10. confirm anonymous exact COS reads succeed while listing and writes return `403`
11. confirm the three-platform public install matrix passed only after `mirror-canary`
12. confirm the canary GitHub Release title is `v0.1.0-canary.N`, while the tag remains `canary/v0.1.0-canary.N`

Start-path check:

```bash
npx @rudderhq/cli@canary onboard
```

## 12. Verify the Stable Workflow

After at least one good canary exists:

1. freeze the tested immutable source SHA immediately; do not chase later
   unrelated `main` commits
2. confirm the committed public package version on the source SHA is the stable
   version you want to ship
3. when notes are missing, have a bounded release-notes subagent draft
   `releases/v0.1.0.md`, `docs/releases.mdx`, and `docs/zh/releases.mdx` in
   parallel with read-only preflight; the primary release agent reviews and
   integrates them
4. confirm the exact final source has successful main Test, stable preflight,
   package validation, and no conflicting npm version or tag
5. if a same-base canary is only waiting for Desktop assets, record its npm/tag
   state and stop that remaining work; do not unpublish the npm canary
6. open `Actions` -> `Release` and run one production execution with:
   - `source_ref`: the locked commit SHA
   - `dry_run`: `false`
7. use `dry_run: true` only for a read-only preview or troubleshooting request,
   not as a mandatory first dispatch for an already-authorized release
8. confirm the `npm-stable` job starts without an interactive approval
9. confirm npm `latest` points to the new stable version
10. confirm git tag `v0.1.0` exists
11. confirm the GitHub Release was created
12. confirm the GitHub Release contains macOS, Windows, Linux, and
    `SHASUMS256.txt` assets
13. confirm `mirror-stable` copied the same frozen Desktop candidate artifacts to
    `releases/v0.1.0/` and completed before the checksum marker appeared
14. confirm the Docs Release child workflow publishes `docs/release/v0.1.0`
    from the matching `v0.1.0` source and passes public health checks
15. confirm Windows, macOS, and Linux public install smoke all pass; do not
    remove a slow Windows smoke because it measures real installation behavior
16. confirm the workflow commits the next patch version directly to `main` and
    dispatches Test for that exact commit, or reports that `main` already advanced

Start-path check:

```bash
npx @rudderhq/cli@latest start --no-open
```

After the persistent CLI has been prepared, the equivalent direct check is:

```bash
rudder start --no-open
```

Implementation note:

- the GitHub Actions stable workflow calls `create-github-release.sh` with `PUBLISH_REMOTE=origin`
- local maintainer usage can still pass `PUBLISH_REMOTE=public-gh` explicitly when needed

## 13. Suggested Maintainer Policy

Use this policy going forward:

- canaries are automatic and cheap
- stables start from an explicit release/publish request; the agent resolves an
  omitted version when exactly one stable target is consistent, then runs end
  to end without another user or GitHub approval
- only stables get public notes and announcements
- release notes are drafted by a bounded subagent in parallel when useful,
  reviewed by the primary release agent, and committed before stable publish
- stable source freezes immediately when release authority arrives
- an authorized stable uses one production execution after exact-source gates,
  rather than mandatory preview and publish dispatches
- same-base canary Desktop waiting does not outrank a gated stable release
- stable docs deploy is included automatically unless explicitly excluded
- cross-platform public install smoke remains mandatory even when one platform
  exposes a real performance bottleneck
- rollback uses `npm dist-tag`, not unpublish

## 14. Troubleshooting

### Trusted publishing fails with an auth error

Check:

1. the workflow filename on GitHub exactly matches the filename configured in npm
2. the package has the trusted publisher entry for the correct repository
3. the job has `id-token: write`
4. the job is running from the expected repository, not a fork

### Stable workflow remains queued or waiting

Check:

1. the `publish` job uses environment `npm-stable`
2. the environment has no required reviewers or wait timer
3. the environment allows only `main`
4. the workflow is running in the canonical repository, not a fork

### COS mirror fails before the checksum marker

Check:

1. `mirror-canary` or `mirror-stable` uses Environment `desktop-release-mirror`
2. the job has `id-token: write` and all four Environment variables
3. Tencent OIDC `aud` and `sub` conditions exactly match the documented values
4. the CAM role can head/get/put this bucket's `releases/*` objects, including
   the distinct `name/cos:HeadObject` action required by the signed existence check
5. an existing object is byte-identical; conflicting immutable objects require
   investigation and must never be overwritten

The mirror jobs allow 120 minutes for the upload and authenticated/anonymous
readback of all seven large binaries. A run that reaches the timeout before its
first `verified` line is usually spending time on a legacy GitHub asset download;
check that the Release API returns `sha256:` asset digests before extending the
timeout again.

Re-run the failed mirror job after fixing credentials or network state. The
GitHub checksum marker remains absent until COS succeeds. For partial stable
recovery after the mirror code or credentials changed, dispatch the same
`release.yml` workflow with `mirror_recovery=true`, the current reviewed main
commit as `source_ref`, the existing Release tag as `recovery_tag`, and the
original Release `candidate_run_id`. This path downloads only the frozen
Desktop artifacts from that run, does not republish npm, retag Git, or rebuild
Desktop, and publishes the GitHub checksum marker only after COS succeeds.
Do not use a branch or a newly generated artifact run for `source_ref`.

### Optional CODEOWNERS routing does not trigger

Check:

1. `.github/CODEOWNERS` is on the default branch
2. the owner identities in the file are valid reviewers with repository access

CODEOWNERS routing is optional and is not part of the release gate.

## Related Docs

- [doc/engineering/RELEASING.md](RELEASING.md)
- [doc/engineering/PUBLISHING.md](PUBLISHING.md)
- [doc/plans/2026-03-17-release-automation-and-versioning.md](plans/2026-03-17-release-automation-and-versioning.md)
