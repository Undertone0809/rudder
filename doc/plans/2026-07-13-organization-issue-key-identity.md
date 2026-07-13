---
title: Separate Organization Routes From Issue Keys
date: 2026-07-13
kind: implementation
status: completed
area: data_model
entities:
  - organization_identity
  - issue_identity
issue:
related_plans:
  - 2026-04-07-skill-reference-cleanup.md
supersedes: []
related_code:
  - packages/db/src/schema/organizations.ts
  - packages/shared/src/validators/organization.ts
  - server/src/services/orgs.ts
  - server/src/services/issues.ts
  - ui/src/components/OrganizationSwitcher.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/lib/organization-routes.ts
  - tests/e2e/onboarding.spec.ts
commit_refs: []
updated_at: 2026-07-14
---

# Separate Organization Routes From Issue Keys

## Summary

Make organization identity legible by separating the stable organization URL
key from the operator-facing issue key. New issue keys preserve digits, are
visible and editable during organization creation, and fail explicitly on
conflict instead of silently growing repeated `A` suffixes. Existing
organizations can migrate their issue key without breaking old issue or
organization links.

## Problem

The current `issuePrefix` generator removes digits and resolves collisions by
appending an unbounded sequence of `A` characters. Names such as `R1` through
`R6` therefore become `R`, `RA`, `RAA`, and so on. The same field is also used
as the canonical organization URL segment, which couples issue identity to
navigation and makes correction risky after issues exist.

## Scope

- Preserve ASCII letters and digits when deriving a default issue key.
- Expose an editable issue key in organization creation and settings.
- Reject issue-key conflicts with an actionable API/UI error.
- Use immutable `organization.urlKey` as the canonical organization route key.
- Persist historical issue-prefix aliases and resolve old organization and
  issue links after a key migration.
- Update existing issue identifiers transactionally when their organization
  issue key changes, while preserving issue numbers.
- Update Product Logic Registry contracts and automated E2E coverage.
- Do not automatically rename existing organizations or choose a replacement
  issue key without an operator action.

## Implementation Plan

1. Add a prefix-alias table and export it through the database schema.
2. Add shared issue-key derivation/validation and organization contract fields.
3. Refactor organization creation and update around explicit unique issue keys,
   stable URL keys, transactional issue renumbering, and alias persistence.
4. Resolve historical organization prefixes and issue identifiers through the
   alias table.
5. Update organization routing helpers and link generation to prefer `urlKey`.
6. Add issue-key controls and conflict errors to creation/onboarding/settings.
7. Add service, route, UI, and E2E regression coverage for numeric names,
   conflicts, migration, aliases, and stable routes.
8. Synchronize `ORG.SETTINGS.001`, `ORG.ONBOARDING.001`, and issue identity
   contracts in `doc/product/**` and run the registry checker.

## Design Notes

- The issue key grammar is uppercase ASCII alphanumeric, begins with a letter,
  and is bounded in length. Existing legacy prefixes remain readable even when
  they exceed the new creation bound.
- Prefix aliases are instance-global, matching the existing global uniqueness
  of current issue prefixes and issue identifiers.
- A migration preserves issue numbers and records the prior prefix before
  updating current identifiers. Repeated migrations retain every prior alias.
- Canonical navigation uses `urlKey`; legacy `issuePrefix` and alias routes are
  accepted and redirected without changing the organization record.
- Organization display-name changes do not mutate either stable identity key.

## Success Criteria

- Creating `R6` defaults to issue key `R6` and its first issue is `R6-1`.
- A conflicting requested key is rejected with a clear correction path and no
  repeated-`A` allocation.
- Operators can choose a different valid key before creation and migrate an
  existing organization key from settings.
- After migration, old organization and issue links still resolve while new
  surfaces display the new key.
- Organization URLs use stable `urlKey` values and do not change with issue-key
  migration.
- Product contracts, DB/shared/server/UI layers, and automated coverage agree.

## Validation

- Focused shared/server/UI tests for derivation, conflicts, migration, aliases,
  and route canonicalization.
- E2E organization creation and settings migration, including an old-link
  regression check.
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- Relevant `pnpm test:e2e` path and rendered browser screenshots.
- Spawned black-box verifier followed by functional, adversarial, and heuristic
  final reviewers.

## Portability Decision

- A new-organization import creates fresh route and issue identity. The import
  surface exposes an independent Issue Key override, conflicts stay explicit,
  and source historical aliases are not copied.
- External references that display old identifiers remain valid aliases but
  cannot be rewritten outside Rudder.
