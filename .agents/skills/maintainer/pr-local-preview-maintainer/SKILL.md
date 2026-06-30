---
name: pr-local-preview-maintainer
description: "Use when checking out, running, previewing, reviewing, or validating a GitHub pull request locally in a safe worktree, including PR preview URLs, local screenshots, readiness checks, logs, and cleanup instructions."
---

# PR Local Preview Maintainer

## Overview

Run a GitHub PR in an isolated local worktree and hand back a verified preview URL without disturbing current work.

## When to Use

Use this skill when:

- the user asks to run or preview a PR locally
- the user mentions gh pr checkout, PR number, or local worktree preview
- a visible PR needs screenshots before handoff
- the current workspace has unrelated work that must be protected

Do not use this skill when:

- run PR checkout directly in a dirty current worktree
- use this for current-branch preview; use rudder-worktree-preview-maintainer
- review PR behavior without starting the preview when UI proof is needed

## Core Pattern

```text
protect current tree -> create PR worktree -> install if needed -> isolated dev runtime -> readiness -> URL/screenshots
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Dirty current tree | Use sibling worktree |
| PR affects UI | Capture screenshots |
| Startup fails | Report logs and blocker |
| Cleanup requested | Stop process and remove worktree if safe |

## Implementation

1. Inspect current status and PR metadata.
2. Create or reuse a predictable sibling worktree.
3. Install dependencies only when needed.
4. Start an isolated Rudder dev runtime and wait for readiness.
5. Capture screenshots for visible UI changes.
6. Hand off URL, logs, stop command, screenshot paths, and cleanup notes.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Overwriting current dirty work | Never checkout PR in the dirty main tree. |
| Handing off URL before readiness | Wait for health and route load. |
| Skipping screenshots for visible UI | Capture reviewer-visible proof. |
| Leaving background processes unexplained | Provide stop command and log path. |
