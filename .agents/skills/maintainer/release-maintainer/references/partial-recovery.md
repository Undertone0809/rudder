# Partial Release Recovery

Start by building a surface ledger:

```text
source SHA:
npm packages/dist-tags:
git tag:
GitHub Release:
Desktop assets/checksum:
production docs:
install smoke:
next-version handoff:
```

Repair from the first missing surface without repeating immutable successes.

## Common Cases

### npm published, tag or GitHub Release missing

Do not republish. Rerun the original Release with `resume_missing: true` against
the locked source. It verifies package-map versions, creates the missing tag or
Release, and uploads only exact candidate artifacts from the rerun.

### Release exists, Desktop assets missing

Rerun the original Release with `resume_missing: true` against the same locked
source. The full candidate gates run again; existing asset bytes must match the
new candidate and only missing architecture-specific assets are uploaded. Never
run an independent rebuild that can overwrite previously verified assets.

### Docs promotion failed

Treat stable as partial. Repair or rerun docs for the same immutable tag. Do not
republish npm. Verify the immutable docs marker and public changelog before
advancing the next version.

### Dist-tag wrong

Verify which complete immutable version should own the tag. Use the repository
dist-tag workflow when local npm auth is unavailable. Recheck after any
in-progress Release workflow finishes because it may overwrite the repair.

### GitHub lookup returns `403`

Anonymous API rate limiting can resemble a missing Release. Check authenticated
`gh release view`, rate limits, and direct asset state before changing release
objects or npm tags.

### Canary title/flags wrong

Edit the existing Release to the clean version title and prerelease state; do
not republish or recreate npm.

### Public `npx` install fails

Resolve npm dist-tags, exact tag, Release assets, checksums, API rate limiting,
cache behavior, extraction, symlinks, quarantine, and minimal launch in that
order. Use isolated HOME/cache/prefix/output/install directories and
`--prefer-online`. A dry-run is supporting evidence only.

### Concurrent canary already published the version

Classify as a concurrency incident. Verify current npm/tag/Release state and
the locked stable source. Do not infer that the stable source is invalid or
chase a newer `main`.

## Recovery Completion

Re-read every ledger surface after repair and list anything still capable of
overwriting the recovered state, including in-progress workflows.
