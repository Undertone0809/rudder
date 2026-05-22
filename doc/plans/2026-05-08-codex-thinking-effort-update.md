---
title: Codex Thinking Effort Update Fix
date: 2026-05-08
kind: implementation
status: done
area: agent_runtimes
entities:
  - managed_codex_home
  - agent_runtime_settings
issue: ZST-65
related_plans: []
supersedes: []
related_code:
  - ui/src/components/AgentConfigForm.tsx
  - tests/e2e/agent-config-advanced-options.spec.ts
commit_refs: []
updated_at: 2026-05-08
---

# Codex Thinking Effort Update Fix

## Context

Updating an agent's Codex thinking effort from the board fails. The issue report
only includes a screenshot, so the first step is to identify the failing UI/API
path and preserve the existing agent runtime settings contract.

## Plan

1. Reproduce or infer the failing update path from the screenshot and code.
2. Trace the thinking effort value through UI forms, API validators, shared
   types, and persistence.
3. Patch the smallest root cause that prevents valid Codex effort changes.
4. Add focused regression coverage for the affected contract.
5. Run the narrowest useful validation, then broader checks as time allows.

## Outcome

- Updated the agent configuration form so clearing a Codex thinking effort sends
  a replacement adapter config instead of relying on JSON `undefined` fields that
  are dropped before the server merge.
- Normalized Codex thinking effort updates onto `modelReasoningEffort` while
  clearing the legacy `reasoningEffort` key.
- Added an e2e regression that saves `High` and then clears back to `Auto`.

## Validation

- `pnpm test:e2e tests/e2e/agent-config-advanced-options.spec.ts --project=chromium --grep "saves and clears Codex thinking effort"`
- `pnpm --filter @rudderhq/ui typecheck`
