---
title: Issue comment mention wakeup boundary
date: 2026-06-06
kind: implementation
status: completed
area: agent_runtimes
entities:
  - issue_comments
  - agent_mentions
  - wakeup_admission
issue:
related_plans:
  - 2026-02-20-issue-run-orchestration-plan.md
  - 2026-05-29-copy-chat-link.md
supersedes: []
related_code:
  - packages/shared/src/project-mentions.ts
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/CommentThread.tsx
  - server/src/services/issues.comments-attachments.ts
  - server/src/routes/issues.comments-attachments.ts
  - server/src/routes/issues.mutations.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/src/onboarding-assets/default/HEARTBEAT.md
  - server/src/onboarding-assets/ceo/HEARTBEAT.md
commit_refs:
  - fix: separate comment mention wake intent
  - docs: teach agents clickable markdown links
updated_at: 2026-06-06
---

# Issue Comment Mention Wakeup Boundary

## Problem

Issue comments currently need two different Agent-reference behaviors:

1. A board operator uses the issue comment composer to mention an agent and get
   that agent's attention.
2. A comment, transcript, copied link, or historical Markdown body references an
   agent for display/navigation only.

The failed first fix treated every structured `agent://...` Markdown link as
render-only. That prevented useless wakeup loops from rich rendering, but it
also broke the expected user journey: choosing an agent from the issue comment
composer no longer woke that agent, because the editor serializes selected
mentions as structured Markdown links rather than bare `@Name` text.

## Decision

Keep `agent://...` as the stable entity-reference scheme, but add explicit
mention intent:

- `agent://<id>` means reference-only unless another layer explicitly treats it
  differently.
- `agent://<id>?intent=wake` means the writer selected an agent mention in an
  issue-comment surface and intends to route attention.
- Bare `@AgentName` remains a compatibility wake signal for manually typed
  comments.

The server should not infer wake intent from UI styling alone. It should resolve
wake targets from:

- visible bare `@Name` tokens in board-authored comments
- structured agent links whose parsed intent is `wake`

Agent-authored issue comments should not fan out wakeups to other agents by
default. This avoids ping-pong loops where one agent responds, quotes or
mentions another agent, and starts a no-delta runtime chain. Agents should use
issue assignment, reviewer fields, or explicit board-visible handoff language
when another owner must act.

## Agent Journey Contract

Agents must know the boundary:

- A wake caused by a comment is visible through `RUDDER_WAKE_COMMENT_ID` and
  `RUDDER_WAKE_REASON=issue_comment_mentioned`.
- When an agent wakes from a mention, it must read the wake comment before doing
  work and should not assume ownership unless the comment explicitly asks for a
  handoff.
- When an agent writes a comment, mentioning another agent is a durable
  reference/coordination note, not an automatic runtime wake. This is deliberate
  fanout protection.
- To request structured review, agents should use reviewer workflow commands;
  free-form comments and mentions are not review decisions.
- When an agent writes a user-openable URL in a comment or chat reply, it should
  make the URL clickable with standard Markdown syntax, for example
  `[NameSilo transfer page](https://www.namesilo.com/account_domain_manage_transfer.php)`.
  Bare URLs and code-spanned action URLs are not acceptable for operator-facing
  close-out comments because they are harder to click and scan in Rudder.

## Implementation

1. Extend shared agent mention parsing with an optional `intent` field and a
   helper for extracting only wake-intent structured agent mentions.
2. Teach the issue comment composer to serialize selected agent mentions with
   `intent=wake`.
3. Keep other reference surfaces on reference-only `agent://...` links.
4. Update comment wake resolution to combine bare `@Name` compatibility tokens
   with wake-intent structured links.
5. Keep agent-authored comment fanout suppression in both comment-create and
   issue-update-with-comment routes.
6. Validate structured wake-intent agent IDs against the current organization
   before queuing wakeups.
7. Update bundled Rudder skill instructions, runtime operating contract prompts,
   and onboarding heartbeat notes so agents understand the new mention contract.

## Verification Plan

- Shared parser tests:
  - reference-only agent links parse as references
  - wake-intent links extract as wake mentions
  - bare `@Name` compatibility remains server-resolved
- Editor tests:
  - issue comment composer inserts wake-intent agent links
  - generic Markdown reference serialization remains reference-only
- Route/service tests:
  - board-authored wake-intent mention queues the mentioned agent
  - reference-only `agent://...` does not wake
  - wake-intent `agent://...` IDs from another organization do not wake
  - agent-authored comments do not fan out peer wakeups
  - existing human bare `@Agent` behavior remains
  - runtime operating contract no longer teaches plain `agent://...` as wake
- Real-local validation:
  - open the local issue detail route
  - post a disposable comment using the issue comment composer mention menu
  - read back persisted comment and wakeup/run evidence from API or database
  - confirm reference-only comment does not enqueue a wakeup

## Non-Goals

- Do not introduce `/ask @Agent` or a new explicit button in this slice.
- Do not make mentions transfer ownership.
- Do not allow agent-authored comments to create unbounded peer fanout.
