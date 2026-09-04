# Stable Release

## Preflight

1. Resolve the stable version with `./scripts/release.sh stable --print-version`.
2. Immediately lock the reviewed source SHA. Do not keep following a moving
   `main`; work that lands after the cutoff belongs to the next release.
3. Require matching English and Chinese public changelog entries and
   `releases/vX.Y.Z.md`.
4. Confirm the exact source has a successful `Qualification summary`, then
   passed stable preflight.
5. Confirm the version is absent from every public npm package and the stable
   tag does not already point elsewhere.
6. Report source/tag/targets, checks, migration or data impact, and rollback
   point as a status update, then continue under the original release authority.

### Moving `main` Is Not A Blocker

When the exact stable SHA has already passed CI, stable preflight, and package
validation, a later
unrelated `main` commit does not invalidate that evidence and is not, by itself,
a release blocker. Continue the real publish with `source_ref=<locked-sha>`.
Do not speculate that the workflow might require current `main` when its
documented input accepts an immutable source ref, and do not return `BLOCKED`
merely because `main` moved. Re-lock and rerun gates only if the user explicitly
retargets the release or live workflow inspection proves the locked SHA cannot
be dispatched.

## Publish

Dispatch or execute one main-only stable workflow with the locked source. It
must complete exact-source qualification, preflight, candidate verification,
and package validation before its first publish mutation; do not require a
separate preview dispatch or second human hand-off. When a verified candidate
already exists, pass its `candidate_run_id` and promote those exact bytes
without rebuilding Desktop or npm payloads.
The standard sequence is:

1. publish every public package once under `latest`;
2. create `vX.Y.Z` at the locked source;
3. create/update the GitHub Release from user-facing notes;
4. build and attach all Desktop assets plus checksums;
5. promote committed English/Chinese changelog entries from the immutable tag
   through the production-docs workflow;
6. run public install verification for both the first-run
   `npx @rudderhq/cli@latest start --no-open` path and the resulting persistent
   `rudder start --no-open` command;
7. remove obsolete canary GitHub Releases/tags at or below the stable base;
8. advance the next patch base directly on `main` with `[skip release]` and
   dispatch CI for that immutable handoff SHA.

If npm succeeds and a downstream step fails, stop the normal stable path and
use `partial-recovery.md`; do not republish.

## Public Notes

When any of the three narratives are missing and subagents are available, start
a dedicated release-notes subagent immediately after freezing the SHA. Give it
the previous stable tag, locked SHA, user-visible diff, and the three exact
output paths. Let it draft in parallel with read-only preflight while the
primary agent owns source selection, reviews the narrative, integrates the
files, and runs the notes checks.

Start with a one-sentence user value summary. Use optional `New`, `Improved`,
and `Fixed` headings, omitting empty sections. Localize public-doc headings
naturally and include upgrade instructions only when users must act.

Exclude CI mechanics, source locking, approval policy, cleanup internals, and
maintainer-only details.

## Desktop Update Gate

When the release changes or depends on update/install behavior:

1. record installed path, platform, and old version;
2. launch an older build and use the UI to check/download/restart;
3. observe replacement and relaunch;
4. verify the candidate version and preserved profile/data/workspace;
5. inspect checksum, replacement, progress-pipe, `EPIPE`, and relaunch evidence;
6. exercise active-work safeguards when practical.

Package-preview or asset-list evidence cannot replace this drill.

## Stable Priority Over Same-Base Canary

Once the locked stable source has successful exact-source CI and stable
preflight, a canary for the same or an older version base no longer needs to
finish Desktop assets before stable starts. Record whether its npm publish and
tag mutation completed, stop its remaining wait when safe, and dispatch stable
for the frozen SHA.

Do not unpublish the canary npm version. Do not cancel a next-base canary or one
from a source not superseded by the stable release. The normal stable cleanup
removes obsolete same-base Releases and tags.

## Canary Cleanup

Read npm `latest` and `canary`. Delete GitHub Releases and remote
`canary/v...` tags whose base version is less than or equal to the stable base,
while retaining the active next-line canary. Run a separate orphan-tag pass
after deleting Releases. Verify npm dist-tags did not move. Published npm
canary versions remain immutable history.

## Stable Completion

Stable is complete only when:

- npm `latest`, tag, Release, Desktop assets/checksum, docs, and public install
  resolve to the locked version;
- the GitHub Release plus localized public changelogs are live, and the manual
  Rudder Discord announcement has been posted and read back according to
  `announcement.md`;
- post-stable cleanup is verified;
- next-version `main` handoff and CI are verified;
- unrelated later canaries are reported as separate overwrite risk rather than
  silently adopted.
