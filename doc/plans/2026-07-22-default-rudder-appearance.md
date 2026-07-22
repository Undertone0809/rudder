---
title: Default Rudder appearance preset
date: 2026-07-22
kind: implementation
status: completed
area: ui
entities:
  - appearance_settings
  - desktop_shell
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/context/ThemeContext.tsx
  - ui/src/pages/InstanceAppearanceSettings.tsx
  - tests/e2e/settings-appearance.spec.ts
  - doc/product/domains/organizations-and-goals/settings-onboarding-portability.md
commit_refs: []
updated_at: 2026-07-22
---

# Default Rudder Appearance Preset

## Summary

Make the existing `luma` design style, `neutral` base color, and `emerald`
accent the default Rudder appearance for environments without a valid saved
preference. Keep `system` as the default color mode and preserve every valid
existing local preference.

The affected Product Logic contract is `ORG.SETTINGS.001`. The approved plan
explicitly authorizes the corresponding `doc/product/**` delta.

## Implementation Plan

1. Keep the stable appearance IDs and local-storage keys unchanged. Change only
   the missing/invalid accent fallback from `neutral` to `emerald`, synchronized
   between the React theme context and the pre-hydration document script.
2. Present design styles in the order `luma`, `default`, `mira`, labeled
   Rudder, Classic, and Compact. Present `emerald` first in the theme choices
   and label it Rudder in English and Chinese.
3. Update `ORG.SETTINGS.001` with the default presentation, stable-ID/display
   mapping, and preservation of valid stored preferences.
4. Expand focused unit and E2E coverage for clean-profile defaults, invalid
   fallback, option ordering, stable IDs, and reload persistence.
5. Verify the real browser and Desktop surfaces, attach a final screenshot,
   then run the repository-required checks and independent review.

## Compatibility

- No API, database, schema, CSS selector, DOM attribute, or local-storage key
  changes.
- Existing values such as `default`, `mira`, `luma`, `neutral`, and `emerald`
  remain valid and retain their visual behavior.
- Existing valid saved choices are never reset; only missing or invalid values
  use the new defaults.

## Validation

- Focused ThemeContext and Appearance page tests
- `pnpm test:e2e -- tests/e2e/settings-appearance.spec.ts`
- Browser and Desktop black-box verification with screenshot
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm desktop:verify`
