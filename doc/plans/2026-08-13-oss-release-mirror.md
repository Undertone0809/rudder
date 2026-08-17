---
title: Tencent COS Release Mirror
date: 2026-08-13
kind: implementation
status: in_progress
area: desktop
entities:
  - desktop_release
  - cli_start
  - release_mirror
issue:
related_plans: []
supersedes: []
owners:
  - release-maintainer
updated_at: 2026-08-14
---

# Tencent COS Release Mirror

## Intent

Make Rudder's Desktop-first installation reliable on mainland-China networks
without changing GitHub Releases as the authoritative release record. Every
stable and canary Desktop release mirrors each checksum-verified asset to
Tencent Cloud COS after GitHub publication, and `rudder start`
should automatically prefer the network path that is usable from the current
machine.

The mirror is a transport optimization. It must not become a second source of
version truth, weaken checksum validation, or turn a failed mirror upload into
a silently incomplete stable release.

## Decisions

1. GitHub Releases remain authoritative for release metadata, tags, asset
   names, and `SHASUMS256.txt`.
2. COS stores byte-identical immutable copies under the slash-preserving release tag.
3. The COS bucket is private. A bucket policy permits anonymous exact
   `GetObject` under `releases/*`; listing and write access remain denied.
4. GitHub Actions authenticates to Tencent Cloud with GitHub OIDC, Tencent STS,
   and a least-privilege CAM role. No long-lived SecretId or SecretKey is stored
   in GitHub.
5. Automatic selection uses bounded network probes of the same checksum object
   on COS and GitHub. It does not disclose the user's IP to a third-party GeoIP
   service. `cn` and `global` overrides remain available for deterministic
   operation and support.
6. COS download or checksum failure falls back to the GitHub asset. The asset
   is always accepted only after matching the GitHub-authored SHA-256 checksum.
7. Versioned objects are never overwritten. Retrying a release succeeds only
   when the existing COS object is byte-identical.
8. CDN is not part of this delivery. It can be placed in front of the same COS
   paths later without changing the release identity or CLI contract.

## Release Flow

```text
immutable source SHA
  -> unified Release matrix builds and freezes four Desktop artifacts
  -> publish job downloads those artifacts and generates SHASUMS256.txt
  -> GitHub Release receives only the immutable binary assets
  -> separate stable/canary COS mirror job uses environment desktop-release-mirror
  -> mirror job downloads the same frozen artifacts
  -> mirror job authenticates with GitHub OIDC and Tencent STS
  -> mirror script verifies local checksums
  -> mirror script compares GitHub asset SHA-256 metadata when available
  -> upload versioned objects without overwrite
  -> fetch COS objects and verify size/hash/readability
  -> GitHub Release receives SHASUMS256.txt as the completion marker
  -> public install and stable closeout require the mirror job to succeed
```

The object layout is:

```text
releases/<slash-preserving-tag>/Rudder-<version>-<platform>-<arch>-<kind>.<ext>
releases/<slash-preserving-tag>/SHASUMS256.txt
```

For example, stable `v0.7.5` uses `releases/v0.7.5/`, while canary tag
`canary/v0.7.5-canary.1` uses `releases/canary/v0.7.5-canary.1/`.

## CLI Flow

1. Resolve the exact release and checksum/asset names from GitHub as today.
2. Build byte-identical COS candidate URLs from the immutable release tag.
3. In `auto`, probe the COS and GitHub checksum URLs with short, bounded
   requests and prefer the first healthy source. In `cn`, try COS first. In
   `global`, use GitHub first.
4. Download `SHASUMS256.txt`, select the shell or full asset, then download and
   verify the expected SHA-256.
5. If the preferred source fails at checksum download, asset download, or
   verification, retry the same asset from GitHub before reporting failure.

Configuration:

```text
RUDDER_DOWNLOAD_SOURCE=auto|cn|global
RUDDER_RELEASE_MIRROR_BASE_URL=https://<bucket>.cos.<region>.myqcloud.com
rudder start --download-source auto|cn|global
```

The production mirror base URL is compiled into the CLI. The environment
variable exists for staging, recovery, and black-box verification.

## Security And Cost Controls

- CAM role scope is limited to `HeadObject`, `PutObject`, and `GetObject` under
  the release prefix for one bucket. COS authorizes `HEAD Object` with the
  distinct `name/cos:HeadObject` action.
- Bucket listing, deletion, and overwrite are not granted to CI.
- Object names and content types are allowlisted by the mirror script.
- The workflow verifies every object after upload and never logs credentials.
- GitHub Release asset digests avoid a second full download before COS upload;
  responses without a digest retain the byte-level download fallback.
- Tencent Cloud billing alerts fire at 50%, 80%, and 100% of a monthly RMB 20 budget.
- GitHub remains the fallback so disabling the mirror is a configuration
  change, not a release rollback.

## Acceptance Criteria

1. Unit tests cover source parsing, tag encoding, auto/explicit ordering,
   checksum URL rewriting, COS failure, corrupt COS content, and GitHub
   fallback.
2. Workflow contract tests prove OIDC/STS permissions, immutable upload semantics,
   checksum verification, mirror completion before Desktop publication is
   reported complete, and downstream release work remains blocked when either
   stable or canary mirror fails. Stable partial recovery must reuse the original
   Release `candidate_run_id` rather than rebuilding Desktop artifacts.
3. A real COS object can be fetched anonymously by exact URL but the bucket
   cannot be listed or written anonymously.
4. A current public Rudder release is mirrored byte-identically and verified
   against GitHub `SHASUMS256.txt`.
5. An isolated `rudder start --download-source cn --no-open` downloads from COS
   and installs successfully on the available platform.
6. The same command succeeds through GitHub when the COS URL is deliberately
   unavailable.
7. Reviewer accepts intent, implementation, release taste, and evidence;
   verifier returns `PASS` for the frozen candidate; final reviewer accepts the
   unchanged candidate.

## Documentation Impact

- Update contributor CLI, Desktop, publishing, releasing, and release setup
  documentation.
- Rehearse with the existing public `v0.7.3` assets. Do not publish `0.7.5` as
  part of this delivery.
- No guarded `doc/product/**` change is required because this preserves the
  existing checksum-verified installation outcome and only changes transport.
