---
title: Agent Run Chat Annotations
date: 2026-08-03
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - agent_runs
  - response_annotations
  - side_panel
issue:
related_plans:
  - 2026-07-23-chat-response-annotations.md
  - 2026-07-29-side-panel-text-file-editing-and-annotations.md
supersedes: []
related_code:
  - packages/shared/src/types/chat.ts
  - ui/src/components/transcript/RunTranscriptView.tsx
  - ui/src/pages/AgentDetail.runs.tsx
  - server/src/routes/chats.stream-routes.ts
commit_refs: []
updated_at: 2026-08-03
---

# Agent Run Chat Annotations

## Outcome

Run Transcript review can stage annotations from the current Agent's stable
Nice transcript, open a reusable Chat composer in the Side Panel, and collect
annotations across Run Detail navigation before one ordinary Chat Send. The
current Agent is fixed, project context defaults to no project and locks after
the first message, and the resulting Chat remains Messenger-visible.

## Boundaries

- Reuse existing selection toolbar, annotation editor, composer, Side Panel,
  Run rail, and Chat message evidence UI.
- Support terminal, canonicalized Nice Transcript blocks only. Raw,
  Invocation, hidden lifecycle content, and incomplete live blocks are not
  annotation sources.
- Store Run provenance in the existing message-owned structured annotation
  payload. Do not introduce a separate feedback or learning object in v1.
- Preserve drafts by organization and Agent, including cross-Run navigation;
  pending file bytes retain existing Chat draft durability semantics.

## Contract Delta

The implementation updates `CHAT.RESPONSE.ANNOTATION.001`,
`CHAT.LIFECYCLE.001`, `CHAT.SIDE.PANEL.001`, `RUN.AGENT.UNIFICATION.001`,
`RUN.RESULT.001`, `RUN.CHAT.AGENT.001`, `ORG.PROJECT.001`, and the Agent Run
surface map after implementation and before hand-off.

## Validation

Focused shared/server/UI tests cover Run provenance, source validation,
annotation-only first Send, idempotency, draft recovery, project locking,
cross-Run navigation, and stale anchors. Chromium E2E covers hover and text
selection, two Runs in one draft, Send persistence, source jump-back, desktop
and mobile layouts, keyboard/focus, and reduced motion. Final verification
includes product-logic check, lint, recursive typecheck, tests, build, and an
independent real local black-box review.
