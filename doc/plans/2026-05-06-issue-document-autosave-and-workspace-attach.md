---
title: Issue document autosave and workspace attach
date: 2026-05-06
kind: implementation
status: completed
area: ui
entities:
  - issue_documents
  - issue_detail
  - workspace_browser
issue:
related_plans:
  - 2026-03-13-issue-documents-plan.md
  - 2026-05-04-issue-document-focus-page.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/IssueDocumentsSection.tsx
  - server/src/routes/issues.ts
  - server/src/services/organization-workspace-browser.ts
commit_refs:
  - 966a114
updated_at: 2026-05-06
---

# Issue Document Autosave And Workspace Attach

## Summary

Make issue documents feel like autosaved work artifacts instead of draft forms,
and let issue attachments come from either a local upload or a file inside the
organization workspace.

## Problem

The current document focus page has the right pane-level shape, but it still
leaks draft semantics through status labels and creation flow. Attachments also
only support local file uploads even though organization workspaces are the
canonical shared file surface.

## Scope

- Replace user-facing document draft/created status with autosave-only status.
- Keep new document creation lazy: empty editors do not create empty documents,
  but first meaningful content autosaves into a real document.
- Add enter and exit motion for document focus mode.
- Let Escape close focused document mode and return to the issue detail pane.
- Add an Attach source menu with local upload and workspace file attach.
- Add a server endpoint that copies a workspace file into issue attachment
  storage as a snapshot.
- Do not introduce the full artifact read model or live workspace-file links.

## Implementation Plan

1. Add a small issue-detail focus transition state so open and close both have
   motion, and Escape closes the focus page.
2. Simplify focused document status labels to Saving/Saved/Could not save, with
   no Draft/Create/Created user-facing state.
3. Add workspace file byte reads to the organization workspace browser service.
4. Add an issue attachment route that validates a workspace path, reads the
   file, stores it through the existing storage service, and creates an issue
   attachment.
5. Replace the Attach button with a source menu and a compact workspace file
   picker dialog.
6. Update E2E coverage for autosave focus mode, Escape close, and workspace
   attachment.

## Design Notes

- The editor may still keep local React state, but draft is not a product
  concept in the UI.
- Workspace attachments are snapshots. Later workspace edits do not mutate the
  issue attachment.
- Workspace file paths must stay inside the organization workspace root.
- Attachment type and size limits should match normal uploads.

## Success Criteria

- New focused documents show no Draft/Create/Created/Done/Discard controls.
- Typing meaningful content creates and saves a document automatically.
- Existing documents autosave edits in focus mode.
- Escape returns from focused document mode to the issue detail pane.
- Enter and exit transitions are visible and calm.
- Attach can upload from the computer or attach a workspace file.

## Validation

- `pnpm -r typecheck`
- `pnpm build`
- `pnpm exec vitest run ui/src/pages/IssueDetail.test.tsx`
- Workspace-file attachment verified against the local preview API.
- Relevant E2E spec updated for document focus and workspace attach.

## Open Issues

- `pnpm test:run` still fails on existing agent instruction fixture assertions
  unrelated to this issue.
- Local Playwright Chromium launch timed out before running the updated E2E
  spec; the in-app browser MCP also timed out during visual verification.
