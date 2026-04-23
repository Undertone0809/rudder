# Settings Overlay Org Context Split

Date: 2026-04-12
Status: Planned

## Summary

Split the organization being viewed inside the settings overlay from the globally selected workspace organization.

This change is limited to the settings overlay flow. The rest of the app continues to use the existing `selectedOrganization` model for workspace context.

## Product Intent

- `selectedOrganization` remains the global workspace organization.
- `/:orgPrefix/organization/settings` becomes a route-scoped "view and edit this org's settings" context.
- `CompanySwitcher` remains the global organization switcher.
- The organization list inside the settings sidebar becomes a viewer/navigation control only. Clicking another org in settings must not switch the global organization.

## Implementation

### Route-scoped viewed organization

- Add a shared helper and hook that resolve `orgPrefix + organizations` into:
  - `viewedOrganization`
  - `viewedOrganizationId`
- Reuse that logic in both the settings overlay layout and `CompanySettings`.
- Add a small unit test that covers:
  - normal prefix resolution
  - case-insensitive matching
  - invalid prefix fallback behavior

### Settings sidebar behavior

- Remove `setSelectedOrganizationId(...)` from the settings sidebar org click handler.
- Keep the existing overlay background state when navigating between org settings pages.
- Highlight the org list based on the current route org prefix, not `selectedOrganization`.
- Do not add dual-highlighting or current-org badges in this iteration.

### Settings overlay behavior

- Remove route-to-global sync from `DesktopSettingsOverlayLayout`.
- The overlay must no longer write into global organization selection state.
- If the overlay route contains an unknown or inaccessible org prefix:
  - prefer redirecting to the currently selected org's settings route
  - if no valid selected org exists, close the overlay back to the stored background path
- Do not render an empty shell for an invalid route org.

### Company settings data source

- Update `CompanySettings` to use `viewedOrganization` / `viewedOrganizationId` for:
  - form initialization
  - dirty checks
  - breadcrumbs
  - queries
  - mutations
  - archive logic
- Preserve current behavior for `/organization/settings` by allowing the existing unprefixed redirect to land on the selected org before the page renders.
- Keep editing enabled for non-selected orgs viewed in the overlay.

### Navigation inside company settings

- Replace hardcoded organization-relative links with router-aware navigation so they stay pinned to the viewed org:
  - `/org`
  - `/organization/export`
  - `/organization/import`
- Use the existing router wrappers (`Link`, `navigate`) so org prefixes are preserved from the current route.

### Archive behavior

- When archiving the currently viewed org:
  - if it is also the global selected org, keep the existing fallback behavior and select the next available org
  - if it is not the global selected org, do not change the global selected org
- After archiving a non-selected viewed org:
  - navigate to the selected org's settings if one still exists
  - otherwise close the overlay to the stored background path

## Tests

- Update `tests/e2e/settings-sidebar.spec.ts`:
  - clicking org B inside settings must change the URL to `/${B}/organization/settings`
  - the modal must stay open
  - the rendered settings fields must show org B data
  - `localStorage.rudder.selectedOrganizationId` must remain org A
- Add an e2e save scenario:
  - open settings from org A
  - navigate to org B settings
  - save a visible change
  - verify org B updates successfully
  - verify the selected org in local storage is still org A
- Add an e2e close scenario:
  - navigate from org A settings to org B settings
  - close the overlay
  - verify the app returns to org A's original background route without a blank screen

## Non-Goals

- No broader refactor of route-prefixed board pages outside the settings overlay
- No redesign of `CompanySwitcher`
- No changes to server, database, or shared contracts
