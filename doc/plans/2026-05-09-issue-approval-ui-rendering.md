---
title: Issue approval UI rendering fixes
date: 2026-05-09
kind: implementation
status: completed
area: ui
entities:
  - issue_approval_ui
  - assignee_labels
issue: ZST-75
related_plans: []
supersedes: []
related_code:
  - ui/src/components/ApprovalPayload.tsx
  - ui/src/components/MarkdownBody.tsx
  - ui/src/lib/assignees.ts
commit_refs: []
updated_at: 2026-05-09
---

# Issue Approval UI Rendering Fixes

## Goal

Fix the issue approval preview so operators can read the proposed issue body as rendered Markdown and can identify the project assignee by a human-readable label instead of a raw ID.

## Scope

- Inspect the approval payload rendering path for issue proposals.
- Reuse the existing Markdown rendering component where issue descriptions are previewed.
- Resolve project assignee display through existing project/agent/user metadata when available.
- Add focused regression coverage for the approval payload UI.

## Validation

- Run the narrow UI tests that cover approval payload rendering.
- Run repository verification required by the hand-off if time permits.
