---
title: Attention And Wakeup Eligibility
domain: work-routing
status: active
coverage: seed
contract_ids:
  - ROUTING.ATTENTION.001
  - ROUTING.COMMENT.WAKE.001
related_code:
  - server/src/routes/issues.comments-attachments.ts
  - server/src/routes/issues.mutations.ts
  - server/src/services/runtime-kernel/heartbeat.recovery.ts
  - server/src/services/issue-review-wakeup.ts
  - ui/src/components/CommentThread.submit.ts
related_tests:
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - tests/e2e/issue-comment-mentions.spec.ts
  - tests/e2e/issue-comment-mention-boundary.spec.ts
related_plans:
  - doc/plans/2026-07-24-status-independent-explicit-issue-work.md
edit_policy: user_confirmed_only
---

# Attention And Wakeup Eligibility

## ROUTING.ATTENTION.001

Behavior:

- A new ordinary issue comment does not wake the current assignee merely
  because the issue is assigned to them.
- Comments wake agents only through explicit wake mentions such as
  `agent://<id>?intent=wake`. If the assignee is explicitly mentioned, the
  assignee wakes through the mention path.
- A comment with explicit reopen intent on a closed issue may wake the assignee
  with reason `issue_reopened_via_comment` and wake source
  `issue.comment.reopen`.
- When a reopen-by-comment needs assignee attention and the submitted comment
  did not mention the assignee, Rudder appends an assignee wake mention to the
  persisted comment before evaluating wakeups. The trigger reason remains
  `issue_reopened_via_comment`, not `issue_comment_mentioned`.
- Comments may wake mentioned agents with reason `issue_comment_mentioned` and
  wake source `comment.mention`.
- Each mention wake records whether the target is the issue's current
  `assignee`, current `reviewer`, or a `collaborator`.
- A current-assignee or current-reviewer mention is an explicit work request in
  every lifecycle state. It is serialized by the issue execution lease and
  does not implicitly change issue status or ownership.
- Editing a comment wakes only agents whose explicit wake mentions were added
  by that edit. Mentions preserved from the previous body are not re-enqueued,
  and removed mentions do not wake an agent.
- Comment-edit mention comparison is serialized under a comment-row lock. The
  edited body and mention delta commit before runtime launch is requested;
  retaining the same mention in concurrent edits cannot create two requests.
- Comment, reopen, and mention wake context includes issue and comment details.
- Rudder skips self-waking the agent that authored the comment or mention.
- Comment wakeups from the same comment are merged into one enqueue per target
  agent before calling heartbeat wakeup.
- Timer preflight (`RUN.PREFLIGHT.001`) admits timer runs when the agent has
  actionable assignee issues (`todo`, `in_progress`, `blocked`) or reviewer
  issues (`in_review`, `blocked`) that do not already have a recorded blocked
  reviewer decision.
- Timer preflight skips when no actionable work exists, and it records
  diagnostics when pending wakeups already exist.

Invariant:

- Attention wakes should expose why the agent woke.
- Timer heartbeats should not wake an agent that will immediately see no
  actionable work. The detailed admission mechanism is owned by
  `RUN.PREFLIGHT.001`.

Rationale:

- Rudder's agent team model depends on waking the right actor for the right
  reason, while keeping hidden or duplicate work out of the loop.

Related code:

- `server/src/routes/issues.comments-attachments.ts`
- `server/src/routes/issues.mutations.ts`
- `server/src/services/runtime-kernel/heartbeat.recovery.ts`
- `server/src/services/issue-review-wakeup.ts`

Related tests:

- `tests/e2e/issue-comment-mentions.spec.ts`
- `tests/e2e/issue-comment-mention-boundary.spec.ts`

## ROUTING.COMMENT.WAKE.001

Why:

- Issue comments are one of the highest-risk wake sources: over-waking creates
  duplicate agent work, while under-waking leaves human feedback unseen.
- Directed mentions must be precise enough that an operator can ask a specific
  agent a question without reassigning or disturbing the main assignee.

Flow:

1. Comment creation or editing emits issue-local evidence under
   `ISSUE.COMMENTS.001`.
2. The issue-comment composer may require explicit operator confirmation before
   posting a comment with no valid Agent wake mention. This is a localized
   submission guard only; it does not add a wake target or alter routing.
3. Routing parses explicit wake mentions such as agent links with wake intent.
   For an edit, it compares the persisted old body with the canonical updated
   body under a row lock and considers only newly added target agents.
   The route then asks heartbeat execution to wake those newly added targets.
4. Ordinary comments without wake mentions do not enqueue agent wakeups after
   the operator confirms submission.
5. Reopen comment wake uses `issue_reopened_via_comment`. If the assignee is
   eligible to wake and was not mentioned by the author, Rudder appends a wake
   mention for the assignee to the persisted comment before enqueueing.
6. Mention wake uses `issue_comment_mentioned` and is scoped to the source
   comment by `wakeCommentId`. Its context records the target's current issue
   relationship.
7. Self-wakes are skipped so an agent does not immediately wake because of its
   own comment.
8. Per-comment target wakes are merged before heartbeat wakeup is called.

Invariants:

- A mention wake does not automatically reassign the issue.
- A current-assignee or current-reviewer mention can execute regardless of
  issue status, including `in_review`, `done`, and `cancelled`; status changes
  occur only when the request or normal workflow explicitly asks for one.
- Relationship-authorized mention work uses the issue execution lease.
  Non-owner collaborator mentions retain the narrow collaboration path and do
  not gain issue ownership.
- A plain issue comment does not wake the assignee unless the assignee is also
  a wake-mentioned target.
- The composer warning for an unmentioned comment does not convert a plain
  comment into a wake request; the operator may still explicitly confirm and
  post it as ordinary collaboration evidence.
- A reopen comment that auto-appends the assignee mention still records the
  assignee wake as `issue_reopened_via_comment`; the appended mention is
  user-visible evidence, not a separate reason.
- Non-assignee mention runs should see the source comment as the reason for the
  wake, not assume full ownership of the issue.
- Comment wake context must include enough issue and comment identity for the
  runtime prompt, run snapshot, activity, and later debugging.
- Editing a comment without adding a new target must not repeat a prior mention
  wake; adding another target later wakes only that newly mentioned agent.
- Removing and later re-adding a target is a new directed request. Concurrent
  edits that retain the same target are not.

Evidence:

- `agent_wakeup_requests` records source/reason/comment context.
- Route tests prove ordinary comments do not wake assignees, assignee wake
  mentions do wake, and reopen comments append the assignee mention when needed.
- Service tests prove concurrent edit serialization and remove-then-readd
  behavior; route tests prove activity failure does not suppress an edit wake.
- Mention boundary tests prove non-wake references do not wake agents.
- Comment mention tests prove wake mentions enqueue the intended agent.

Related code:

- `server/src/routes/issues.comments-attachments.ts`
- `server/src/services/runtime-kernel/heartbeat.wakeup.ts`

Related tests:

- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `tests/e2e/issue-comment-mentions.spec.ts`
- `tests/e2e/issue-comment-mention-boundary.spec.ts`
