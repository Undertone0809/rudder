---
title: Concurrent regression audit
date: 2026-06-03
kind: fix-plan
status: in_progress
area: developer_workflow
entities:
  - concurrent_development
  - agent_runs
  - automation_chat_output
issue:
related_plans:
  - 2026-06-02-chat-native-automation-output.md
  - 2026-05-29-agent-runs-sort-and-trigger-distribution.md
  - 2026-05-22-automation-chat-output-and-activity-polish.md
supersedes: []
related_code:
  - doc/plans/2026-06-03-concurrent-regression-audit.md
  - ui/src/pages/AgentDetail.tsx
  - ui/src/components/CommentThread.tsx
  - ui/src/lib/run-duration-label.ts
  - packages/shared/src/validators/automation.ts
  - server/src/services/automations.ts
  - ui/src/pages/Automations.tsx
  - ui/src/pages/AutomationDetail.tsx
commit_refs:
  - fix: restore agent run occurrence timing
  - fix: restore issue run output folding
updated_at: 2026-06-03
---

# Concurrent Regression Audit

## Problem

Concurrent Codex work on the same branch can reintroduce stale local WIP after a
newer product decision has already landed. The immediate examples are:

- `Send to chat` automation output had a stale reverse patch in `stash@{0}` that
  tried to remove `chat_output` and restore issue-backed behavior.
- The Agent Detail run list no longer shows when a run occurred; the right-side
  list only shows elapsed duration such as `Ran for 54s`.
- Issue Activity run output cards no longer collapse inactive agent runs by
  default, so a completed run can expand into a large transcript card in the
  activity feed.

## Current Evidence

- Current `main` is synchronized with `origin/main`.
- Files owned by this audit/fix are:
  - `ui/src/pages/AgentDetail.tsx`: first fix.
  - `ui/src/components/CommentThread.tsx`: second fix.
- `doc/plans/2026-06-03-concurrent-regression-audit.md`: this plan.
- The rest of the dirty worktree is concurrent WIP and must be re-read from
  live `git status --short --untracked-files=all` before staging or cleanup.
- The reverse automation patch is not present in the worktree. It remains only
  in `stash@{0}: On main: pre-pull-main-wip-20260603141023`.
- Commit `f8d363d5 fix: show run occurrence times in agent list` added
  `formatRunOccurrenceLabel`, updated `AgentDetail.runs.tsx`, and added E2E
  coverage.
- The live page still uses the local `RunsTab` in `AgentDetail.tsx`, not the
  extracted `AgentDetail.runs.tsx` module. That old local copy rendered only
  `formatRunDurationLabel(...) ?? relativeTime(...)`.
- Commit `44767a67 fix: collapse failed issue run output` and
  `a540e9b3 fix: simplify issue run toggle` prove `CommentThread.tsx` had
  `runExpandedOverrides`, `data-run-id`, and Show/Hide details controls.
- Current `CommentThread.tsx` had reverted to the older always-expanded
  `Agent run output` card, while
  `tests/e2e/issue-detail-run-output-collapse.spec.ts` still expected inactive
  runs to be collapsed.
- Current `chat_output` code paths remain present in shared validators, the
  automation service, Automation create UI, and Automation detail UI.

## Fix Scope

1. Keep the automation reverse patch out of the current worktree.
2. Restore Agent Detail run-list occurrence timing without removing duration.
3. Restore Issue Activity run output folding without changing active run
   expansion behavior.
4. Preserve the existing E2E coverage that proves run-list labels expose both
   occurrence and duration when both values are available.
5. Preserve the existing E2E coverage that proves inactive issue runs collapse
   by default and active runs stay expanded.
6. Report any remaining suspicious stale-WIP risk instead of deleting unrelated
   current work.

## Verification

- Passed: `pnpm --filter @rudderhq/ui typecheck`.
- Passed: `pnpm exec vitest run ui/src/lib/run-duration-label.test.ts --reporter=verbose`.
- Passed: `pnpm exec vitest run ui/src/components/CommentThread.test.tsx --reporter=verbose`.
- Passed: `git diff --check`.
- Checked: reverse automation markers are absent from production automation
  code paths. A stale reverse-sounding phrase still appears in unrelated
  API-client test WIP as a server validation-message fixture, not as a
  validator or automation behavior change.
- Blocked: focused Playwright
  `tests/e2e/run-transcript-detail.spec.ts --grep "shows occurrence times"`
  could not start the web server because embedded PostgreSQL `initdb` exited
  during bootstrap, even with an isolated run id and ports.
- Blocked: focused Playwright
  `tests/e2e/issue-detail-run-output-collapse.spec.ts` hit the same embedded
  PostgreSQL `initdb` bootstrap failure before running browser assertions.
