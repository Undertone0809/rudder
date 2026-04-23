---
title: Org resources onboarding and ready state
date: 2026-04-17
kind: implementation
status: completed
area: workspace
entities:
  - org_workspace
  - resources_md
  - onboarding_state
issue:
related_plans:
  - 2026-04-16-org-workspaces-fixed-root-resources.md
  - 2026-04-16-org-workspace-scope.md
supersedes: []
related_code:
  - server/src/home-paths.ts
  - server/src/services/organization-workspace-browser.ts
  - server/src/services/agent-run-context.ts
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/OrganizationSettings.tsx
commit_refs:
  - feat: add org resources onboarding and ready flow
updated_at: 2026-04-17
---

# Org Resources Onboarding And Ready State

## Summary

`resources.md` now exists for every organization, but the current product still
conflates a newly created scaffold with valid shared org context. This change
introduces an explicit onboarding/ready flow so users understand what
`resources.md` is for, while Rudder only injects it into agent runs after it is
marked ready.

## Problem

- new orgs see `resources.md` but are not clearly told what it does
- the default scaffold can still be treated as runtime context even when it is
  only placeholder text
- there is no user-visible distinction between "file exists" and "safe to load
  into agents"

## Scope

- in scope:
  - add metadata/status handling for org `resources.md`
  - gate runtime injection on ready state
  - add inline onboarding copy and activation flow in Workspaces
  - update Settings copy to explain the file's purpose
  - add automated coverage for default draft and ready activation behavior
- out of scope:
  - a separate structured setup form
  - multi-file onboarding beyond `resources.md`
  - migrating org data beyond detecting/marking the existing default scaffold

## Implementation Plan

1. Introduce `resources.md` metadata helpers with explicit `draft` / `ready`
   status and a canonical default scaffold.
2. Extend org workspace file read/list responses to expose `resources.md`
   metadata and provide an activation-safe write path.
3. Update runtime context building so only ready org resources are injected into
   agent/chat prompts.
4. Add Workspaces onboarding UI:
   - visible tip explaining what `resources.md` does
   - draft/ready badge
   - activation CTA for draft content
   - ready-state confirmation copy
5. Update Organization Settings and related copy to explain that
   `resources.md` tells agents where real code and references live.
6. Add/update unit and E2E coverage for:
   - fresh org starts in draft and is not injected
   - activating resources flips it to ready
   - user-visible onboarding copy appears in the relevant UI

## Design Notes

- keep the file filesystem-native; metadata should live inside the file so the
  workspace remains portable and inspectable without DB coupling
- use a stable first-line metadata marker so runtime code can cheaply decide
  whether org resources are ready
- preserve the existing auto-created scaffold, but make it explicitly draft
- do not rely only on raw string equality with the default template for gating;
  status should be explicit

## Success Criteria

- fresh org `resources.md` clearly explains its purpose to users
- fresh org resources remain draft and are not injected into agent/chat context
- users can activate org resources from the Workspaces page after editing
- ready resources automatically load into agent/chat runs

## Validation

- `pnpm -r typecheck`
- `pnpm test:run`
- targeted tests for:
  - org resources metadata helpers and runtime gating
  - workspace browser file metadata
  - Workspaces / Settings UI copy and activation flow
- visual verification of Workspaces and Settings surfaces
- `pnpm build`

## Open Issues

- whether a future structured setup form should generate `resources.md` instead
  of editing markdown directly
