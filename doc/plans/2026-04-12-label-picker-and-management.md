## Goal

Refactor issue label UX so the issue detail popover is a search-first picker, while organization-level label management lives in Organization Settings.

## Problem

- The issue detail label popover currently mixes selection, creation, deletion, and color picking in one compact surface.
- This violates Rudder's progressive-disclosure and operator-density expectations.
- Destructive organization-level actions like label deletion should not live inside an issue-scoped picker.
- The current create affordance is visually overweight and does not follow the expected search-result creation model.

## Scope

1. Move organization label deletion and management into Organization Settings.
2. Add organization label create/edit/delete UI in Organization Settings.
3. Convert issue label picker to:
   - search existing labels
   - toggle existing labels
   - show an inline "Create label \"…\"" result only when the query has no exact match
   - remove the always-visible create form and delete controls
4. Reduce the create affordance visual weight in the issue picker.
5. Add or update automated E2E coverage for the new label flows.

## Implementation Plan

### Contracts and API

- Add an update-label schema in `packages/shared/src/validators/issue.ts`.
- Export the new schema/type through shared index barrels.
- Add `issues.updateLabel(...)` service support in `server/src/services/issues.ts`.
- Add `PATCH /api/labels/:labelId` in `server/src/routes/issues.ts` with activity logging.
- Add `issuesApi.updateLabel(...)` in `ui/src/api/issues.ts`.

### Issue Picker UX

- Refactor `ui/src/components/IssueProperties.tsx` label popover to use a filtered result list plus a conditional create row.
- Remove inline delete buttons from the picker.
- Remove the bottom create form and oversized color control from the picker.
- Use a smaller, lighter create-row icon and compact row styling.
- Create labels directly from the typed query with a deterministic default color.

### Organization Settings UX

- Add a new "Labels" section to `ui/src/pages/OrganizationSettings.tsx`.
- Fetch labels with the existing labels query.
- Add create, update, and delete mutations.
- Render a compact management list with:
  - color swatch
  - editable name
  - editable color
  - delete action
- Keep create controls in settings, not in issue detail.

### Verification

- Update `tests/e2e/issue-detail-toolbar-actions.spec.ts` to cover:
  - seeded labels still visible
  - inline create result appears from search
  - delete controls are not shown in the issue picker
- Add or update E2E coverage for Organization Settings label management.
- Run:
  - `pnpm -r typecheck`
  - `pnpm build`
  - relevant Playwright E2E specs

## Notes

- This is a boundary correction, not a cosmetic tweak.
- Issue detail should remain a consumption surface.
- Organization Settings should become the governance surface for labels.

## Outcome

- Added label update contract support across shared, server routes, and UI API client.
- Refactored the issue detail label picker into a search-first picker with inline create results.
- Removed delete controls and the always-visible create form from the issue detail picker.
- Added a Labels management section to Organization Settings for create, rename, recolor, and delete.
- Added E2E coverage for:
  - inline label creation from the issue picker
  - label management from Organization Settings

## Verification

- `pnpm -r typecheck`
- `pnpm --filter @rudder/server build`
- `pnpm --filter @rudder/ui build`
- `RUDDER_E2E_USE_EXISTING_SERVER=1 RUDDER_E2E_BASE_URL=http://127.0.0.1:3100 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-detail-toolbar-actions.spec.ts`
- `RUDDER_E2E_USE_EXISTING_SERVER=1 RUDDER_E2E_BASE_URL=http://127.0.0.1:3100 npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/settings-sidebar.spec.ts --grep "manages issue labels from organization settings"`
- `pnpm build` was attempted twice but failed in the existing desktop packaged staging step under `desktop/.packaged/server-package` with filesystem cleanup/copy errors unrelated to the label changes.

## Commit Record

- Pending commit
