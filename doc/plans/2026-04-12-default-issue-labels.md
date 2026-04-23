# Default Issue Labels For New Organizations

## Summary

Add a minimal built-in issue label set for newly created organizations so the issue detail label picker is not empty out of the box. The default set will be `Bug`, `Feature`, and `UI`. Existing organizations will not be backfilled.

## Implementation Changes

- Seed default labels during organization creation in `server/src/services/orgs.ts`, not in the UI.
- Wrap org creation plus default-label insert in one transaction.
- Add a small server-side constant/helper for the default label templates:
  - `Bug` with a red tone
  - `Feature` with a purple tone
  - `UI` with a cyan/blue tone
- Do not change the existing label API shape or routes.
- Do not auto-log separate `label.created` activity entries for bootstrap labels.
- Do not add lazy seeding or backfill logic.

## Public APIs / Types

- No schema migration.
- No REST contract changes.
- No shared type or validator changes unless a small shared constant is introduced purely for internal reuse; if added, keep it non-breaking and not required by clients.

## Test Plan

- Add or update server tests for organization creation so a newly created org gets exactly three labels with the expected names and colors.
- Add a negative server test so a pre-existing org with no labels is not auto-populated by unrelated reads.
- Add or update Playwright E2E coverage on the issue detail flow:
  - create a new org
  - open an issue detail page
  - open the labels picker
  - assert the picker shows `Bug`, `Feature`, and `UI` without manual label creation
- Run targeted verification:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm test:e2e --grep "issue detail|label"`
  - `pnpm build`

## Assumptions And Defaults

- Rollout scope is new organizations only.
- Default set is exactly `Bug`, `Feature`, `UI`.
- Display order will follow the current API ordering by label name, so the picker will naturally show `Bug`, `Feature`, `UI`.
- Colors follow the intended visual direction: red for `Bug`, purple for `Feature`, cyan/blue for `UI`.
