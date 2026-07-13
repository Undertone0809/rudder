---
title: Issue Identity
domain: issues
status: active
coverage: detailed
contract_ids:
  - ISSUE.IDENTITY.001
related_code:
  - packages/db/src/schema/issues.ts
  - packages/db/src/schema/organization_issue_prefix_aliases.ts
  - server/src/services/issues.ts
  - server/src/services/orgs.ts
related_tests:
  - packages/shared/src/organization-issue-key.test.ts
  - server/src/__tests__/orgs-service.test.ts
  - tests/e2e/organization-issue-key.spec.ts
edit_policy: user_confirmed_only
---

# Issue Identity

## ISSUE.IDENTITY.001

Behavior:

- Every locally numbered issue has an organization-scoped `issueNumber` and a
  human-readable identifier formed as `{currentIssueKey}-{issueNumber}`.
- The organization Issue Key begins with an ASCII letter, contains only
  uppercase ASCII letters and digits, and is unique across current and
  historical organization keys in one Rudder instance.
- Changing an organization's Issue Key updates its current issue identifiers
  transactionally without changing issue UUIDs or issue numbers.
- Every prior Issue Key remains a historical alias. Looking up an old
  `{historicalIssueKey}-{issueNumber}` resolves the same issue as its current
  identifier.

Invariant:

- Issue UUID is the durable internal identity. A readable identifier may
  change only through the explicit organization Issue Key migration workflow.
- Historical identifiers must remain resolvable after one or multiple key
  migrations, including when an organization changes back to an earlier key.
- A current or historical Issue Key owned by another organization must not be
  reassigned silently.
- A current or historical Issue Key must not collide case-insensitively with
  another organization's canonical URL key.

Rationale:

- Operators need short, meaningful issue references, but links, run evidence,
  and external references must survive a correction to the organization key.
- Preserving issue numbers and aliasing old prefixes provides readable current
  identifiers without treating display text as the immutable database key.

Related code:

- `packages/db/src/schema/issues.ts`
- `packages/db/src/schema/organization_issue_prefix_aliases.ts`
- `server/src/services/issues.ts`
- `server/src/services/orgs.ts`

Related tests:

- `packages/shared/src/organization-issue-key.test.ts`
- `server/src/__tests__/orgs-service.test.ts`
- `tests/e2e/organization-issue-key.spec.ts`
