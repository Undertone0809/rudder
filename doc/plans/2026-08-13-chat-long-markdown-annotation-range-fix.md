---
title: Chat long Markdown annotation range fix
date: 2026-08-13
kind: fix-plan
status: review_ready
area: chat
entities:
  - messenger_chat
  - response_annotations
issue:
related_plans:
  - 2026-07-23-chat-response-annotations.md
  - 2026-07-24-chat-response-annotation-usability-fix.md
  - 2026-07-29-side-panel-text-file-editing-and-annotations.md
supersedes: []
related_code:
  - ui/src/lib/chat-response-annotation-selection.ts
  - server/src/services/chat-inline-annotation-rendering.ts
  - server/src/services/chat-inline-annotation-validation.ts
  - tests/e2e/chat-response-annotations.spec.ts
commit_refs: []
updated_at: 2026-08-13
---

# Chat Long Markdown Annotation Range Fix

## Problem

A normal operator selection can be rejected with `422` when it spans a
production-shaped assistant response containing headings, several Markdown
lists, inline code, and resolved entity links. The client and server currently
derive slightly different visible text for the same immutable source range.

The earlier boundary fix remains present and covers a selection ending at the
start of the next block. It does not cover a long mixed-block selection such as
the reported workflow.

## Outcome

- A valid selection across multiple rendered Markdown blocks sends normally.
- The client and server agree on semantic line breaks and visible link labels.
- Exact source hash, source range, surrounding context, organization scope, and
  anti-forgery validation remain enforced.
- A failed send continues to preserve the complete draft for retry.

## Implementation

1. Reproduce the reported selection shape with deterministic UI and service
   fixtures before changing the mapping.
2. Make source-range projection independent of boundary markers that can alter
   the Markdown parse at list, link, or inline boundaries.
3. Keep dynamic entity-label resolution organization-scoped and require the
   selected text to equal one valid visible projection of the exact range.
4. Add unit, service, and browser E2E coverage for the full send and reload
   journey plus fabricated-text rejection.

## Verification

- Focused UI and server annotation tests.
- Focused `chat-response-annotations` E2E with production-shaped content.
- `pnpm lint`, recursive typecheck, full test run, build, and
  `pnpm product-logic:check`.
- Packaged Desktop verification because the reported failure occurred in the
  Desktop shell.
- Independent stage review, exact-candidate black-box verification, and final
  reviewer acceptance before commit and push.

### Evidence

- Focused component, selection, and service tests: 158 passed.
- Real isolated UI/API/PostgreSQL E2E: the long mixed-block send, persistence,
  and reload journey plus the ordered-list boundary and rich CJK mapping cases
  passed (3 tests).
- Recursive typecheck passed; `product-logic:check` validated 96 contracts.
- UI suite reached 3008 passing tests; two unrelated suites failed to collect
  because the current xterm dependency expects a browser `self` global.
- The repository-wide suite is currently blocked by unrelated baseline failures:
  stale migration expectations omit `0154_goal_owner_runtime_overrides.sql`, and
  two Assignment Run guardrail continuation tests fail deterministically.
- Lint is blocked by import ordering in 12 untouched baseline files.
- Production UI/server compilation passed. The root build and
  `desktop:verify` are blocked in the unchanged native workspace because
  `native/Cargo.toml` does not define the inherited `workspace.package.edition`.

## Product Logic

This is a compatibility-preserving repair under
`CHAT.RESPONSE.ANNOTATION.001`. It does not require a Product Logic Registry
delta, and this plan does not authorize edits under `doc/product/**`.
