---
title: Issues Domain
domain: issues
status: active
coverage: seed
contract_ids: []
related_code:
  - server/src/services/issues.ts
  - server/src/services/issues.helpers.ts
  - server/src/routes/issues.mutations.ts
related_tests:
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
edit_policy: user_confirmed_only
---

# Issues Domain

## Owns

- Issue identity and hierarchy.
- Issue status lifecycle.
- Issue archive, restore, permanent-delete eligibility, and hierarchy ordering;
  shared retention/tombstone semantics remain in control-plane.
- Issue-local workflows such as create, update, reopen, checkout entry, and
  issue-visible close-out state.
- Issue-visible slots for comments, runs, reviewers, activity, and artifacts.

## Does Not Own

- Agent run or heartbeat execution semantics. See `RUN.*`.
- Assignee, reviewer, checkout, and wake eligibility rules. See `ROUTING.*`.
- Comment, Messenger, and thread semantics. Those belong to collaboration.
- Activity log audit semantics. Those belong to control-plane.
- Resource and Library eligibility. Those belong to library-and-context.

## Contract Index

- `ISSUE.IDENTITY.001`: readable issue identifiers use an explicit organization
  Issue Key while UUIDs and historical aliases preserve durable identity.
- `ISSUE.STATE.001`: issue status lifecycle remains explicit and review-aware.
  Archive remains a separate reversible visibility marker and permanent delete
  follows `CONTROL.ENTITY.RETENTION.001`.
- `ISSUE.HIERARCHY.001`: parent and sub-issue relationships preserve work
  context without crossing organization or cycle boundaries.
- `ISSUE.COMMENTS.001`: comments preserve local collaboration evidence before
  routing decides wake eligibility.
- `ISSUE.WORKFLOW.001`: issue mutations preserve activity, comments, and wake
  integration.
- `ISSUE.SURFACE.001`: issue surfaces expose state and linked evidence without
  reauthoring cross-domain rules.
- `ISSUE.DESCRIPTION.001`: issue descriptions remain one continuously editable
  Library-style Markdown surface with document Enter behavior and image preview.

## Cross-Domain Integrations

- `ROUTING.ASSIGNMENT.001` wakes assignees when issue assignment becomes
  actionable.
- `ROUTING.REVIEWER.001` wakes reviewers when issue state enters review.
- `RUN.ADMISSION.001` locks issue-backed execution and releases/promotes queued
  wakes after a run finishes.
- `CONTROL.ENTITY.RETENTION.001` owns the shared tombstone, deleted-lookup, and
  durable physical-cleanup contract for archived Issues and Chats.
