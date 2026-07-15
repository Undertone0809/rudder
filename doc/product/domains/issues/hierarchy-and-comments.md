---
title: Issue Hierarchy And Comments
domain: issues
status: active
coverage: detailed
contract_ids:
  - ISSUE.HIERARCHY.001
  - ISSUE.COMMENTS.001
related_code:
  - packages/db/src/schema/issues.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.ts
  - server/src/routes/issues.comments-attachments.ts
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/IssueProperties.tsx
  - ui/src/components/CommentThread.tsx
related_tests:
  - tests/e2e/issue-detail-subissues.spec.ts
  - tests/e2e/issue-comment-mentions.spec.ts
  - tests/e2e/issue-comment-mention-boundary.spec.ts
  - server/src/__tests__/issue-comment-reopen-routes.test.ts
edit_policy: user_confirmed_only
---

# Issue Hierarchy And Comments

## ISSUE.HIERARCHY.001

Why:

- Parent and sub-issues let a large request become a reviewable tree of agent
  work without losing its original context.
- The hierarchy is part of the agent-facing context, not only a UI grouping:
  agents need to know whether they are acting on the root problem, a delegated
  slice, or a review child.

Product model:

- An issue may have one `parent_id`.
- Parent and child issues must belong to the same organization.
- An issue cannot be its own parent and cannot create a parent cycle.
- A child issue created from a parent inherits enough starting context to stay
  attached to the same work stream. When project is omitted, parent project is
  the default project context.
- Parent context is exposed as ancestors for detail, runtime, and navigation
  surfaces.

Flow:

1. A board operator or agent creates a sub-issue from an issue detail or API
   path.
2. Rudder validates organization boundary, self-parent, and cycle constraints.
3. Rudder stores the parent link and records activity/reference evidence for
   the relationship.
4. Issue detail exposes the parent breadcrumb/context and a children list.
5. Agent-facing issue context may include ancestors so the runtime can preserve
   why this sub-issue exists.

Invariants:

- Parent/child relationships never cross organization boundaries.
- A hierarchy update must not silently orphan context that the issue runtime
  depends on.
- Issue hierarchy does not override assignment, reviewer, checkout, or run
  admission rules; it supplies context for those contracts.

Evidence:

- Activity references include parent issue evidence when sub-issues are created
  or linked.
- Issue Detail shows parent context and sub-issue navigation.
- E2E coverage exercises sub-issue creation and visible hierarchy.

Related code:

- `packages/db/src/schema/issues.ts`
- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/components/IssueProperties.tsx`

Related tests:

- `tests/e2e/issue-detail-subissues.spec.ts`

## ISSUE.COMMENTS.001

Why:

- Comments are the local collaboration record on an issue. They preserve human
  clarification, agent close-out, review notes, reopen intent, and directed
  attention.
- Comments are not just text: a comment can become a wake source, a reopen
  signal, review evidence, or a Messenger issue-thread entry.

Product model:

- A comment belongs to exactly one issue and organization.
- The author is either a board/user actor or an agent actor.
- Comment bodies may contain readable references such as issue, chat, document,
  or Library links; rendering belongs to collaboration contracts.
- Comment creation and editing are issue-local evidence; wakeup eligibility belongs to
  `ROUTING.ATTENTION.001` and `ROUTING.COMMENT.WAKE.001`.

Flow:

1. Actor posts an issue comment through the issue route or UI thread.
2. Rudder writes the comment and records `issue.comment_added` activity.
3. Rudder parses directed agent mentions and explicit reopen intent.
4. Routing decides which agents, if any, should wake and with what source.
5. Issue Detail and Messenger issue-thread surfaces show the comment in the
   work timeline.
6. When the human author edits a comment, Rudder records
   `issue.comment_updated`, compares directed wake mentions before and after
   the edit, and routes only agents newly mentioned by that edit.
7. The comment row is locked while the old and new mention sets are compared.
   The updated body and one queued wake request per newly mentioned agent are
   committed in the same transaction before runtime launch is attempted.

Invariants:

- Comment creation must leave durable issue evidence before any wake is relied
  on.
- Mention parsing must not silently reassign the issue.
- Keeping an existing mention during an edit must not wake the agent again;
  removing a mention does not wake the removed agent.
- Adding a mention again after a prior edit removed it is a new directed
  request and may wake that agent again.
- Activity-log or runtime-launch failure after commit must not erase the
  persisted mention wake request.
- Reopen-via-comment is explicit state/workflow evidence, not a hidden status
  mutation.

Evidence:

- Comment thread shows the authored body and ordering.
- Wakeup requests can reference the source comment id.
- Concurrent edit coverage proves that identical new mentions create one
  queued wake request, while a later remove-and-readd creates a new request.
- Reopen tests prove closed issues can be reactivated by an explicit comment.

Related code:

- `server/src/routes/issues.comments-attachments.ts`
- `ui/src/components/CommentThread.tsx`

Related tests:

- `server/src/__tests__/issue-comment-reopen-routes.test.ts`
- `tests/e2e/issue-comment-mentions.spec.ts`
- `tests/e2e/issue-comment-mention-boundary.spec.ts`
