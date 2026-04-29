---
title: Chat user input composer panel
date: 2026-04-30
kind: proposal
status: proposed
area: chat
entities:
  - messenger_chat
  - chat_plan_mode
  - request_user_input
issue: RUD-164
related_plans:
  - 2026-04-18-chat-plan-mode.md
  - 2026-04-28-chat-plan-mode-request-user-input.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - packages/shared/src/types/chat.ts
  - server/src/services/chat-assistant.ts
  - tests/e2e/chat-plan-mode-user-input.spec.ts
commit_refs:
  - docs: add chat user input composer panel spec
updated_at: 2026-04-30
---

# Chat User Input Composer Panel

## Overview

Plan mode now makes a structured `request_user_input` tool available to the
assistant. The tool is not automatically triggered by entering plan mode. It is
an explicit assistant action for the moment when the agent is missing a blocking
decision and should ask the user instead of making a risky assumption.

The current UI renders that request as a card inside the assistant message
stream. That is technically correct, but it gives the interaction the wrong
role: a blocking question from the assistant behaves like historical message
content instead of the current input surface.

This proposal moves unanswered `user_input_request` messages into a compact
composer-level decision panel inspired by Codex's plan-mode interaction. The
panel should preserve Rudder's operator-tool density while adopting the Codex
pattern that matters: when the run is blocked on the user, the bottom input
area becomes the decision surface.

This proposal also clarifies the boundary between two Codex-style plan-mode
tools:

- `update_plan`: updates the assistant's visible execution plan. It is not a
  question and should not create a user-input panel.
- `request_user_input`: asks one to three short questions and waits for an
  answer. This is the only tool that creates the decision panel described here.

## What Is The Problem?

Current state:

- Plan mode exposes structured user-input requests, while default mode does not.
  In default mode the assistant should either ask in prose or make a reasonable
  assumption and continue.
- `user_input_request` messages are parsed from
  `structuredPayload.requestUserInput.questions`.
- `ui/src/pages/Chat.tsx` renders them through `RequestUserInputCard` under the
  assistant message body.
- The card exposes protocol language (`request_user_input`) and uses large
  option cards plus a `Send answer` button.
- The normal composer remains the dominant bottom input surface.

Problem:

- The UI treats a blocking decision as an assistant-message attachment.
- The user has to scan the message stream to find the active decision point.
- The visual language is too much like a form card and not enough like the
  current run's required input.
- Protocol naming leaks into the product surface.
- The composer competes with the request even though the assistant is waiting
  for this answer before continuing.

Impact:

- Plan-mode pauses feel less intentional than Codex's interaction model.
- The user can miss the request or interpret it as optional message content.
- Product copy can accidentally imply that plan mode itself asks questions,
  rather than saying that plan mode enables a structured question tool when the
  assistant chooses to use it.
- Future contributors have no design rule for whether new blocking chat objects
  belong in the transcript, composer, or review-card layer.

## What Will Be Changed?

This proposal changes the rendering contract for pending `user_input_request`
messages only.

1. Keep the persisted message kind and server contract unchanged.
2. Derive the latest unresolved `user_input_request` in the active conversation.
3. Render that unresolved request as a composer-level decision panel.
4. Stop rendering the same unresolved request as an in-message card.
5. Render answered historical requests in the transcript as a compact,
   non-actionable summary.
6. Disable or visually demote the freeform composer while a blocking request is
   active.
7. Add design guidance to `doc/DESIGN.md` for chat blocking input panels.
8. Update E2E coverage for placement, selection, submit behavior, and answered
   state.

## Success Criteria For Change

- A pending plan-mode input request is visible at the bottom of the chat, near
  the place where the user already expects to respond.
- The panel uses product language, not protocol language. The user should never
  see `request_user_input`.
- There is one obvious primary action for the surface: submit the selected
  answer.
- The freeform composer does not visually compete with the pending request.
- The transcript still preserves enough history to understand why the answer was
  sent.
- The implementation does not change the API, persistence model, or runtime
  adapter contract.

## Out Of Scope

- Changing the `request_user_input` protocol shape.
- Adding arbitrary multi-field forms to chat.
- Replacing proposal, approval, or issue conversion cards.
- Redesigning the whole chat shell.
- Adding cancellation semantics for a running assistant turn.
- Making `Dismiss` resolve or reject the request.
- Treating `update_plan` events as questions.
- Claiming or implying that every plan-mode run should ask the user a question.

## Design Principles

### 1. Plan Mode Enables Structured Questions, It Does Not Force Them

The UI and docs should not say that entering plan mode causes questions to
appear. The correct model is:

- plan mode exposes `request_user_input`
- the assistant may call it when missing information would otherwise require an
  unsafe guess
- default mode does not expose this structured tool, so follow-up questions are
  plain text or the assistant makes a reasonable assumption

### 2. Blocking Questions Belong At The Input Edge

An unanswered request is not just content to read. It is the next required user
action. It should live at the input edge until answered, collapsed, or made
historical.

### 3. Hide Protocol, Preserve Intent

The panel should say what the user is deciding, not what tool produced the
decision request.

Bad:

- `request_user_input`
- `Selected answers for request_user_input`

Good:

- `Implement this plan?`
- `Choose an answer to continue`
- `Yes, implement this plan`

### 4. Compact Control, Not Large Form

The panel is a focused decision tool. It should use tight rows, clear selection,
and minimal helper copy instead of large cards.

### 5. Options Are Decisions, Descriptions Are Secondary

Codex's useful pattern is a dense list of choices, with secondary rationale
available through short descriptions or info affordances. The main option label
should carry the decision. The description should explain tradeoffs without
turning every option into a large text card.

### 6. Transcript Remains The Record

The active panel is the decision surface. The transcript remains the historical
record. Once the user answers, the assistant request can collapse into a small
summary, and the user answer should remain a normal user message.

### 7. Dismiss Is Local UI State

`Dismiss` only hides or collapses the active panel for the current view. It does
not submit an answer, cancel the run, mark the request resolved, or mutate
server state. A dismissed pending request must remain recoverable from a compact
pending banner near the composer.

## User Experience Walkthrough

### Scenario A: One Question, Two Options

1. The assistant writes a plan in plan mode.
2. The assistant decides it needs a user decision before proceeding and calls
   `request_user_input`.
3. Rudder persists a `user_input_request` message asking
   `Implement this plan?`.
4. The message stream shows the assistant's plan content as usual.
5. The composer area changes into a decision panel:
   - title: `Implement this plan?`
   - option rows:
     - `1. Yes, implement this plan`
     - `2. No, keep planning`
     - optional UI-added row: `Other, and tell Rudder what to do differently`
   - footer actions:
     - `Dismiss` with `Esc`
     - primary `Submit`
6. The user selects an option and clicks `Submit`.
7. Rudder sends a normal user message containing the selected answer.
8. The decision panel disappears.
9. The original request in the transcript becomes a compact answered summary.

### Scenario B: Multiple Questions

1. The assistant asks two or three short questions.
2. The panel renders a stacked compact section per question.
3. Each section has a short header only when the header adds meaning.
4. `Submit` remains disabled until every question has a selected answer or valid
   freeform response.
5. The submitted message groups answers by question header.

### Scenario B2: Option Descriptions

1. The assistant provides short descriptions for one or more options.
2. The option label stays visible in the row.
3. The description is either:
   - shown as muted secondary text when it is short enough to fit without
     inflating the row, or
   - hidden behind an info icon tooltip/popover when it is longer.
4. The description does not become the primary row content.

### Scenario C: Dismiss And Restore

1. The user presses `Esc` or clicks `Dismiss`.
2. The panel collapses into a single-line pending banner above the composer:
   `Assistant needs input to continue`.
3. The banner has a `Answer` action.
4. The normal composer may be visible, but should be visually secondary and
   should not imply that the request has been resolved.
5. Clicking `Answer` restores the full decision panel.

### Scenario D: Historical Answered Request

1. A previous request already has a following user reply.
2. The assistant message does not render the full option selector.
3. The transcript may show a compact non-actionable marker:
   `Input requested: Implement this plan?`
4. The following user message remains the canonical submitted answer.

### Scenario E: `update_plan` During The Same Run

1. The assistant calls `update_plan` before or after asking a question.
2. Rudder may show plan-step updates in the transcript or run activity UI.
3. `update_plan` never creates the composer decision panel.
4. Only a persisted `user_input_request` message can create the panel.

## Component Contract

### Pending Request Derivation

The UI should derive one active request from the visible conversation:

- message kind is `user_input_request`
- request payload parses successfully
- message does not have a following user reply in the same conversation branch
- message is the latest unresolved request when several exist

If multiple unresolved requests exist because of historical branching or
unexpected runtime behavior, show only the latest active request in the composer
panel and render older unresolved requests as compact transcript markers with an
`Answer latest request below` note.

### Panel Placement

The panel should render inside the chat main column at the bottom, directly
above or in place of the existing composer shell.

Preferred layout:

- max width follows the existing composer/content width
- left edge aligns with the composer input
- bottom spacing matches existing composer rhythm
- panel stays inside the main chat card, not as a global overlay

The panel should not be placed:

- inside the assistant message body for the active unresolved request
- as a centered modal
- as a toast
- in the left conversation list

### Visual Structure

Panel anatomy:

1. Header row:
   - question text or first question text
   - optional compact status label such as `Needs input`
2. Body:
   - compact numbered option rows
   - optional one-line descriptions in muted text
   - optional info icon next to an option label for longer descriptions
   - optional freeform row when supported
3. Footer:
   - secondary `Dismiss`
   - keyboard hint `Esc`
   - primary `Submit`

Recommended visual defaults:

- background: existing panel or composer surface token
- border: soft border token
- radius: small Rudder control radius, not a large pill or theatrical modal
- padding: `12-16`
- row height: `32-40` for simple options
- option row radius: base control radius
- selected state: accent border or subtle accent background, not a bright block
- primary button: one compact primary CTA
- optional keyboard/navigation affordances can appear at the row edge only when
  the row is focused or the panel has keyboard focus

The Codex reference uses a larger rounded dark panel. Rudder should take the
interaction model, not the exact visual mass. Keep the panel compact enough to
read as part of the chat tool surface rather than as a modal stage.

### Options And Freeform Response

The underlying `request_user_input` contract usually provides two or three
options per question. The UI may add one local freeform escape hatch when that
improves recovery:

- label: `Other, and tell Rudder what to do differently`
- behavior: selecting it reveals a compact text input
- submit state: disabled until the text input has content
- output: send the freeform text as the answer for that question

This UI-added freeform row should not be treated as a fourth tool-provided
option. It is a local interaction affordance for correction, similar to Codex's
`No, and tell Codex what to do differently` pattern.

### Recommended Options

If an option label contains `(Recommended)`, the panel should preserve that
language in the row label. It may also apply a very subtle emphasis to that row,
but it should not auto-select the option unless the request payload explicitly
supports defaults in the future.

### Copy

Default copy:

- status label: `Needs input`
- primary action: `Submit`
- secondary action: `Dismiss`
- restore banner: `Assistant needs input to continue`
- restore action: `Answer`
- freeform escape hatch: `Other, and tell Rudder what to do differently`

Avoid:

- `request_user_input`
- `Send answer`
- `Question 1` when the supplied header is better
- verbose helper paragraphs
- `Plan mode is asking a question`

Preferred explanatory language when needed:

- `The assistant needs input to continue.`
- `Plan mode allows structured questions when the assistant should not guess.`

### Keyboard Behavior

- `Esc`: dismiss/collapse panel locally.
- `Enter`: submit only when focus is on a selected option row and all required
  questions have valid answers.
- `Cmd+Enter` / `Ctrl+Enter`: submit from anywhere inside the panel when valid.
- Arrow keys: move between option rows within the focused question group.
- Tab order: header is skipped, options first, then Dismiss, then Submit.

### Accessibility

- Each question group should use `role="radiogroup"` or equivalent accessible
  semantics.
- Each option row should expose selected state through native radio input or
  `aria-checked`, not only color.
- The panel should announce when it appears after an assistant turn completes.
- Disabled submit should explain missing selections through accessible text or
  field state.
- Freeform inputs must have explicit labels.

## Data And API Contract

No backend contract changes are required.

Current input:

- `ChatMessage.kind === "user_input_request"`
- `message.structuredPayload.requestUserInput.questions`
- each request contains one to three questions
- each question has `id`, `header`, `question`, and `options`
- each question usually has two or three options
- each option has `id`, `label`, and optional `description`

Non-input events:

- `update_plan` updates plan steps and must not be parsed as a question.
- Plain assistant text questions in default mode should remain normal transcript
  messages unless they are persisted as `user_input_request`.

Current output:

- User answer is sent through the existing chat send path as a normal user
  message.

Recommended answer format remains machine-readable enough for the assistant:

```text
Selected answers:
- Scope: Yes, implement this plan
- Runtime: Use Codex plan mode
```

The output text should remove `request_user_input` from the user-facing answer
body unless runtime parsing strictly requires it. If the current assistant prompt
depends on the old phrase, update the prompt and tests together.

Recommended prompt alignment:

- explain that `request_user_input` is only available in plan mode
- tell the assistant to use it for blocked decisions, not routine clarification
- keep `update_plan` guidance separate from user-input guidance
- tell the assistant not to claim that plan mode itself asked the question

## Implementation Notes

### Chat.tsx

Likely changes:

- Keep `userInputRequestFromMessage`.
- Replace `RequestUserInputCard` with a composer-level component, for example
  `PendingUserInputPanel`.
- Add a selector such as `latestPendingUserInputRequest`.
- Stop rendering the full selector in `ChatMessageItem` for active pending
  requests.
- Add compact transcript rendering for historical or dismissed requests.
- Store dismissed panel state by message id in local component state.
- Clear dismissed state when:
  - a new request appears
  - the user selects `Answer`
  - the active conversation changes
  - the user sends an answer

### Branching And Following Reply Detection

The existing `messageHasFollowingUserReply(message)` behavior is a reasonable
starting point. The implementation should ensure it checks the visible branch or
current message ordering, not just raw conversation history, so a branched chat
does not incorrectly disable a request from another branch.

### Composer Interaction

When a pending request is active and not dismissed:

- hide the freeform composer, or render it disabled beneath the panel
- do not auto-focus the freeform composer
- focus the first option row or the first freeform input

When dismissed:

- restore the freeform composer
- keep a compact pending banner above it
- make the banner visually lighter than the full panel but clear enough that the
  request has not been answered

## Non-Functional Requirements

### Maintainability

- Keep request parsing pure and testable.
- Keep the panel component local to `Chat.tsx` unless it becomes reused by other
  surfaces.
- Do not introduce a new global state store.

### Accessibility / Usability

- Keyboard-only answer flow must work.
- Screen-reader semantics should behave like question groups, not generic
  buttons.
- The user must be able to recover from `Dismiss`.

### Performance

- The selector should be derived from visible messages without new network calls.
- No virtualization or transcript rendering changes should be required.

## Testing Plan

### Goal

Prove that pending `user_input_request` behaves as a composer-level blocking
decision surface and still submits through the existing chat message path.

### Automated E2E

Update `tests/e2e/chat-plan-mode-user-input.spec.ts`:

- pending request renders near the composer, not inside the assistant message
  body
- protocol label `request_user_input` is not visible
- submit is disabled until required selections are made
- choosing an option and submitting sends a user message with the selected label
- option descriptions render as secondary text or info affordances without
  expanding rows into large cards
- recommended labels are preserved
- the UI-added freeform row can submit correction text when enabled
- after submit, the active panel disappears
- historical request no longer renders an actionable selector
- `Dismiss` collapses the panel and `Answer` restores it
- `update_plan` activity does not create a user-input panel

### Unit / Component-Level Tests

If the existing test setup supports it, cover:

- latest pending request derivation
- following-user-reply detection
- answer text formatting without protocol leakage
- multi-question validation

### Manual Visual Verification

Capture desktop/browser screenshots for:

- active one-question request
- active multi-question request
- dismissed pending banner
- answered historical state

Verify both light and dark themes if the screenshot environment supports it.

### Required Validation

For implementation:

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- targeted E2E:
  `pnpm test:e2e -- tests/e2e/chat-plan-mode-user-input.spec.ts`
- browser or desktop visual verification screenshot for the chat composer panel

## Documentation Changes

If this proposal lands, update:

- `doc/DESIGN.md`
  - add a short rule under chat/review/composer guidance:
    blocking chat input requests render at the composer edge, not as normal
    message cards
- `doc/plans/2026-04-28-chat-plan-mode-request-user-input.md`
  - add a note that the follow-up UI spec supersedes the initial in-message card
    rendering direction

## Open Issues

1. Should `Other` be part of the Rudder shared contract, or only a UI affordance
   that sends freeform text as the answer for a selected question?
2. Should dismissed pending requests allow freeform chat sends, or should the
   composer remain disabled until the request is answered?
3. Should historical unanswered requests from alternate branches expose an
   `Answer` action, or should only the latest visible branch request be
   actionable?
4. Should the submitted answer body keep a hidden structured payload in the
   future, instead of relying on markdown text?
5. Should option descriptions always use tooltips/popovers, or should short
   descriptions remain inline when they do not increase row height?
6. Should the prompt encourage `request_user_input` only after a draft plan
   exists, or also during early plan scoping when a missing decision changes the
   investigation path?
