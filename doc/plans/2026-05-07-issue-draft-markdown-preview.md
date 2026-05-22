---
title: Issue Draft Markdown Preview
date: 2026-05-07
kind: implementation
status: completed
area: ui
entities:
  - issue_drafts
  - markdown_preview
issue: 558b6df8-d554-4af1-b5c4-02bb717ecf58
related_plans:
  - 2026-04-26-issue-draft-autosave-separation.md
supersedes: []
related_code:
  - ui/src/pages/Issues.tsx
  - ui/src/pages/Issues.test.tsx
commit_refs: []
updated_at: 2026-05-07
---

# Issue Draft Markdown Preview

## Scope

Render saved draft issue descriptions as Markdown inside draft cards while preserving the compact card footprint.

## Implementation

- Replace the plain text draft description preview with a constrained Markdown renderer.
- Keep the preview clipped with a fixed maximum height so images do not expand the card.
- Preserve whole-card open behavior while keeping the delete button independently clickable.

## Validation

- `pnpm test:run ui/src/pages/Issues.test.tsx`
- `pnpm -r typecheck`
- Browser measurement showing rendered image count and constrained preview height.
