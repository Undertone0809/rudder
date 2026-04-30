---
title: Messenger issue comment preview
date: 2026-04-30
kind: implementation
status: completed
area: ui
entities:
  - messenger_chat
  - issue_comments
issue:
related_plans:
  - 2026-04-10-messenger-unification.md
  - 2026-04-11-messenger-desktop-shell-overhaul.md
supersedes: []
related_code:
  - packages/shared/src/types/messenger.ts
  - server/src/services/messenger.ts
  - ui/src/pages/Messenger.tsx
  - ui/src/components/CommentThread.tsx
  - tests/e2e/messenger-contract.spec.ts
commit_refs: []
updated_at: 2026-04-30
---

# Messenger Issue Comment Preview

## Summary

Messenger issue update cards should render comment-backed activity as readable
work artifacts instead of one-line notifications. The issue detail page already
supports markdown comments and `#comment-{id}` hash highlighting; Messenger
needs the source comment id/body and a compact markdown preview.

## Implementation Plan

1. Add additive `sourceCommentId` and `sourceCommentBody` fields to
   `MessengerIssueThreadItem`.
2. Populate those fields only when the issue card's latest displayed source is
   an issue comment, while keeping thread summaries and sidebar previews short.
3. Render comment-backed issue cards in Messenger with existing `MarkdownBody`,
   collapsing only comments that exceed roughly 10 rendered lines.
4. Point comment-backed `Open issue` links at the source comment hash.
5. Harden issue detail comment hash scrolling so repeated hash navigation
   reliably scrolls and highlights the target.
6. Cover the behavior with focused service, UI, and Messenger E2E tests.

## Validation

- `pnpm test:run server/src/__tests__/messenger-service.test.ts ui/src/pages/Messenger.test.tsx` passed on 2026-04-30: 2 files, 16 tests.
- `pnpm test:e2e tests/e2e/messenger-contract.spec.ts -g "renders the mixed Messenger directory"` was attempted on 2026-04-30 but did not reach test execution because local Playwright Chromium launch timed out after 180 seconds.
- `pnpm -r typecheck` passed on 2026-04-30.
- `pnpm build` passed on 2026-04-30. The build still emitted existing large-chunk and packaged dependency warnings.
- Browser visual verification was completed against the local dev instance at `http://localhost:3100/RUD/messenger/issues` with a comment-backed issue card. Screenshots:
  - `/tmp/messenger-issue-comment-preview-browser-2026-04-30.png`
  - `/tmp/messenger-issue-comment-preview-highlight-active-2026-04-30.png`
