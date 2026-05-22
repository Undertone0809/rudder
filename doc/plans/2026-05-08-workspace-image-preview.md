---
title: Workspace image preview
date: 2026-05-08
kind: implementation
status: completed
area: workspace
entities:
  - workspace_browser
  - organization_workspace
issue: ZST-64
related_plans:
  - 2026-04-21-agent-workspace-browser-identity-labels.md
  - 2026-04-16-org-workspaces-fixed-root-resources.md
supersedes: []
related_code:
  - packages/shared/src/types/organization.ts
  - server/src/services/organization-workspace-browser.ts
  - server/src/routes/orgs.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - tests/e2e/organization-workspaces-image-preview.spec.ts
commit_refs: []
updated_at: 2026-05-08
---

# Workspace Image Preview

## Summary

Allow image files in the organization `/workspaces` browser to render inline
instead of showing the generic binary-file message.

## Scope

- in scope: detect common browser-previewable image formats in the workspace
  file detail contract
- in scope: add an authenticated content route for selected workspace images
- in scope: render image previews in the existing editor card while keeping
  non-image binary files non-editable
- in scope: add server and E2E coverage for PNG preview behavior
- out of scope: editing binary images in Rudder
- out of scope: previewing every binary/document format

## Implementation Plan

1. Extend the shared workspace file detail type with preview metadata.
2. Teach the workspace browser service to classify image files by extension and
   expose a preview content path for them.
3. Add an org-scoped route that streams workspace image bytes with inline
   browser-safe headers.
4. Update the Workspaces page to render image previews and image labels/icons.
5. Cover the server contract and visible workspace image preview path.

## Success Criteria

- Selecting a PNG/JPEG/WebP/GIF/SVG/AVIF/BMP/ICO file in `/workspaces` displays
  the image inline.
- Non-image binary files still show a non-previewable message and are not
  editable.
- Text files remain editable with the existing textarea flow.
