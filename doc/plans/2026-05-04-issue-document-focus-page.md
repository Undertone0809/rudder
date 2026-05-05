---
title: Issue document focus page
date: 2026-05-04
kind: implementation
status: planned
area: ui
entities:
  - issue_documents
  - issue_detail
issue:
related_plans:
  - 2026-03-13-issue-documents-plan.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/IssueDocumentsSection.tsx
commit_refs:
  - 23e7bf2
updated_at: 2026-05-04
---

# Issue Document Focus Page

## Summary

Implement document focus as a page-level mode inside the issue detail pane. The outer Rudder shell and issue list stay visible, while the right-hand issue detail content is replaced by a focused document editor.

## Problem

The previous expand behavior treated documents as either a full-browser modal or a taller card inside the issue detail page. The intended interaction is different: a document should temporarily become the primary page within the right-side issue detail pane.

## Scope

- Add issue-detail-level focused document state.
- Let document list expand buttons enter focused document mode.
- Render existing and new document focused editors without `Save`, `Discard`, or `Done` controls.
- Keep autosave status visible for existing documents.
- Preserve normal issue detail, metadata, attachments, and comments when not focused.
- Do not redesign the document data model or API.

## Implementation Plan

1. Add a focused document key state to `IssueDetail.tsx`.
2. Pass focus callbacks into `IssueDocumentsSection`.
3. Export a focused document editor component from the document section module.
4. In `IssueDetail.tsx`, conditionally render focused document mode in place of normal issue detail content and the metadata side panel.
5. Update E2E coverage so expand no longer opens a dialog and no save/discard/done controls appear.

## Design Notes

- The focused page belongs to `IssueDetail.tsx` because it replaces the issue detail pane, not a sub-card.
- Existing documents remain autosaved.
- New documents can be edited in focus mode and created through the existing document API once content is submitted or autosave logic validates it.
- The transition should be calm and operational: opacity/translate changes, not theatrical animation.

## Success Criteria

- Clicking a document expand icon shows a document page occupying the right issue detail pane.
- Left app navigation and issue list remain visible.
- Issue metadata side panel is not visible in focused document mode.
- Focused existing document has no `Save`, `Discard`, or `Done` button.
- Clicking back/collapse returns to normal issue detail.

## Validation

- `pnpm -r typecheck`
- `pnpm build`
- Relevant E2E spec update for document focus behavior.
- Browser visual verification when local browser automation is responsive.

## Open Issues

- Browser automation has been timing out in this workspace; visual verification may need manual inspection if that continues.
