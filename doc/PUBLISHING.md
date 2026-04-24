# Publishing to npm

Low-level reference for how Rudder packages are prepared and published to npm.

For the maintainer workflow, use [doc/RELEASING.md](RELEASING.md). This document focuses on packaging internals.

## Current Release Entry Points

Use these scripts:

- [`scripts/release.sh`](../scripts/release.sh) for canary and stable publish flows
- [`scripts/create-github-release.sh`](../scripts/create-github-release.sh) after pushing a stable tag
- [`scripts/rollback-latest.sh`](../scripts/rollback-latest.sh) to repoint `latest`
- [`scripts/build-npm.sh`](../scripts/build-npm.sh) for the CLI packaging build
- [`scripts/collect-desktop-release-assets.mjs`](../scripts/collect-desktop-release-assets.mjs) to normalize desktop installer asset names for GitHub Releases

Rudder no longer uses release branches or Changesets for publishing.

## Why the CLI needs special packaging

The CLI package, `@rudder/cli`, imports code from workspace packages such as:

- `@rudder/server`
- `@rudder/db`
- `@rudder/shared`
- adapter packages under `packages/agent-runtimes/`

Those workspace references are valid in development but not in a publishable npm package. The release flow builds a publishable CLI bundle from the committed semver metadata, and only rewrites versions temporarily for canary prereleases.

## `build-npm.sh`

Run:

```bash
./scripts/build-npm.sh
```

This script:

1. runs the forbidden token check unless `--skip-checks` is supplied
2. runs `pnpm -r typecheck`
3. bundles the CLI entrypoint with esbuild into `cli/dist/index.js`
4. verifies the bundled entrypoint with `node --check`
5. rewrites `cli/package.json` into a publishable npm manifest and stores the dev copy as `cli/package.dev.json`
6. copies the repo `README.md` into `cli/README.md` for npm metadata

After the release script exits, the dev manifest and temporary files are restored automatically.

## Package discovery and versioning

Public packages are discovered from:

- `packages/`
- `server/`
- `cli/`

`ui/` is ignored because it is private.

[`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs) is used to discover public packages and, when needed for canary publishes, to rewrite public package payloads. It:

- finds all public packages
- sorts them topologically by internal dependencies
- rewrites each public package version to the target canary prerelease version
- rewrites internal `workspace:*` dependency references to the exact target canary version
- updates the CLI's displayed version string

Stable releases do not rewrite versions. They publish the committed workspace semver directly.

Canary rewrites are temporary. The working tree is restored after publish or dry-run.

## Version formats

Rudder uses committed semver:

- stable: `X.Y.Z`
- canary: `X.Y.Z-canary.N`

Examples:

- stable: `0.1.0`
- canary: `0.1.0-canary.2`

## Publish model

### Canary

Canaries publish under the npm dist-tag `canary`.

Example:

- `@rudder/cli@0.1.0-canary.2`

This keeps the default install path unchanged while allowing explicit installs with:

```bash
npx @rudder/cli@canary onboard
```

### Stable

Stable publishes use the npm dist-tag `latest`.

Example:

- `@rudder/cli@0.1.0`

Stable publishes do not create a release commit. Instead:

- package versions are read from the chosen source commit
- packages are published from the chosen source commit
- git tag `vX.Y.Z` points at that original commit
- desktop installers are attached to the matching GitHub Release by
  `.github/workflows/desktop-release.yml`

The primary user install path is:

```bash
npx @rudder/cli@latest start
```

The `start` command checks npm for newer CLI releases, uses npm for the
persistent CLI, and uses GitHub Release assets for the desktop app. Desktop
binaries are intentionally not published to npm.

`npx @rudder/cli@latest <command>` and `rudder <command>` are the same command
surface once they resolve to the same CLI version. Public docs use the `npx`
form for first-run setup; installed users can run `rudder start` directly.

## Trusted publishing

The intended CI model is npm trusted publishing through GitHub OIDC.

That means:

- no long-lived `NPM_TOKEN` in repository secrets
- GitHub Actions obtains short-lived publish credentials
- trusted publisher rules are configured per workflow file
- publish jobs use npm CLI for the final `npm publish` step while pnpm remains
  the workspace build and install tool

See [doc/RELEASE-AUTOMATION-SETUP.md](RELEASE-AUTOMATION-SETUP.md) for the GitHub/npm setup steps.

## Rollback model

Rollback does not unpublish anything.

It repoints the `latest` dist-tag to a prior stable version:

```bash
./scripts/rollback-latest.sh 0.1.0
```

This is the fastest way to restore the default install path if a stable release is bad.

## Related Files

- [`scripts/build-npm.sh`](../scripts/build-npm.sh)
- [`scripts/generate-npm-package-json.mjs`](../scripts/generate-npm-package-json.mjs)
- [`scripts/release-package-map.mjs`](../scripts/release-package-map.mjs)
- [`cli/esbuild.config.mjs`](../cli/esbuild.config.mjs)
- [`doc/RELEASING.md`](RELEASING.md)
