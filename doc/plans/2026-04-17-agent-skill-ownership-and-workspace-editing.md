---
title: RUD-101 agent skill ownership and workspace editing
date: 2026-04-17
kind: plan
status: planned
area: skills
entities:
  - agent_skills
  - organization_skills
  - workspace_editor
issue: RUD-101
related_plans:
  - 2026-04-16-agent-private-skill-creation.md
  - 2026-04-14-org-scoped-agent-workspace-and-skill-ownership.md
supersedes: []
related_code:
  - ui/src/pages/AgentDetail.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - server/src/services/organization-workspace-browser.ts
commit_refs:
  - Pending
updated_at: 2026-04-17
---

# RUD-101 Agent Skill Ownership And Workspace Editing

## Goal

Fix the Agent Skills surface so it reflects ownership instead of discovery source:

- show `Agent skills` as a first-class section above `Organization skills`
- keep `External skills` for globally discovered and adapter-discovered skills only
- provide an explicit workspace-edit action for non-bundled organization and agent skills
- let the Workspaces page open the target skill file directly and edit it in place

## Implementation Plan

1. Update the workspace browser contract so text files under the organization workspace root can be edited safely.
2. Extend the Workspaces page to support deep-linking to a target file and saving changes.
3. Rework the Agent Skills page section order and card actions around ownership-first grouping.
4. Add or update E2E coverage for:
   - agent/private skill section placement
   - workspace edit buttons for non-bundled org and agent skills
   - saving an edited skill file through Workspaces

## Validation

- `pnpm -r typecheck`
- targeted E2E for agent skills / workspace editing
- browser verification of the updated Agent Skills and Workspaces flow

## Commit

- Pending
