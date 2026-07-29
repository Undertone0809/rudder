# Canary And First Bootstrap

## Normal Canary

Canary normally follows a successful exact `main` CI run:

1. verify the Release workflow consumes that CI head SHA rather than resolving
   a moving branch;
2. confirm every public package published the same immutable prerelease and
   moved npm `canary`;
3. confirm `canary/vX.Y.Z-canary.N` exists locally/remotely;
4. confirm Desktop release was explicitly dispatched when required;
5. verify the GitHub Release title is `vX.Y.Z-canary.N`, it is prerelease, and
   all portable assets plus checksums exist;
6. smoke `@rudderhq/cli@canary` with isolated HOME/cache.

After the first stable exists, ordinary canary publication must not move
`latest`.

## First npm Bootstrap

When public package names do not yet exist:

1. list the complete package map;
2. distinguish missing packages from immutable existing versions;
3. use an explicitly supplied one-time token only through a temporary npmrc;
4. publish missing packages once, in package-map order;
5. verify all package versions/dist-tags before continuing;
6. remove temporary credentials and recommend rotation.

Trusted publishing can be attached only after package names exist.

## Pre-Stable `latest` Exception

Before any stable exists, `latest` may temporarily point to the selected canary
only when the user explicitly wants bare `npx @rudderhq/cli start` to work.

Do not move `latest` until the matching Desktop GitHub Release has all expected
assets and `SHASUMS256.txt`. Then verify:

- `latest` and `canary` match across every public package;
- isolated `@canary` dry-run resolution;
- isolated real `@latest start --no-open` install;
- platform-specific symlink/quarantine/launch behavior when available.

Label this as a bootstrap exception, not normal canary policy.

## Canary Failure

Fix forward on `main` when the canary source is bad. If npm already accepted
the version but tag/Release/Desktop is missing, use `partial-recovery.md`
instead of publishing the same version again.
