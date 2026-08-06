---
title: Organizations Goals And Projects Domain
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids: []
related_code:
  - server/src/routes/goals.ts
  - server/src/services/goals.ts
  - server/src/routes/projects.ts
  - server/src/services/projects.ts
related_tests:
  - tests/e2e/goal-detail-lifecycle.spec.ts
  - server/src/__tests__/projects-service.test.ts
edit_policy: user_confirmed_only
---

# Organizations Goals And Projects Domain

## Owns

- Organization mission and lifecycle as the top-level operating boundary.
- Local installation account claims and compatibility-preserving operator-state
  recovery across identity upgrades.
- Goal hierarchy, status, owner, and dependency protection.
- Project identity, project-goal links, lead agent, status, and grouping of
  chats/issues/resources/workspaces.

## Does Not Own

- Issue state and execution. See `ISSUE.*` and `RUN.*`.
- Project resources and workspace file eligibility. See `CONTEXT.*` and
  `WORKSPACE.*`.
- Dashboard metric rollups. See `CONTROL.*`.

## Contract Index

- `ORG.IDENTITY.001`: organization UUID, stable URL key, display name, and Issue
  Key have separate responsibilities with compatibility-preserving migration.
- `ORG.GOAL.001`: goals explain why work exists and preserve hierarchy.
- `ORG.PROJECT.001`: projects group goal-directed chats, issues, resources, and
  workspaces.
- `ORG.SETTINGS.001`: settings persist instance/operator/organization behavior
  without crossing scopes.
- `ORG.ONBOARDING.001`: onboarding guides a fresh user to a real work surface.
- `ORG.LOCAL.ACCOUNT.UPGRADE.001`: local account claim and repair preserve
  scoped operator state, Messenger organization, and downgrade-readable legacy
  data across Desktop upgrades.
- `ORG.PORTABILITY.001`: export/import moves the explicitly supported
  organization configuration and work records with previewable, scoped
  mutations.
