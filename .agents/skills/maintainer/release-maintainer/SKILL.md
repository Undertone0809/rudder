---
name: release-maintainer
description: "Use when inspecting, preparing, executing, recovering, or verifying Rudder releases across npm, GitHub Releases, Desktop assets, tags, dist-tags, changelogs, install smoke, stable/canary promotion, rollback, and release workflow failures. Use for both hands-on publish requests and read-only release readiness questions; route to the smallest relevant release reference instead of loading every release branch."
---

# Release Maintainer

Ship or inspect Rudder releases without losing source identity, authorization,
or public-surface completeness.

## Route Before Reading

Read `references/shared.md`, then exactly one primary branch:

- `references/stable.md`: stable readiness, publish, public notes, Desktop
  update drill, post-stable cleanup, and next-version handoff.
- `references/canary.md`: automatic canary publication, first npm bootstrap,
  Desktop prerelease assets, and temporary pre-stable `latest` behavior.
- `references/rollback.md`: move npm dist-tags to an already published version
  without unpublishing packages or rewriting tags.
- `references/partial-recovery.md`: npm/tag/Release/Desktop/docs surfaces
  disagree, a workflow failed after partial publication, or install lookup
  returns misleading errors.
- `references/setup.md`: one-time GitHub environment, npm trusted-publishing,
  and workflow setup.

Use a second branch only when the observed state genuinely crosses branches,
such as a stable publish that needs partial recovery. Do not preload every
reference for a readiness question.

## Authorization Boundary

An explicit imperative such as `release`, `publish`, `ship this version`,
`发版`, or `发布` authorizes the complete standard release lifecycle:

1. resolve and lock the single consistent version and source SHA;
2. land reviewed release source on `main` when needed;
3. run required CI, preflight, and dry-run checks;
4. publish npm, tag, GitHub Release, Desktop, and production-docs surfaces;
5. verify public installation and clean obsolete canary Releases/tags;
6. advance the next-version base.

Do not create a release PR or ask for routine second approval after dry-run.
Ask only when channel, version, source, or destination is materially ambiguous.

Questions such as “how does release work?” or “is this ready?” are read-only.
Implementation requests without a release/publish imperative stop at Review
Ready.

Separate authority is still required for npm unpublish, force-pushing or
retargeting published tags, deleting the active canary line, bypassing CI,
exposing secrets, or expanding to another product/environment.

## Cross-Branch Invariants

- Lock stable source to an immutable commit SHA or stable tag. Later `main`
  movement does not silently retarget it.
- Never republish an npm version that already exists.
- npm packages use `@rudderhq`; Desktop binaries belong to GitHub Releases.
- Stable uses npm `latest`; canary uses `canary`. A first-public pre-stable
  bootstrap may also use `latest` only after matching Desktop assets exist.
- Canary tags are `canary/vX.Y.Z-canary.N`; their GitHub Release title is the
  clean `vX.Y.Z-canary.N` and the Release is prerelease.
- A stable tag points at the reviewed source commit, not a generated handoff
  commit.
- Partial publication is repaired from its first missing surface; immutable
  npm versions are not republished.
- Public completion requires applicable npm, tag, GitHub Release, Desktop,
  changelog/docs, install smoke, and next-version handoff evidence.
- Cleanup removes obsolete GitHub Releases and `canary/*` tags, not published
  npm canary versions.
- Preserve unrelated dirty work. Prefer a clean temporary worktree/clone for
  hands-on publication.

## Operating Loop

1. Classify the request as setup, canary, stable, rollback, partial recovery,
   or read-only inspection.
2. Read `references/shared.md` and the selected primary reference.
3. Resolve live local and remote state; release truth is temporally unstable.
4. State the selected version, locked source SHA, channel, and unresolved
   blockers in a progress update.
5. Execute only the authorized branch.
6. Verify every applicable public surface from the same locked source.
7. Report version/ref, workflow runs, npm tags, Release assets, install proof,
   changelog/docs state, cleanup, and remaining manual work.

## Output

For read-only requests:

```text
Current state:
Blockers:
Next actions:
Authorization:
Verification required:
```

For hands-on execution:

```text
RESULT: RELEASED | PARTIAL | BLOCKED
Version/channel:
Locked source:
Checks:
Published surfaces:
Install proof:
Cleanup/handoff:
Remaining blocker:
```
