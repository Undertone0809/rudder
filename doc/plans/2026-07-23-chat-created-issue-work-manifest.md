---
title: Chat-created issue Work manifest reference
date: 2026-07-23
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - chat_work_manifest
  - side_panel
issue: R6Z-15
related_plans:
  - 2026-07-12-chat-work-manifest.md
  - 2026-07-01-global-side-panel-workbench.md
supersedes: []
related_code:
  - server/src/services/chat-work-manifest.ts
  - server/src/__tests__/chat-work-manifest.test.ts
  - ui/src/lib/queryKeys.ts
  - ui/src/context/LiveUpdatesProvider.tsx
  - ui/src/context/LiveUpdatesProvider.test.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.attachment-preview.test.tsx
  - ui/src/pages/Chat.work-manifest.tsx
  - ui/src/pages/Chat.work-manifest.test.tsx
  - tests/e2e/chat-proposal-review.spec.ts
  - tests/e2e/chat-work-manifest.spec.ts
  - ui/src/pages/Chat.tsx
  - doc/product/domains/collaboration/chat-messenger-im.md
commit_refs:
  - "fix: show chat-created issue in work manifest"
  - "fix: show issue status in chat work manifest"
updated_at: 2026-07-23
---

# Chat-created issue Work manifest reference

## Goal

Make the current Chat's successfully created primary issue appear once in the
conversation Work manifest as a `Reference`, without scanning system events or
introducing another issue-preview surface.

## Product logic alignment

- Change `CHAT.THREAD.MANIFEST.001`: the current conversation's
  `primaryIssueId` is authoritative structured evidence for an issue Reference.
- Reuse `CHAT.SIDE.PANEL.001`: opening the Reference uses the existing global
  issue Side Panel and preserves the Chat route, draft, and scroll context.
- Keep pending, rejected, and revision-requested proposals out of the manifest
  because those states do not set `primaryIssueId`.
- Keep the projection organization- and conversation-scoped. Project membership
  must not import issues from another Chat.

The approved R6Z-15 scope explicitly authorizes the concrete
`doc/product/domains/collaboration/chat-messenger-im.md` update above.

## Existing behavior

- `convertToIssue` writes the created issue id to
  `chat_conversations.primary_issue_id` and stores an issue context link whose
  metadata may contain the proposal `sourceMessageId`.
- `GET /api/chats/:id/work-manifest` already reconciles visible message links,
  attachments, and eligible Project resources.
- Visible explicit issue links already use `issue:<issue-id>` for their target
  key and carry `issueId` / `ref` metadata.
- Chat approval and direct conversion success paths already invalidate the
  selected Chat's Work manifest query.
- Work manifest issue rows already open the global issue Side Panel.

## Implementation

1. Read `primaryIssueId` from the selected conversation during reconciliation.
2. Resolve that issue with both its id and the conversation's organization id.
   A missing, deleted, detached, or cross-organization issue produces no
   candidate.
3. Resolve only the matching issue context link in the same organization and
   conversation. Preserve its `sourceMessageId` only when that id belongs to the
   current active visible user/assistant message set.
4. Merge one `reference` / `issue` candidate using `issue:<issue-id>`, a title
   containing both the readable identifier and issue title, and metadata with
   `issueId` and `ref`.
5. Let the existing reconciliation transaction update, deduplicate, or remove
   the derived row. Do not give this Reference durable Output retention.
6. Hydrate resolvable same-organization issue and issue-comment References with
   the issue's current status, and render the canonical issue `StatusIcon`
   instead of a generic issue glyph. Keep unresolved and cross-organization
   links on the generic fallback without leaking status.
7. Keep the existing issue Side Panel target mapping unchanged. Start the
   selected Chat's manifest invalidation immediately in `refreshChat`, because
   regression testing showed that waiting behind broader list refreshes delayed
   the new Reference.
8. Invalidate the organization-scoped Work manifest query prefix after a local
   Side Panel issue update and after issue live activity. Expose the rendered
   status through an accessible row description while keeping the visual icon
   decorative and the issue title as the row's accessible name.

## Regression coverage

### Service

Extend `server/src/__tests__/chat-work-manifest.test.ts` to prove:

- no issue Reference exists before `primaryIssueId` is set;
- a same-organization primary issue becomes one Reference with readable title,
  canonical key, metadata, and valid proposal provenance;
- an explicit visible `issue://` link and `primaryIssueId` deduplicate;
- superseded or foreign message provenance is omitted;
- a primary issue from another organization is not projected;
- clearing the association or deleting the issue removes the derived row.
- current same-organization issue status is hydrated without leaking status
  from an unresolved or cross-organization target.

### Client

Extend focused UI tests to prove:

- issue activity and a successful Side Panel issue mutation invalidate the
  current organization's Work manifest prefix;
- issue rows render the canonical status glyph and expose a screen-reader
  status description without changing the title-based row name.

### End to end

Extend `tests/e2e/chat-proposal-review.spec.ts` so manual approval proves:

- no issue Reference is visible while the proposal is pending;
- approval makes the issue appear without a page refresh;
- the row contains the identifier, title, and canonical issue status icon;
- clicking the row opens the correct issue in the current Chat's Side Panel
  without changing the route;
- closing the panel restores the Work manifest.

Retain `tests/e2e/chat-work-manifest.spec.ts` as the explicit issue-link and
Side Panel regression path. Auto-create and direct conversion share the same
persisted `primaryIssueId` projection and existing query invalidation, so the
service cases plus their existing creation-flow coverage guard those entry
points without duplicating the full UI scenario.

## Verification

Run:

```text
pnpm exec vitest run server/src/__tests__/chat-work-manifest.test.ts
pnpm product-logic:check
pnpm exec playwright test tests/e2e/chat-proposal-review.spec.ts
pnpm exec playwright test tests/e2e/chat-work-manifest.spec.ts
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
```

Use an isolated worktree runtime for the final dark-theme browser check and
capture the approved issue Reference plus its open Side Panel. An independent
reviewer should inspect the bounded diff, and an independent verifier should
exercise the real local workflow before handoff.

## Outcome

- The current conversation's same-organization primary issue is projected once
  as a Reference and wins canonical deduplication over explicit issue links,
  including current identifiers resolved case-insensitively.
- Same-organization issue References carry their current issue status and use
  the canonical status glyph; unresolved and cross-organization links retain
  the generic issue fallback.
- Side Panel issue changes and issue live activity invalidate the current
  organization's manifest cache, so restored rows do not retain stale status.
  The status is also available as an accessible description.
- Proposal provenance is retained only for a current visible source message;
  cleared, deleted, detached, and cross-organization associations reconcile
  away.
- The approval E2E proves pre-approval absence, no-refresh appearance, the
  canonical status icon, correct Side Panel identity, unchanged Chat URL,
  preserved draft, and manifest restoration after close. Independent review
  and black-box verification found no remaining blocker.
- Focused service tests, related E2E scenarios, product-logic validation,
  changed-file import lint, typecheck, and the repository build pass.
  Repository-wide lint and Vitest retain unrelated baseline/environment
  failures outside the files changed by this plan.
- Legacy relative links that use an organization prefix alias from before an
  organization rename safely retain the generic issue icon. They still open the
  correct issue and do not leak status; alias hydration remains a separate
  compatibility improvement.
