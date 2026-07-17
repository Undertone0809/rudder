---
title: Issue State Machines
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.STATE.001
related_code:
  - packages/db/src/schema/issues.ts
  - server/src/services/issues.helpers.ts
  - server/src/services/issues.ts
  - server/src/routes/issues.mutations.ts
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/OrganizationSettings.tsx
related_tests:
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - server/src/__tests__/issues-service.test.ts
  - tests/e2e/issue-detail-done-project-edit.spec.ts
  - tests/e2e/organization-settings-archived-issues.spec.ts
edit_policy: user_confirmed_only
---

# Issue State Machines

## ISSUE.STATE.001

Behavior:

- Issue status is the durable work-state signal for the board and agents.
- `archivedAt` is a separate reversible visibility marker, not another work
  status. Archive preserves the last work status while removing the Issue from
  normal boards, search, Messenger, agent context, and run admission.
- Reviewable states are `in_review` and `blocked`.
- Reviewer decisions require a comment and are allowed only while the issue is
  `in_review` or `blocked`.
- When an assignee agent tries to complete an issue that has a reviewer, Rudder
  normalizes the status to `in_review` unless the acting agent is the reviewer
  recording an accepted decision.
- Closed issues can be reopened by a comment with explicit reopen intent.
- Board operators archive inactive leaf Issues from Issue Detail and restore or
  permanently delete them from Organization Settings. Permanent delete is
  allowed only after archive and follows `CONTROL.ENTITY.RETENTION.001`.

Invariant:

- An agent cannot silently bypass reviewer ownership by marking a reviewed issue
  `done`.
- Review decisions are structured outcomes, not only free-form comments.
- Status changes that materially affect the issue must leave activity evidence.
- A parent cannot be archived while an unarchived child remains. A child cannot
  be restored while its parent remains archived, and a parent cannot be
  permanently deleted while any child remains.
- Archive and delete must reject active Issue work, queued/running wakes, and
  pending terminal effects.

Rationale:

- Issue state is the operator-facing contract for where work is in the Rudder
  loop. Reviewer gates must remain visible and durable.
- Keeping archive separate from status lets an operator temporarily remove a
  finished or inactive Issue without falsifying its last execution state.

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issues.helpers.ts`
- `server/src/services/issues.ts`

Related tests:

- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `server/src/__tests__/issues-service.test.ts`
- `tests/e2e/issue-detail-done-project-edit.spec.ts`
- `tests/e2e/organization-settings-archived-issues.spec.ts`
