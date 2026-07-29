---
title: Preserve original images in Chat issue proposals
date: 2026-07-26
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_issue_proposals
  - chat_attachments
issue: R6Z-27
related_plans:
  - 2026-07-23-chat-created-issue-work-manifest.md
  - 2026-07-26-chat-composer-file-drop.md
supersedes: []
related_code:
  - server/src/services/chat-assistant.ts
  - server/src/services/chat-assistant.helpers.ts
  - server/src/services/chat-assistant.proposal-validation.ts
  - server/src/services/chat-assistant.annotations.ts
  - server/src/__tests__/chat-assistant.test.ts
  - tests/e2e/chat-proposal-review.spec.ts
  - doc/product/domains/collaboration/chat-messenger-im.md
commit_refs: []
updated_at: 2026-07-26
---

# Preserve Original Images in Chat Issue Proposals

## Summary

Teach the Chat assistant to retain relevant user-provided source images in
initial and revised Issue Proposal descriptions. User-visible Markdown must
reference the attachment's canonical `contentPath`; the materialized
`localPath` remains runtime-only inspection context.

## Problem

The Chat prompt currently tells the runtime to inspect image attachments and
provides both canonical and local paths, but it does not explain which path is
safe for a user-visible proposal. It also does not require a revision turn to
reconsider relevant attachments from earlier messages. The resulting proposal
can omit the strongest source evidence or leak a temporary runtime path.

## Scope

- Add invariant Issue Proposal image guidance to the Chat base instruction.
- Clarify the distinct roles of canonical `contentPath` and runtime-only
  `localPath` in attachment prompt metadata.
- Apply the rule to both initial proposals and revision proposals within the
  existing bounded prompt history.
- Reject generated proposal output that includes a materialized attachment
  `localPath` or a Markdown image target that is not the canonical
  `contentPath` of an available user image attachment.
- Preserve only directly relevant user-provided images with meaningful alt
  text; never invent a path or copy all attachments indiscriminately.
- Update `CHAT.LIFECYCLE.001` and its evidence for the new agent-visible and
  user-visible behavior.
- Add prompt regression tests and a real proposal-review E2E that exercises
  upload, Request changes, approval, and Issue Detail persistence.
- Do not change upload, storage, Markdown rendering, approval gating, or Issue
  attachment behavior.

## Implementation Plan

1. Add base instruction rules for original-image selection, Markdown
   construction, canonical path use, revision inheritance, and negative cases.
2. Strengthen the latest-attachment prompt section so path roles are explicit
   where the runtime first sees materialized attachment metadata.
3. Add prompt and output-validation tests for initial proposals, historical
   attachment recovery during revisions, canonical-path safety, and relevance
   filtering.
4. Add a proposal-review E2E whose runtime stub derives the image URL from the
   real prompt, emits it in both proposal versions, and verifies the approved
   Issue preserves the same original image without a `localPath`.
5. Align the Product Logic contract and run repository-required validation.

## Design Notes

`contentPath` is durable, authenticated Rudder asset identity suitable for
Markdown rendered inside the product. `localPath` is a transient file created
for the current runtime attempt so the model can inspect bytes directly. The
prompt must not blur these roles.

Revision feedback is usually a new user message without attachments. The
assistant therefore has to reconsider image attachments already present in
`recentMessages`; the existing 12-message prompt boundary remains authoritative
and no broader attachment lookup is introduced.

This is an instruction and contract change with a narrow deterministic safety
boundary, not server-side proposal rewriting. Rudder rejects a generated
proposal if it exposes a materialized attachment `localPath` or embeds an image
whose target is not an available user image attachment's canonical
`contentPath`, including CommonMark reference-style images. Only user-authored
image attachments enter that allowlist. The E2E uses a prompt-aware runtime
stub to prove the canonical source path survives the complete UI workflow.

## Success Criteria

- Relevant original images render in initial and revised Issue Proposal cards.
- Both proposal versions reference the same canonical attachment
  `contentPath`.
- Temporary local paths, internal fetch commands, and authentication material
  never appear in proposal JSON, Markdown, or the created Issue description.
- Unrelated images are not added automatically.
- Missing, non-image, or ambiguous evidence never produces an invented image
  reference.
- Approving the revised proposal creates an Issue whose detail renders the same
  original image.

## Validation

- Focused `chat-assistant` prompt and safety tests: 72 passed.
- Focused Chat proposal-review Playwright E2E: passed.
- `pnpm product-logic:check`: 79 contracts valid.
- Workspace typecheck, lint, architecture boundary/tests, and production build:
  passed. The architecture ratchet reported no comparison regression from this
  change, but its command remained red because unrelated current work lacks a
  debt exception for `ui/src/pages/AgentDetail.integrations.tsx`.
- Repository-wide tests: 5,420 passed, 71 failed, and 731 skipped; the failures
  were pre-existing host-environment and shared PostgreSQL capacity failures,
  not failures in the scoped Chat proposal tests.
- Real rendered screenshots verified the initial proposal, revised proposal,
  and created Issue Detail.
- Independent adversarial review and black-box verification completed.

## Open Issues

None.
