---
title: Issue Reviewer Selection
date: 2026-04-30
kind: proposal
status: proposed
area: ui
entities:
  - issue_reviewer
  - issue_create_dialog
  - review_routing
issue:
related_plans: []
supersedes: []
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/validators/issue.ts
  - packages/shared/src/types/issue.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.ts
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/IssueProperties.tsx
commit_refs: []
updated_at: 2026-04-30
---

# Issue Reviewer Selection

## Problem

Issue creation currently supports ownership through an assignee, but it does not let the operator specify who should review the result when the work is ready. This makes review ownership implicit. The operator has to remember who should review the issue, mention them later, or rely on the assignee to route the review manually.

Rudder should make review ownership explicit at issue creation time.

The desired user experience is:

- while creating an issue, the operator can choose `Reviewer`
- the default state is `No reviewer`
- the reviewer is saved on the issue
- the issue detail surface shows and allows editing the reviewer
- when the issue reaches review state, Rudder can route attention to the reviewer

This should remain lightweight. Reviewer selection should not turn issues into a heavyweight approval workflow.

## Goals

1. Add a first-class optional reviewer field to issues.
2. Allow reviewer selection during issue creation.
3. Allow reviewer editing from the issue properties panel.
4. Support both human users and agents as reviewers, matching the existing assignee model.
5. Keep the existing single-assignee invariant unchanged.
6. Add organization-scoped validation so reviewers cannot be selected across organization boundaries.
7. Add activity logging for reviewer changes.
8. Add E2E coverage for creating an issue with a reviewer.

## Non-goals

1. Do not implement multiple reviewers in this version.
2. Do not implement a separate approval workflow.
3. Do not merge `Reviewer` with `Approver`.
4. Do not require every issue to have a reviewer.
5. Do not block issue completion solely because a reviewer is missing.
6. Do not add external GitHub/GitLab reviewer sync in this version.

## Product Semantics

An issue reviewer is the person or agent responsible for checking the output when the issue is ready for review.

Reviewer is different from assignee:

- `Assignee` owns execution.
- `Reviewer` owns review.
- `Approver` remains a separate governance concept and should not be introduced as part of this change.

For V1, reviewer selection is a routing and visibility field. The existing issue status model remains unchanged. When work is ready, the issue can move to `in_review`; the reviewer can then comment, request changes by moving the issue back to `todo` or `in_progress`, or mark the issue `done`.

## Data Model

Add two nullable columns to `issues`:

```ts
reviewerAgentId: uuid("reviewer_agent_id").references(() => agents.id),
reviewerUserId: text("reviewer_user_id"),
Add indexes:

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

Validation rules:

an issue may have no reviewer
an issue may have one reviewer agent
an issue may have one reviewer user
an issue must not have both reviewerAgentId and reviewerUserId
reviewer agent must belong to the same organization
reviewer user must be a member of the same organization

This mirrors the existing assignee shape while keeping reviewer independent from assignee.

API Contract

Extend createIssueSchema and updateIssueSchema with:

reviewerAgentId: z.string().uuid().optional().nullable(),
reviewerUserId: z.string().optional().nullable(),

Extend shared issue types with:

reviewerAgentId: string | null;
reviewerUserId: string | null;

Extend issue filters with:

reviewerAgentId?: string;
reviewerUserId?: string;

Routes impacted:

POST /api/orgs/:orgId/issues
PATCH /api/issues/:id
GET /api/orgs/:orgId/issues
GET /api/issues/:id

Create and update should reject invalid reviewer combinations with 422.

Server Behavior

In issueService.create:

validate reviewer exclusivity
validate reviewer agent or user membership
insert reviewer fields with the issue

In issueService.update:

validate the next reviewer state
allow clearing reviewer with null
include reviewer fields in update patch
preserve current reviewer when fields are omitted

In routes:

reviewer changes should be treated as mutating issue updates
write an activity log entry through the existing issue.updated path
include _previous details when reviewer fields change

Suggested activity detail shape:

{
  "reviewerAgentId": "new-agent-id-or-null",
  "reviewerUserId": "new-user-id-or-null",
  "_previous": {
    "reviewerAgentId": "old-agent-id-or-null",
    "reviewerUserId": "old-user-id-or-null"
  }
}
Review Routing Behavior

This proposal should introduce reviewer storage and UI first. Routing can be minimal but should leave the right seams.

V1 routing behavior:

If an issue is created with a reviewer, no agent wakeup is required immediately.
If an issue transitions into in_review and has reviewerAgentId, enqueue a wakeup for that reviewer agent with reason issue_review_requested.
If an issue transitions into in_review and has reviewerUserId, the issue should appear in review-oriented user surfaces such as Inbox or My Work once those filters are wired.

Wakeup context for reviewer agents should make the role clear:

You are the reviewer for this issue. Review the result and leave feedback, request changes, or mark the issue done. Do not take over implementation unless explicitly asked.

This avoids confusing reviewer agents with assignee agents.

UI
New Issue Dialog

Add a Reviewer selector to the issue create dialog.

Placement:

near the existing assignee/project/task metadata controls
visible by default if space allows
otherwise placed under the same progressive disclosure area as other routing metadata

Default value:

No reviewer

Picker options:

No reviewer
current user / eligible organization users
active agents in the current organization

Display rules:

show user display name when available
show agent name and role/title for agents
use the same combobox/select interaction style as assignee
do not allow selecting both user reviewer and agent reviewer

Request payload examples:

{
  "title": "Implement system chores V2",
  "description": "...",
  "assigneeAgentId": "agent-id",
  "reviewerUserId": "user-id"
}
{
  "title": "Implement system chores V2",
  "description": "...",
  "assigneeAgentId": "agent-id",
  "reviewerAgentId": "reviewer-agent-id"
}
Issue Properties Panel

Add a Reviewer property below or near Assignee.

The property should support:

view selected reviewer
change reviewer
clear reviewer
show No reviewer when empty
Issue List / Board

Do not add reviewer to the default dense issue row in this version unless the display settings already support optional properties.

Recommended V1 behavior:

issue detail always shows reviewer
list/board can add reviewer later as an optional display property
Permissions

Board/user context may set reviewer when creating or updating an issue.

Agent context may set reviewer only if it already has permission to update the issue and assignment-like task routing is allowed for that actor. This should follow existing task assignment permission patterns instead of introducing a new permission model.

Organization boundary enforcement is required for both user and agent reviewers.

Migration

This is an additive nullable schema change.

Migration behavior:

existing issues get reviewer_agent_id = null
existing issues get reviewer_user_id = null
no backfill is required
existing create/update clients continue to work because reviewer fields are optional
Testing

Required automated coverage:

DB/service test:
create issue with reviewerAgentId
create issue with reviewerUserId
reject both reviewer fields at once
reject reviewer from another organization
clear reviewer on update
Route test:
POST /api/orgs/:orgId/issues persists reviewer
PATCH /api/issues/:id updates reviewer
activity log contains previous reviewer fields on update
UI component test:
New Issue dialog defaults to No reviewer
selecting reviewer sends the correct request payload
clearing reviewer sends null
E2E test:
create an issue from the UI
select a reviewer
submit
open issue detail
verify reviewer is shown in properties

Optional follow-up E2E:

create issue with reviewer agent
move issue to in_review
verify reviewer agent receives review wakeup
Acceptance Criteria
A user can create an issue with no reviewer.
A user can create an issue with a reviewer.
The reviewer is persisted and returned by the issue API.
The reviewer is visible on the issue detail page.
The reviewer can be changed or cleared after creation.
Invalid reviewer combinations are rejected.
Reviewers are organization-scoped.
Existing issue creation flows continue to work unchanged.
Existing assignee behavior is not changed.
The implementation includes E2E coverage for the new create-flow behavior.
Open Questions
Should reviewer be allowed to equal assignee?
Recommendation: allow for now, but consider a UI warning later. This keeps V1 flexible and avoids over-policing edge cases.
Should reviewer be user-only or user-or-agent?
Recommendation: support both. Rudder is built around agent teams, so review routing should be able to target either a human operator or a reviewer agent.
Should review outcome be modeled explicitly?
Recommendation: not in this proposal. Use existing status and comments first. Add explicit reviewState later only if review workflows become important enough to deserve their own state machine.
Should Approver be added at the same time?
Recommendation: no. Reviewer is a lightweight issue-routing role. Approver belongs to governance and approval gates, and should remain separate.