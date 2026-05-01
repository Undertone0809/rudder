---
title: Messenger thread organization
date: 2026-05-01
kind: implementation
status: completed
area: ui
entities:
  - messenger_chat
  - project_context
issue:
related_plans:
  - 2026-04-10-messenger-unification.md
  - 2026-04-11-messenger-desktop-shell-overhaul.md
  - 2026-04-26-chat-project-context-selector.md
supersedes: []
related_code:
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/MessengerContextSidebar.test.tsx
  - tests/e2e/messenger-contract.spec.ts
commit_refs:
  - feat: organize messenger threads
updated_at: 2026-05-01
---

# Messenger Thread Organization

## Summary

Add a compact Messenger thread organization control in the middle-column
section header. The default view remains latest activity, but operators can
organize the thread list by project, thread type, or attention. Fix pinned chat
behavior in Messenger so pinned conversations are visibly promoted instead of
remaining buried in latest-activity order.

## Scope

- Add a hover/focus-revealed organization menu beside the `Threads` label.
- Persist the selected organization rule per organization in local storage.
- Keep `Latest activity` as the default rule.
- For `Project`, group project-linked chat conversations under their project
  context, unlinked chats under `No project`, and synthetic/system threads under
  `System`.
- For all rules, keep pinned chat conversations ahead of unpinned peers inside
  the relevant list or group.
- Add focused component coverage and E2E coverage for the visible control.

## Non-Goals

- Do not split aggregate `issues`, `approvals`, or system threads by project in
  this pass.
- Do not change the server `MessengerThreadSummary` contract yet.
- Do not redesign the right-side Messenger content surface.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/components/MessengerContextSidebar.test.tsx`.
- Passed: `pnpm -r typecheck`.
- Passed: `pnpm build`. The build emitted existing large-chunk and packaged
  dependency warnings.
- Attempted: `pnpm test:run`. The full suite failed in existing unrelated
  areas: `server/src/__tests__/agent-skills-routes.test.ts`,
  `server/src/__tests__/private-hostname-guard.test.ts`, and teardown for
  `cli/src/__tests__/company-import-export-e2e.test.ts`.
- Attempted: focused Messenger E2E with bundled Chromium and with system Chrome.
  Both attempts failed before test execution because Chromium launch timed out
  after 180 seconds.
- Attempted: browser visual verification through Chrome MCP / Playwright MCP.
  Both navigation tools timed out after 120 seconds. A direct macOS Chrome
  screenshot attempt produced a black desktop capture, so visual verification
  could not be completed in this environment.
