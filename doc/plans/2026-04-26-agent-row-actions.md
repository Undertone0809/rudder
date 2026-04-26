---
title: Agent row actions menu
date: 2026-04-26
kind: implementation
status: completed
area: ui
entities:
  - agents
  - agent_row_actions
related_plans:
  - 2026-04-26-agent-avatar-upload.md
  - 2026-04-22-agent-dashboard-skills-analytics.md
supersedes: []
related_code:
  - ui/src/components/AgentActionsMenu.tsx
  - ui/src/components/ThreeColumnContextSidebar.tsx
  - ui/src/pages/Agents.tsx
  - ui/src/api/chats.ts
  - tests/e2e/agents-row-actions.spec.ts
commit_refs:
  - "feat: add agent row action menu"
updated_at: 2026-04-26
---

# Agent Row Actions Menu

## Diagnosis

The Agents page currently makes row navigation easy, but secondary agent actions
are scattered across detail pages. The issue is primarily interaction design:
operators need fast row-local actions without turning the dense list into a
permanent toolbar. The visual-design requirement is secondary: the affordance
should stay quiet until row hover/focus or menu-open state.

## Professional Translation

- The current row has weak progressive disclosure for common actions.
- Agent actions are discoverable only after navigation, which creates avoidable
  mode switching for quick tasks.
- Adding always-visible buttons would damage scan density and compete with
  status metadata.
- The row needs a stable keyboard-accessible action affordance, not a hover-only
  visual trick.

## Evaluation Criteria

- Rows remain primarily scannable as agent status and identity records.
- The more button appears on row hover/focus and remains visible while the menu
  is open.
- Menu actions cover task creation, preferred-agent chat, heartbeat invoke,
  pause/resume, and copy name.
- Chat entry opens the new chat composer with the agent preselected instead of
  creating an empty conversation record.
- Mutating actions invalidate agent and heartbeat data and report errors through
  toast feedback.
- The same action affordance works in list, org-tree, and agent detail sidebar
  views.
- E2E coverage proves the main menu workflows from the Agents page and the
  agent detail sidebar entrypoint.

## Implementation

1. Add a shared `AgentActionsMenu` component used by agent rows across
   surfaces.
2. Reuse existing APIs: `openNewIssue({ assigneeAgentId })`,
   `navigate({ pathname: "/messenger/chat", search: "?agentId=..." })`,
   `agentsApi.invoke`, `agentsApi.pause`, `agentsApi.resume`, and clipboard
   copy.
3. Stop row navigation from firing when the action trigger or menu items are
   used.
4. Add the shared menu to the detail-page Agents sidebar row used by the desktop
   three-column shell.
5. Add focused E2E coverage for menu visibility and key actions.
6. Verify with targeted E2E, typecheck, and build where feasible.

## Verification

- `pnpm --filter @rudderhq/ui typecheck`
- `pnpm -r typecheck`
- `pnpm build`
- `pnpm --filter @rudderhq/ui exec vitest run src/components/ThreeColumnContextSidebar.test.tsx`
- `pnpm --filter @rudderhq/ui exec vitest run src/components/ThreeColumnContextSidebar.test.tsx src/lib/chat-route-state.test.ts`
- `pnpm test:e2e tests/e2e/agents-row-actions.spec.ts` was attempted, but
  Playwright timed out launching `chrome-headless-shell` before the test body
  executed.
- Direct browser verification through the available browser MCP tools was also
  attempted against `http://127.0.0.1:3100`, but Chrome MCP navigation timed out
  before page interaction.
- `pnpm test:run` was attempted and failed in unrelated pre-existing areas:
  PrimaryRail active-index expectation, company import/export skill duplication,
  agent avatar upload status expectation, issue reopen mock expectation, and
  several embedded Postgres init suites.

## Notes

`agent_row_actions` is a new stable retrieval entity for row-local progressive
disclosure on the Agents surface.
