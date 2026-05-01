---
title: Issue Reviewer Routing
date: 2026-05-02
kind: proposal
status: proposed
area: api
entities:
  - issue_reviewer
  - review_routing
  - issue_attention
  - issue_create_dialog
issue:
related_plans:
  - 2026-02-21-humans-and-permissions.md
  - 2026-02-21-humans-and-permissions-implementation.md
  - 2026-03-13-workspace-product-model-and-work-product.md
  - 2026-04-10-messenger-unification.md
  - 2026-04-24-passive-issue-closeout-watchdog.md
supersedes: []
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/validators/issue.ts
  - packages/shared/src/types/issue.ts
  - packages/shared/src/types/messenger.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.ts
  - server/src/services/issue-assignment-wakeup.ts
  - server/src/services/messenger.ts
  - ui/src/api/issues.ts
  - ui/src/lib/assignees.ts
  - ui/src/lib/new-issue-dialog.ts
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/IssueProperties.tsx
  - ui/src/pages/Inbox.tsx
  - tests/e2e/issues-assigned-to-me.spec.ts
  - tests/e2e/issues-inline-assignee.spec.ts
commit_refs:
  - docs: refine issue reviewer routing proposal
updated_at: 2026-05-02
---

# Issue Reviewer Routing

## Overview

Add a first-class optional reviewer to issues, and make that reviewer an
attention target when work is ready for review.

This is not an approval workflow. It is the smallest durable control-plane
primitive that answers: when an assignee finishes work, who is responsible for
checking the result?

The key product decision is that reviewer selection must not stop at storage
and UI. A reviewer only has product value if the issue reaches that reviewer
when the issue enters `in_review`, and if the reviewer has an obvious way to
leave feedback, request changes, or complete the issue.

## What Is The Problem?

Current state:

- Issues already have execution ownership through `assigneeAgentId` and
  `assigneeUserId`.
- Issues already have an `in_review` status.
- Messenger and Inbox already surface issue attention for followed issues,
  created issues, assigned user issues, approvals, failed runs, and other
  operational signals.
- Agent close-out governance can emit `issue.closure_needs_operator_review`
  when successful runs fail to leave a closure signal.

Problem:

- `in_review` has no explicit target. The system can say "this needs review",
  but not "this needs review by this person or reviewer agent".
- Operators must remember the intended reviewer, mention them later, or rely on
  the assignee to route review manually.
- Human review ownership is not represented in attention surfaces unless the
  human also created, followed, or was assigned the issue.
- Agent reviewers can be woken only through ad hoc assignment or mention paths,
  which confuses execution ownership with review responsibility.

Impact:

- Real agent-work loops can stall after implementation because the check step
  is implicit.
- "Assignee" risks becoming overloaded as both implementer and checker.
- Review work is less auditable than assignment and approval work.
- Rudder's north-star loop, completed real agent work, is weakened at the point
  where output quality should be verified.

## What Will Be Changed?

This proposal changes issue storage, API contracts, attention routing, and the
issue create/detail UI.

1. Add optional reviewer fields to issues:
   - `reviewerAgentId`
   - `reviewerUserId`

2. Enforce reviewer invariants:
   - an issue may have no reviewer
   - an issue may have one reviewer agent
   - an issue may have one reviewer user
   - an issue must not have both reviewer fields set
   - reviewer principals must belong to the same organization
   - terminated or pending-approval agents cannot be selected as reviewer agents

3. Extend issue API contracts:
   - create issue accepts optional reviewer fields
   - update issue accepts optional reviewer fields, including explicit `null`
     to clear reviewer
   - issue responses include reviewer fields
   - issue list filters support `reviewerAgentId` and `reviewerUserId`
   - board `reviewerUserId=me` filter resolves to the current board user

4. Route review attention:
   - creating an issue with a reviewer does not wake anyone immediately
   - entering `in_review` with `reviewerAgentId` queues a reviewer wakeup
   - entering `in_review` with `reviewerUserId` makes the issue appear in
     reviewer-oriented human attention surfaces
   - changing reviewer while an issue is already `in_review` routes attention to
     the new reviewer

5. Add issue UI:
   - New Issue dialog exposes a `Reviewer` selector
   - Issue Properties shows, edits, and clears reviewer
   - dense issue rows and board cards do not show reviewer by default in this
     iteration

6. Add activity logging:
   - reviewer changes are logged through `issue.updated`
   - `_previous` includes old reviewer fields when they change

## Success Criteria For Change

- A user can create an issue with no reviewer.
- A user can create an issue with a reviewer agent or reviewer user.
- The reviewer is persisted and returned by issue APIs.
- The reviewer is visible and editable on issue detail.
- Invalid reviewer combinations are rejected with a 422 response.
- Reviewers are organization-scoped.
- Existing issue creation and assignee behavior continue to work.
- When an issue transitions into `in_review`, the selected reviewer receives
  attention through the correct surface:
  - reviewer agent receives one review wakeup
  - reviewer user sees the issue in reviewer issue filters and human attention
    surfaces
- Reviewer wakeups are not confused with assignment wakeups.
- E2E coverage proves the create and detail reviewer path.

## Out Of Scope

- Multiple reviewers.
- Required reviewers.
- A separate `review_requests` table.
- A separate review state machine.
- Blocking `done` solely because no reviewer is set.
- Merging Reviewer with Approver.
- External GitHub, GitLab, or Linear reviewer sync.
- Showing reviewer in default dense issue rows or board cards.
- Implementing full My Work redesign beyond the minimal filters needed for
  reviewer attention.

## Non-Functional Requirements

- Maintainability: reviewer selection should mirror the existing assignee
  shape where that reduces complexity, but review wakeups must use distinct
  naming so execution and review responsibilities stay separate.
- Security: reviewer selection must enforce organization boundaries for users
  and agents.
- Observability: review routing should be auditable through activity log entries
  and heartbeat run context.
- Usability: default state must be `No reviewer`, and the selector must not make
  issue creation feel like an approval form.
- Compatibility: additive nullable columns and optional API fields must preserve
  existing clients.

## User Experience Walkthrough

1. The operator opens New Issue.
2. The operator chooses assignee, project, and optionally `Reviewer`.
3. `Reviewer` defaults to `No reviewer`.
4. The operator may choose:
   - the current board user
   - another eligible organization user, if user listing is available
   - an active organization agent
5. The issue is created. No reviewer is woken at create time.
6. The assignee works the issue normally.
7. When work is ready, the assignee or board moves the issue to `in_review` and
   leaves the relevant output signal: comment, document, work product, PR, or
   preview.
8. If the reviewer is a human user:
   - the issue appears in reviewer issue filters
   - Inbox or Messenger issue attention treats the issue as relevant to that
     user
   - the reviewer opens the issue, reads the output, and comments, requests
     changes, or marks the issue done
9. If the reviewer is an agent:
   - Rudder queues an `issue_review_requested` wakeup
   - the wakeup context says the agent is reviewing, not implementing
   - the agent reviews output, comments with feedback, requests changes by
     moving the issue back to `in_progress`, or marks it `done`
10. If the reviewer changes while the issue is already `in_review`, the new
    reviewer receives attention. The old reviewer no longer matches reviewer
    filters for that issue.

## Implementation

### Product Or Technical Architecture Changes

The source of truth is the `issues` row. Reviewer fields are issue-level routing
metadata, not separate approval or review-request objects.

Add nullable DB columns:

```ts
reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
reviewerUserId: text("reviewer_user_id"),
```

Add indexes:

```ts
reviewerAgentStatusIdx: index("issues_company_reviewer_agent_status_idx").on(
  table.orgId,
  table.reviewerAgentId,
  table.status,
),

reviewerUserStatusIdx: index("issues_company_reviewer_user_status_idx").on(
  table.orgId,
  table.reviewerUserId,
  table.status,
),
```

Extend shared validators:

```ts
reviewerAgentId: z.string().uuid().optional().nullable(),
reviewerUserId: z.string().optional().nullable(),
```

Extend shared issue types:

```ts
reviewerAgentId: string | null;
reviewerUserId: string | null;
```

Extend issue filters:

```ts
reviewerAgentId?: string;
reviewerUserId?: string;
```

Review routing triggers:

- Status changed from any non-`in_review` value to `in_review`.
- Reviewer changed while current issue status is already `in_review`.

Review routing does not trigger:

- issue create
- reviewer change while issue is not `in_review`
- repeated patches that leave status and reviewer unchanged
- self-authored comments alone

### Breaking Change

No breaking change is expected.

This is an additive nullable schema change. Existing issues receive
`reviewer_agent_id = null` and `reviewer_user_id = null`. Existing clients do
not need to send reviewer fields.

### Design

#### Reviewer Semantics

Reviewer means:

- responsible for checking output when the issue is ready for review
- allowed to leave feedback through comments
- allowed to request changes through the existing issue status model
- allowed to mark done when review passes, if the actor otherwise has issue
  update permission

Reviewer does not mean:

- execution assignee
- approval gate owner
- required compliance approver
- automatic blocker for completion

`Assignee` owns execution. `Reviewer` owns checking. `Approver` remains a
governance concept and is not introduced here.

#### API And Service Validation

In `issueService.create`:

- reject both reviewer fields at once
- validate reviewer agent organization and status
- validate reviewer user active organization membership
- insert reviewer fields

In `issueService.update`:

- compute next reviewer state from patch plus existing row
- reject both reviewer fields at once
- allow clearing reviewer with explicit `null`
- preserve current reviewer when fields are omitted
- validate changed reviewer principals

Reviewer validation should reuse or factor the existing assignee validation
shape, but error messages should say `Reviewer`, not `Assignee`.

#### Permissions

Board context may set reviewer when creating or updating an issue if the board
actor has normal task assignment/routing permission.

Agent context may set or change reviewer only when it can assign or route tasks
under the existing permission model. Moving an issue to `in_review` should not
require assignment permission if the reviewer is already set and the actor can
update the issue.

For V1, avoid introducing a new permission key unless implementation reveals
that `tasks:assign` is too broad. Reviewer routing is assignment-like because it
can wake agents and route human attention.

#### Agent Reviewer Wakeup

Reviewer wakeups must be semantically distinct from assignee wakeups.

Recommended wakeup properties:

```ts
{
  source: "review",
  triggerDetail: "system",
  reason: "issue_review_requested",
  payload: {
    issueId,
    mutation: "status_to_in_review" | "reviewer_changed_in_review"
  },
  contextSnapshot: {
    issueId,
    source: "issue.review_request",
    wakeSource: "review",
    wakeReason: "issue_review_requested",
    role: "reviewer",
    issue: {
      id,
      identifier,
      title,
      description,
      status,
      priority
    },
    reviewInstructions:
      "You are the reviewer for this issue. Review the result and leave feedback, request changes, or mark the issue done. Do not take over implementation unless explicitly asked."
  }
}
```

If the existing heartbeat wakeup source type cannot accept `review`, extend the
type. Do not reuse `issue_assigned` for reviewer wakeups.

Idempotency rule:

- one wakeup per reviewer agent per qualifying transition or reviewer change
- no wakeup for repeated identical `PATCH` calls
- no wakeup when the reviewer agent is the actor currently making the update

#### Human Reviewer Attention

Human reviewer support is part of the V1 acceptance bar, not a deferred
"future once wired" behavior.

At minimum:

- `GET /api/orgs/:orgId/issues?reviewerUserId=me` works for board actors
- `touchedByUserCondition` treats `reviewerUserId` as user-relevant
- `deriveIssueUserContext` includes reviewer user touch state
- Messenger issue universe includes reviewer user issues
- Inbox can surface reviewer issues through the same issue attention pipeline

If a dedicated "Review requested" category is too large for this iteration,
reuse the current issue attention row, but ensure the issue is retrievable and
visible for the reviewer.

#### UI

New Issue dialog:

- add `Reviewer` near the existing assignee/project metadata controls
- default to `No reviewer`
- use the same interaction style as assignee where practical
- options include `No reviewer`, eligible users, and active agents
- do not allow both user and agent reviewer fields at the same time

Issue Properties:

- add `Reviewer` near `Assignee`
- show selected reviewer
- support changing reviewer
- support clearing reviewer
- show `No reviewer` when empty

If `reviewerAgentId` equals `assigneeAgentId` or `reviewerUserId` equals
`assigneeUserId`, allow it for V1 but show a lightweight warning in UI when
space allows. Do not block this in the API.

Issue List / Board:

- do not add reviewer to default dense issue rows in this iteration
- add reviewer later through optional display properties if needed

### Security

This proposal adds no external dependencies and no remote API calls.

It extends existing issue endpoints:

- `POST /api/orgs/:orgId/issues`
- `PATCH /api/issues/:id`
- `GET /api/orgs/:orgId/issues`
- `GET /api/issues/:id`

Security requirements:

- board and agent actors must pass existing organization access checks
- reviewer agents must belong to the same organization
- reviewer users must be active members of the same organization
- agent reviewer wakeups must not be created for agents outside the issue
  organization
- activity log details must not include sensitive payloads beyond principal ids

## What Is Your Testing Plan (QA)?

### Goal

Prove that reviewer routing is persisted, visible, organization-scoped, and
attention-producing when an issue enters review.

### Prerequisites

- Embedded PostgreSQL dev/test environment.
- One organization with:
  - at least one active assignee agent
  - at least one active reviewer agent
  - a board user or local implicit user
- Existing issue create and update test fixtures.

### Test Scenarios / Cases

DB/service tests:

- create issue with `reviewerAgentId`
- create issue with `reviewerUserId`
- reject both reviewer fields at once
- reject reviewer agent from another organization
- reject reviewer user without active organization membership
- clear reviewer on update
- preserve reviewer when update omits reviewer fields
- change reviewer while status remains `in_review`

Route tests:

- `POST /api/orgs/:orgId/issues` persists reviewer
- `PATCH /api/issues/:id` updates reviewer
- `GET /api/orgs/:orgId/issues?reviewerUserId=me` resolves current board user
- `GET /api/orgs/:orgId/issues?reviewerAgentId=...` filters reviewer agent
  issues
- `issue.updated` activity includes `_previous` reviewer fields when reviewer
  changes
- entering `in_review` with reviewer agent enqueues `issue_review_requested`
- repeated identical patch does not enqueue duplicate reviewer wakeups

UI component tests:

- New Issue dialog defaults to `No reviewer`
- selecting reviewer sends the correct request payload
- clearing reviewer sends `null`
- Issue Properties displays reviewer
- Issue Properties can change and clear reviewer

E2E tests:

- create an issue from the UI
- select a reviewer
- submit
- open issue detail
- verify reviewer is shown in properties
- change reviewer from issue detail
- clear reviewer from issue detail

Optional E2E if the wakeup harness is available:

- create issue with reviewer agent
- move issue to `in_review`
- verify reviewer agent receives `issue_review_requested`

### Expected Results

- Reviewer fields are persisted and returned by API responses.
- Invalid reviewer states fail with 422.
- Organization boundary violations fail.
- Human reviewer issues are visible through reviewer filters and attention
  surfaces.
- Agent reviewer wakeup context clearly identifies the agent as reviewer.
- Existing assignee assignment and wakeup behavior does not regress.

### Pass / Fail

Verification will be filled during implementation.

## Documentation Changes

Update these docs if the proposal lands:

- `doc/SPEC-implementation.md`: add reviewer fields to the V1 issue model and
  define lightweight review routing semantics.
- `doc/TASKS.md`: clarify assignee, reviewer, and `in_review` status behavior.
- `doc/README.md`: update navigation only if task/review docs become a common
  contributor route.
- `doc/DESIGN.md`: add reviewer property placement guidance only if the UI
  pattern differs from existing issue properties.

## Open Issues

1. Should the new heartbeat wakeup source be `review`, or should it reuse an
   existing source with distinct `reason: "issue_review_requested"`?
   Recommendation: add `review` if the type change is small; otherwise keep the
   distinct reason and context snapshot mandatory.

2. Should reviewer be allowed to equal assignee?
   Recommendation: allow in the API for V1, warn in UI later if this becomes
   confusing.

3. Do we need a separate `review_requests` table?
   Recommendation: no for V1. Add it only if we need multiple review attempts,
   explicit review SLA, separate review assignment history, or parallel
   reviewers.

4. Should review outcome be modeled explicitly?
   Recommendation: no for this proposal. Use existing comments and status
   transitions first. Introduce explicit review outcome only when the product
   needs analytics or stronger workflow gates.

5. How broad should user picker support be in local trusted mode?
   Recommendation: support current user immediately, and support broader
   organization users only if the member list API is already reliable enough for
   the dialog.
