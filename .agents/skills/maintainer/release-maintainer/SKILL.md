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
3. run required exact-source CI, preflight, and package validation once;
4. publish npm, tag, GitHub Release, Desktop, and production-docs surfaces;
5. verify public installation and clean obsolete canary Releases/tags;
6. advance the next-version base.

Do not create a release PR or ask for routine second approval after validation.
Ask only when channel, version, source, or destination is materially ambiguous.

Questions such as “how does release work?” or “is this ready?” are read-only.
Implementation requests without a release/publish imperative stop at Review
Ready.

Separate authority is still required for npm unpublish, force-pushing or
retargeting published tags, deleting the active canary line, bypassing CI,
exposing secrets, or expanding to another product/environment.

## Cross-Branch Invariants

- Lock stable source to a full immutable commit SHA. Later `main` movement does
  not silently retarget it, and manual stable dispatch must not use a branch or
  tag as `source_ref`.
- Freeze that source as soon as a stable release imperative arrives. New
  unrelated `main` work belongs to the next release instead of extending the
  active release window.
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
- A stable release takes priority over an in-flight canary for the same or an
  older version base once the locked stable source passes its gates. Do not wait
  for obsolete canary Desktop assets; record npm/tag state, stop the remaining
  canary work when safe, and let stable cleanup remove its Release/tag.
- Keep public install smoke, including slow Windows runtime installation. A slow
  real install is product evidence to optimize, not a release gate to delete.
- Once a stable campaign is active, candidate-repair commits use `[skip release]`
  unless a canary is explicitly needed. CI still validates the repair, while the
  automatic canary path does not duplicate the manual stable candidate.
- Do not dispatch a third run after the same stage fails twice on unchanged
  inputs. Diagnose and repair that stage, then rerun the new immutable SHA once.
- Preserve unrelated dirty work. Prefer a clean temporary worktree/clone for
  hands-on publication.

## Operating Loop

1. Classify the request as setup, canary, stable, rollback, partial recovery,
   or read-only inspection.
2. Read `references/shared.md` and the selected primary reference.
3. Resolve live local and remote state, then freeze the stable SHA immediately;
   release truth is temporally unstable.
4. When release narratives are missing and subagents are available, start one
   bounded release-notes subagent in parallel with read-only preflight. Give it
   the locked diff and require drafts for the GitHub notes plus both public
   changelogs; the primary agent reviews and integrates the drafts.
5. State the selected version, locked source SHA, channel, active workflow run,
   last completed stage, and unresolved blockers in a progress update.
6. Execute one stable publish path whose machine gates run before mutation; do
   not introduce a separate preview dispatch or second human hand-off.
7. Verify every applicable public surface from the same locked source.
8. Report version/ref, workflow runs, npm tags, Release assets, install proof,
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
