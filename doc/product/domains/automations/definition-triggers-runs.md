---
title: Automation Definition Triggers And Runs
domain: automations
status: active
coverage: detailed
contract_ids:
  - AUTOMATION.DEFINITION.001
  - AUTOMATION.TRIGGER.001
  - AUTOMATION.RUN.001
related_code:
  - packages/db/src/schema/automations.ts
  - packages/shared/src/validators/automation.ts
  - server/src/routes/automations.ts
  - server/src/services/automations.ts
  - server/src/services/automations.scheduler.ts
  - ui/src/pages/Automations.tsx
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/components/ScheduleEditor.tsx
related_tests:
  - server/src/__tests__/automations-service.test.ts
  - server/src/__tests__/automations-routes.test.ts
  - server/src/__tests__/automations-e2e.test.ts
  - ui/src/pages/Automations.test.tsx
  - tests/e2e/automations-index-layout.spec.ts
  - tests/e2e/automation-detail-layout.spec.ts
edit_policy: user_confirmed_only
---

# Automation Definition Triggers And Runs

## AUTOMATION.DEFINITION.001

Why:

- Automation is a repeatable agent work loop. It is not just a cron row; it
  binds intent, agent owner, project/goal/parent issue context, output mode,
  priority, and concurrency policy.

Product model:

- An automation belongs to one organization.
- It may bind to project, goal, parent issue, and assignee agent.
- It has status such as active, paused, or archived.
- Output mode is either tracked issue or chat output.
- The create composer defaults custom automations to chat output and lets the
  operator explicitly switch between chat output and tracked issue output.
- The first-use gallery and the open composer's `Use template` picker expose
  the same localized built-in presets. Applying a preset to an open draft
  replaces its title, instructions, schedule, output mode, and chat
  destination while preserving the selected assignee and project.
- `Daily review` is a built-in preset for a concise evidence-based review of
  completed, in-progress, unfinished, and blocked work, important decisions,
  and the highest-priority next action. It defaults to daily at 18:00 and
  sends each run to a new chat.
- Agent actors can manage only automations they are allowed to own.
- `/automations` and `/automations/:automationId` are one route-driven
  master-detail workspace. On wide screens the primary rail, Automation list,
  and selected detail remain visible together; on narrow screens the selected
  detail becomes the single content pane.

Flow:

1. Operator opens a custom draft or applies a built-in preset, reviews the
   editable prompt, owner, context, trigger, and explicitly visible output
   mode, then creates the Automation. Applying a preset alone does not create
   or persist an Automation; agent API clients submit the equivalent definition
   fields directly.
2. Server validates organization boundary, assignee, project/goal/parent issue,
   status, and permissions.
3. Selecting a row updates the route, marks that row as current, and opens or
   swaps the detail inspector in place without discarding the list on wide
   screens.
4. The populated list defaults to `All` and lets the operator filter by
   `Active` or `Paused` using accessible tabs. A filtered view shows only the
   matching definitions and uses a filter-specific empty state rather than the
   first-use template gallery.
5. If the selected Automation no longer belongs to the active filter because
   the operator changed filters or changed its status, the workspace closes the
   stale detail and returns to `/automations`.
6. Automation detail shows definition, trigger, output, run history, and state.
7. Closing detail returns to `/automations`; deleting the selected Automation
   also returns to the remaining list.
8. A direct link opens the same workspace. Invalid direct links stay inside a
   closable detail error state so the operator can recover to the list.
9. Pausing stops new dispatch while preserving definition and history.

Invariants:

- Automation context must remain traceable to the org/project/goal/issue that
  justified the repeated work.
- Built-in presets are editable composer defaults, not separate persisted
  Automation definitions. Template selection must preserve explicit assignee
  and project choices while replacing the fields owned by the selected preset.
- The template picker must remain usable in English and Chinese and must stay
  within the visible viewport on narrow screens.
- Archived automations are historical records, not active dispatch sources.
- On wide screens, collapsing detail must remove the detail pane, its border,
  and its reserved gap from the visible layout. The restore control remains in
  the Automation list, and reopening uses a visible transition while honoring
  the operator's reduced-motion preference.
- Row toggles and action menus must not accidentally select a different detail.
  The selected row remains visibly and accessibly current.
- Status tabs must support pointer and keyboard activation, keep their selected
  state aligned with the visible rows, and never leave a detail open for an
  Automation excluded by the current filter.
- Narrow detail must provide a close/back path and must not introduce
  horizontal document overflow.

Evidence:

- `server/src/__tests__/automations-service.test.ts` and
  `server/src/__tests__/automations-routes.test.ts` are the primary regression
  evidence for definition validation and permission boundaries.
- `tests/e2e/automations-index-layout.spec.ts` and
  `tests/e2e/automation-detail-layout.spec.ts` prove list/detail selection,
  status filtering and keyboard activation, filtered empty states, selected
  detail reconciliation after filter or status changes, in-place swapping,
  direct-link recovery, responsive one-pane fallback, definition editing, and
  run-history affordances. The Automations index E2E also proves that applying
  `Daily review` preserves the assignee, uses chat output, persists the daily
  18:00 schedule, and keeps the localized picker bounded at a narrow viewport.
- Known gap: this contract records product behavior; it does not replace
  automation output proof, which belongs to `AUTOMATION.OUTPUT.001`.

## AUTOMATION.TRIGGER.001

Why:

- Trigger semantics decide whether an automation should run now, catch up,
  skip, coalesce, or reject an external event. That is product behavior, not
  scheduler plumbing.

Product model:

- Supported trigger sources include schedule, manual/API, and webhook.
- Schedule triggers carry cron/timezone/next-run semantics.
- Built-in presets may prefill an editable schedule before creation. `Daily
  review` starts with `0 18 * * *`; creating the Automation from that draft
  persists the expression as its schedule trigger unless the operator changes
  it first.
- Webhooks carry public id, secret/signature/replay-window semantics when
  enabled.
- Dispatch source and idempotency key remain attached to the automation run.

Flow:

1. Trigger is entered manually or prefilled by a built-in preset, then created
   or edited on the Automation definition.
2. Scheduler/API/webhook evaluates source-specific eligibility.
3. Next run timestamp or webhook validation is computed.
4. Eligible trigger creates an automation run or records a skip/coalesce result.

Invariants:

- External trigger handling must be replay/idempotency aware.
- Schedule catch-up must be bounded so missed ticks do not flood agent work.

Evidence:

- `server/src/services/automations.scheduler.ts` owns schedule dispatch and
  next-run behavior.
- `server/src/__tests__/automations-service.test.ts` covers trigger and
  dispatch behavior at service level.
- `ui/src/pages/Automations.test.tsx` and
  `tests/e2e/automations-index-layout.spec.ts` prove the `Daily review` schedule
  prefill and its persisted `0 18 * * *` trigger.
- Known gap: webhook security details should be expanded when webhook
  providers beyond the current implementation become first-class surfaces.

## AUTOMATION.RUN.001

Why:

- Automation run records are the durable evidence that a repeated job actually
  fired, was skipped/coalesced, created work, failed, or completed.

Product model:

- Run status includes received, running, issue-created, completed, failed,
  coalesced, skipped, or equivalent terminal states.
- Run records hold source, trigger, scheduled time, idempotency, linked issue,
  linked chat conversation, linked heartbeat run, and terminal error/result
  evidence.
- Concurrency policy decides whether active work causes coalesce, skip, or
  always-enqueue behavior.

Flow:

1. Dispatch creates an automation run with source and trigger evidence.
2. Concurrency gate checks active issue, active chat run, or active automation
   run according to policy.
3. Output routing creates an issue or chat-native run.
4. Run status updates as linked work starts and finishes.
5. Automation detail shows run history and terminal state.

Invariants:

- A skipped/coalesced automation must still leave enough evidence for operators
  to know why no new work appeared.
- Linked issue/chat/run ids are source of truth for navigating output.

Evidence:

- `server/src/__tests__/automations-e2e.test.ts` covers end-to-end run
  lifecycle through service/API behavior.
- `tests/e2e/automation-detail-layout.spec.ts` covers run-history visibility.
- Known gap: run-state recovery policy should be tightened if automation runs
  become distributed across multiple workers instead of the current server
  process path.
