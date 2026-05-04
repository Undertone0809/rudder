---
title: Agent Learning Page Information Architecture
date: 2026-05-03
kind: implementation
status: implemented
area: skills
entities:
  - agent_learning
  - agent_skills
issue:
related_plans:
  - 2026-05-02.agent-self-improvement-proposal.md
supersedes: []
related_code:
  - server/src/services/agent-learning.ts
  - packages/shared/src/types/agent-learning.ts
  - ui/src/pages/AgentDetail.tsx
  - ui/src/pages/ReviewAgentLearnings.tsx
  - tests/e2e/agent-learning-loop.spec.ts
commit_refs: []
updated_at: 2026-05-03
---

# Agent Learning Page Information Architecture

## Summary

Implement the approved Agent Learning UI direction: agent-private learning should be a dedicated agent-owned product surface, while the generated runtime skill remains a backend artifact. The end state is a short visible skill name, a Learning tab/page on Agent Detail, and a summary-to-learning navigation path that keeps Workspaces as an advanced escape hatch.

## Problem

The current implementation exposes internal managed skill identity in the operator UI. The Agent skills page can show names like `agent-learning-laila-learning-demo-202605031346`, and the learning summary links directly to Workspaces. That makes the feature feel like manual file editing instead of an AI-generated learning loop where humans provide feedback and approve generated improvements.

## Scope

- Add a `Learning` Agent Detail tab backed by the existing learning summary API.
- Show active learnings, pending AI updates, feedback records, revision history, and evaluation misses in one page.
- Use a short visible managed learning skill name such as `Learning`.
- Keep internal skill keys, slugs, and file paths stable for runtime compatibility.
- Keep Workspaces access available only as an advanced generated-file link.
- Redirect successful proposal application to the Learning page instead of the Skills page.
- Update focused service and E2E expectations.

Out of scope:

- GEPA/Hermes-style candidate search and variant evaluation.
- Cross-agent or organization-level learning rollout.
- Full learning inbox across all agents.
- Database migrations for renaming persisted skill keys.

## Implementation Plan

1. Extend the learning summary contract with recent feedback records for the target agent.
2. Return a short managed learning skill display name while preserving the internal slug and selection key.
3. Add `learning` / `learnings` as Agent Detail route aliases and include a `Learning` tab.
4. Build the Learning page sections from the summary data.
5. Adjust the Skills tab so managed learning appears as `Learning` with an `Open learning` action and no primary Workspaces action.
6. Update the review page apply redirect and toast copy.
7. Update service and E2E coverage for the new naming and route behavior.

## Design Notes

- The runtime artifact remains agent-private and agent-scoped; it is unrelated to the organization skill library.
- UI naming is intentionally not a persistence migration. Existing `agent:agent-learning-*` keys must continue to load.
- The Learning page owns learning history and evidence. Skills remains the capability enablement inventory.
- The generated `SKILL.md` can still be opened from Learning page advanced controls for debugging.

## Success Criteria

- Agent Detail has a visible `Learning` tab.
- The learning summary card links to `Learning`, not Workspaces.
- The managed learning card shows `Learning`, not the internal slug or full agent-derived name.
- The Learning page shows pending updates, active learnings, recent feedback, revisions, and missed evaluation signals when data exists.
- Applying an AI proposal lands on the Learning page.
- Existing agent-private skill loading still uses the same selection key and slug.

## Validation

- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed: learning summary API smoke against the dense local demo at `http://127.0.0.1:3102`.
- Passed: in-app browser verification for `http://localhost:3102/AGE/agents/laila-learning-demo-202605031346/learning` and `/skills`.
- Blocked locally: `pnpm test:run server/src/__tests__/agent-learning-service.test.ts` failed before assertions because embedded Postgres initialization exited with code 1.
- Blocked locally: `pnpm test:e2e -- tests/e2e/agent-learning-loop.spec.ts` first hit embedded Postgres initialization failure; with an external local Postgres override, Chromium launch hung and timed out before reaching assertions.

## Open Issues

- Future work should decide whether `Learning` becomes a left-rail top-level inbox for all agents.
- Hermes-style self-evolution should be added after the basic feedback-to-approved-skill loop is stable and visually understandable.
