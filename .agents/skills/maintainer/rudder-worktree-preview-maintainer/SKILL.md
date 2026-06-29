---
name: rudder-worktree-preview-maintainer
description: "Use when starting the current Rudder checkout as a temporary managed local preview with a stable URL, readiness check, logs, stop command, and cleanup path for manual inspection of the current branch or worktree."
---

# Rudder Worktree Preview Maintainer

## Overview

Run the current Rudder checkout as a managed background preview so the user can inspect it in a browser.

## When to Use

Use this skill when:

- the user asks to run the current branch/worktree locally
- the user wants a stable URL for manual testing
- a post-implementation handoff needs preview logs and stop command
- the task is environment preview, not product acceptance proof

Do not use this skill when:

- PR checkout preview; use pr-local-preview-maintainer
- Desktop packaging or release validation
- treat preview health as proof that a feature works

## Core Pattern

```text
inspect worktree -> choose isolated runtime -> launch -> readiness -> URL/logs/stop command -> cleanup
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Current branch preview | Use bundled launcher first |
| Codex worktree | Respect auto-isolated pnpm dev behavior |
| Startup fails | Report logs and exact blocker |
| Cleanup requested | Stop only managed preview process |

## Implementation

1. Inspect current worktree status and avoid disturbing dirty work.
2. Choose isolated runtime settings and ports.
3. Use bundled launcher or standard pnpm dev path.
4. Wait for API/UI readiness.
5. Hand off URL, logs, PID/session, stop command, and cleanup notes.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `scripts/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Claiming feature acceptance from a healthy URL | Preview readiness is environment proof only. |
| Using PR workflow for current branch | Use this skill for current checkout only. |
| Leaving foreground dev server running | Start managed background preview or report command. |
| Omitting stop command | Always provide cleanup path. |
