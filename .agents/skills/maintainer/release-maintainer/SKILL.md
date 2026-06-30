---
name: release-maintainer
description: "Use when maintaining or executing Rudder releases: npm publish, canary/stable promotion, GitHub Releases, Desktop assets, tags, dist-tags, version bumps, rollback, install smoke, release workflow failures, and release-state decisions."
---

# Release Maintainer

## Overview

Ship Rudder across npm, GitHub Releases, Desktop assets, tags, and smoke tests without losing release-state truth.

## When to Use

Use this skill when:

- the user asks to release, publish, promote canary/stable, rollback, or inspect release state
- npm dist-tags, GitHub Release assets, Desktop portable binaries, tags, or release workflows are involved
- the user asks what to do next for a release
- a release failure needs diagnosis and recovery

Do not use this skill when:

- local Desktop startup recovery before release; use rudder-desktop-dev-recovery-maintainer first
- ordinary feature implementation
- release advice that ignores live npm/GitHub state

## Core Pattern

```text
state check -> release type -> authorized steps -> publish/assets/tags -> smoke -> final verification
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Canary | Check branch, version, tags, npm canary dist-tag |
| Stable | Verify version, notes, assets, npm latest, install smoke |
| Partial failure | Inspect each surface separately |
| Rollback | Name exact package/tag/release state before action |

## Implementation

1. Run fast state checks for git, package versions, npm, GitHub releases, tags, and workflows.
2. Determine canary, stable, version bump, rollback, bootstrap, or partial-failure route.
3. Execute only authorized release operations.
4. Verify npm dist-tags, GitHub assets, tags, CLI install smoke, and Desktop assets as applicable.
5. Hand off release URLs, versions, commands run, and residual blockers.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `references/`, `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Treating npm as the Desktop release surface | Desktop binaries are GitHub assets. |
| Publishing without live state check | Inspect npm/GitHub/tag state first. |
| Using stale package scope examples | Prefer @rudderhq unless repo says otherwise. |
| Calling release done without install smoke | Run or report missing smoke checks. |
