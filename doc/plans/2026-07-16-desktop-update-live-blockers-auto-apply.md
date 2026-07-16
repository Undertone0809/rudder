---
title: Desktop Update Live Blockers And Automatic Apply
date: 2026-07-16
kind: implementation
status: completed
area: desktop
entities:
  - desktop_updates
  - desktop_update_progress
  - agent_runs
issue:
related_plans:
  - 2026-05-01-desktop-update-button-flow.md
  - 2026-05-08-desktop-update-progress.md
  - 2026-05-28-layered-desktop-updates.md
supersedes: []
related_code:
  - desktop/src/desktop-update-flow.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/preload.ts
  - ui/src/components/DesktopUpdatePromptBridge.tsx
  - ui/src/components/DesktopUpdateStatusCard.tsx
  - ui/src/lib/desktop-shell.ts
  - cli/src/commands/start.ts
commit_refs:
  - "fix: auto-apply desktop updates without running blockers"
updated_at: 2026-07-16
---

# Desktop Update Live Blockers And Automatic Apply

## Summary

Make one accepted Desktop update intent complete without unnecessary follow-up
buttons. Rudder will inspect running Agent Runs across the whole local instance,
show the organization and agent responsible for any blocker, refresh that state
while the installer downloads, and apply automatically as soon as no running
work remains.

This intentionally changes `ORG.DESKTOP.UPDATE.001`. The previous behavior
preserved the run count captured when the update started and required a second
ready-state confirmation. The approved behavior treats the operator's original
Update choice, or explicit Update When Idle choice, as sufficient intent to
finish the safe update.

## Problem

- Desktop update safety is instance-wide, but the operator normally sees one
  organization. A generic `1 active run` error looks false when the blocker
  belongs to another organization.
- The update session preserves its initial active-run count through download
  progress. Runs may finish or new runs may start, so the ready card can show
  stale actions.
- The generic `/live-runs` surface includes queued and terminal-effects-pending
  records. Those records are not currently executing an agent process and must
  not be described as running work that needs to be stopped for an update.
- After accepting Update, the operator must currently confirm the same intent
  again after download and checksum verification.
- Child-process warnings can obscure the actionable update failure.

## Scope

- In scope:
  - define Desktop update blockers as Agent Runs whose current status is
    `running`
  - keep the normal Desktop quit flow's existing broader active-work behavior
  - carry structured organization, agent, run, and optional issue identity into
    update progress
  - refresh blockers at installer-ready time and while waiting
  - automatically apply after the operator has accepted Update and blockers are
    empty
  - keep force-stop as an explicit secondary action only while running blockers
    exist
  - retain the CLI update-quit recheck as the final race guard
  - filter known Node experimental-warning noise from user-facing diagnostics
  - update product, engineering, unit, integration, and E2E evidence
- Out of scope:
  - a persistent server maintenance mode
  - pausing organizations or mutating agent heartbeat configuration
  - cancelling queued work
  - changing normal Desktop quit prompts
  - binary-delta or release packaging changes

## Implementation Plan

1. Add a Desktop-update-specific running-run summary derived from the existing
   organization-scoped live-run APIs.
2. Extend the Desktop update progress contract with structured blocker details
   and automatic-apply intent.
3. When the CLI reports `ready_to_install`, refresh blockers. Apply immediately
   when none remain; otherwise publish a waiting state and poll until clear.
4. Recheck running blockers again in the update-quit handoff. Force apply may
   cancel running blockers; normal apply must never do so.
5. Render blocker identity in the global card and remove the redundant
   Update-When-Idle action once automatic waiting is active.
6. Update the About diagnostic view, preload types, prompt copy, translations,
   diagnostics, and regression tests.
7. Verify the rendered workflow with Browser and run packaged Desktop smoke.

## Design Notes

- `running` is the interruption boundary because it represents an executing
  adapter process. Queued runs remain durable database work and are recovered
  by normal server startup. Terminal-effects-pending records retain recovery
  evidence and do not need a destructive Stop Runs decision.
- The Electron main process owns the update session and its blocker polling.
  The renderer displays session state but does not infer run liveness.
- The update child still receives `--wait-for-active-runs`, so its replacement
  handoff performs a final check against a run that starts after Electron's
  latest poll. When that guard finds a new blocker, the CLI reports its count,
  Electron refreshes structured identity, and a later force action upgrades the
  next quit request without restarting the installer.
- If blocker inspection fails, Rudder must remain open, expose the error in its
  waiting state, and retry. It must not assume that work is safe to interrupt
  or discard an otherwise valid accepted update session. Unconfirmed blocker
  identity and force-stop controls remain hidden until a fresh query succeeds.
- Polling is bounded to one timer and one in-flight request per update session.
  Child exit, failure, or apply clears the monitor.

## Success Criteria

- With zero running runs across the instance, accepting Update proceeds through
  download, verification, quit, replacement, and relaunch without another
  operator button.
- A running run in another organization is named by organization and agent in
  the prompt/status instead of appearing as an unexplained global count.
- A run that finishes during download disappears from current blocker state and
  the update applies automatically.
- A run that starts during download is discovered before apply and holds the
  update safely.
- Queued and terminal-effects-pending records do not show Stop Runs UI and do
  not block a normal update handoff.
- Force update remains available only when current running blockers exist.
- Known Node SQLite experimental warnings do not lead the visible failure text.

## Validation

- Focused Desktop update, quit, diagnostics, preload, UI card, prompt, and CLI
  tests.
- E2E for visible cross-organization blockers, automatic apply with no blocker,
  blocker refresh, and responsive action layout.
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm desktop:verify`
- Browser DOM, console, interaction, and screenshot checks on desktop and narrow
  viewports.

## Validation Results

- Independent code review: PASS after final-guard, stale-identity, runtime
  availability, and update-session retry fixes.
- Focused Desktop, CLI, and UI suite: 136 tests passed across 7 files.
- Playwright update workflow: 3 tests passed, including blocker replacement,
  automatic apply without a second button, and a 390x720 dark viewport.
- Product Logic Registry: 73 contracts valid.
- All-workspace typecheck and production build passed.
- Full test run: 4103 passed, 6 failed, and 2 skipped. The 6 failures are in
  unchanged server budget, heartbeat concurrency, instance settings, and run
  intelligence tests; changed update suites passed in the same run.
- Changed-file lint passed. Full lint remains blocked by pre-existing import
  organization in `packages/shared/src/index.ts` and
  `ui/src/pages/Chat.side-panel.tsx`.
- `desktop:verify` remains blocked before packaged smoke by an existing Desktop
  smoke contract drift: reload canonicalizes `/{issuePrefix}/dashboard` to
  `/{organizationUrlKey}/dashboard`, while the smoke script still requires the
  issue-prefix path. This feature does not change that router or smoke path.

## Outcome

- The final Electron-to-CLI race window is closed by a polling quit guard that
  retains stdin control for later force escalation.
- Final-guard identity refresh remains fail-closed and retries transient
  inspection failures.
- A persistent drain mode remains out of scope unless production evidence shows
  repeated starvation.
