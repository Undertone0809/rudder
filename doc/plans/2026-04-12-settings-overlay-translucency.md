# Settings Overlay Translucency Fix

## Summary

The current desktop settings presentation uses a translucent macOS window and a centered settings shell, but it does not preserve the active workspace behind the settings layer. As a result, the blur reads against the desktop wallpaper or system window background instead of the previous in-app page. The product goal for this change is to make desktop settings feel like a frosted overlay on top of the current Rudder workspace, not a separate scene floating over the desktop.

## Diagnosis

- Primary layer: interaction design
- Secondary layer: visual design

The wrong thing is not "too much transparency." The wrong thing is the background source. We need in-app contextual translucency, not window-level desktop transparency.

## Implementation Plan

- Preserve the current workspace route as the modal background when desktop settings open from inside the app.
  - Keep the settings URLs unchanged so remembered settings paths, direct links, and access logic continue to work.
  - Introduce a background-location pattern so desktop settings can render as an overlay without replacing the active board surface.
- Update the desktop layout so the settings modal sits above the underlying workspace shell.
  - The background layer should remain visible but inert while settings are open.
  - Closing the modal should return the user to the previous workspace path.
  - Direct navigation to a settings URL without an in-app background should still work safely and predictably.
- Tighten the modal material treatment.
  - The backdrop should dim and blur the underlying Rudder content.
  - The shell should remain mostly opaque and readable.
  - The result should preserve hints of the previous page layout without exposing readable content or the desktop wallpaper as the primary visual background.
- Add E2E protection for the behavior.
  - Opening settings from a workspace route should keep the workspace shell mounted behind the modal.
  - Closing by outside click should return to the originating workspace route.
  - Direct navigation to settings should still render a usable centered modal shell.

## Files Likely To Change

- `ui/src/components/Layout.tsx`
- `ui/src/components/PrimaryRail.tsx`
- `ui/src/components/CompanySwitcher.tsx`
- `ui/src/components/SettingsSidebar.tsx`
- `ui/src/lib/router.tsx` or a nearby route-state helper
- `ui/src/index.css`
- `tests/e2e/settings-sidebar.spec.ts`
- `tests/e2e/workspace-shell.spec.ts`

## Test Plan

- E2E:
  - Open a desktop workspace route, launch system settings, and verify the settings modal is visible while the workspace shell remains mounted behind it.
  - Verify closing the modal by clicking outside returns to the prior workspace route.
  - Verify direct navigation to `/instance/settings/general` still renders the compact modal shell without crashing.
- Visual verification:
  - Capture a screenshot showing the settings shell with the previous in-app page softly visible behind it.
  - Confirm the desktop wallpaper is not the dominant visible background cue.
- Validation:
  - `pnpm -r typecheck`
  - targeted `pnpm test:e2e --grep "Settings sidebar|desktop settings"`
  - `pnpm test:run`
  - `pnpm build`
  - `pnpm desktop:verify` if the desktop packaging/runtime path is materially affected

## Assumptions

- The current settings URLs remain canonical.
- The "previous page" requirement applies to settings opened from within the desktop workspace flow, not necessarily to cold-open direct links.
- This work can be implemented without changing server contracts or data models.
