---
title: Reviewer Comment Wake Stability
date: 2026-05-09
kind: fix-plan
status: completed
area: agent_runtimes
entities:
  - issue_wakeups
  - reviewer_workflow
issue: ZST-74
related_plans: []
supersedes: []
related_code:
  - server/src/routes/issues.ts
  - packages/agent-runtime-utils/src/server-utils.ts
commit_refs: []
updated_at: 2026-05-09
---

# Reviewer Comment Wake Stability

## Problem

Reviewer request-changes flows can update issue status and create a comment in one request, but the assignee wake context may only carry the status transition. That makes the runtime prompt and `RUDDER_WAKE_COMMENT_ID` path unreliable for reviewer feedback.

## Plan

1. Treat reviewable-to-active status returns (`in_review`/`blocked` to `in_progress`/`todo`) as changes-requested assignee wakeups.
2. When that return creates a comment, include `commentId`, `wakeCommentId`, and a compact comment snapshot in the wake payload/context.
3. Add prompt selection for `issue_changes_requested` so hydrated comment context is visible on first turn.
4. Cover structured CLI-compatible `reviewDecision=request_changes`, direct status/comment returns, `todo` returns, and no-comment regression cases.
