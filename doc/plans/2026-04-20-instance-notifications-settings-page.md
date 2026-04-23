---
title: Instance notifications settings page
date: 2026-04-20
kind: implementation
status: completed
area: desktop
entities:
  - desktop_notifications
  - instance_settings
  - inbox_badge
issue: RUD-41
related_plans:
  - 2026-04-20-desktop-inbox-notification-permission-and-badge.md
  - 2026-04-12-settings-about-page.md
supersedes: []
related_code:
  - packages/shared/src/types/instance.ts
  - server/src/routes/instance-settings.ts
  - server/src/services/instance-settings.ts
  - ui/src/components/PrimaryRail.tsx
  - ui/src/pages/InstanceNotificationsSettings.tsx
commit_refs:
  - feat: add notifications settings page
updated_at: 2026-04-20
---

# Instance Notifications Settings Page

## Summary

Promote desktop inbox alerts and Dock badge behavior from an implicit side
effect into a first-class settings surface. Rudder should expose a dedicated
`Notifications` page in instance settings, persist operator preferences for the
two current notification behaviors, and make the runtime explain the difference
between browser preview and desktop-shell behavior.

## Problem

The current implementation improved permission handling, but it still leaves
notification behavior feeling unfinished:

- operators have no dedicated place to manage notification behavior
- badge behavior is not modeled as a setting, even though it behaves
  differently from pop-up alerts
- the About page mixes lifecycle actions with notification controls
- browser dev mode versus desktop-shell capability is not explained in-product

This is a product-shape problem, not just an Electron IPC problem.

## Scope

- In scope:
  - a dedicated `Notifications` instance settings entry and route
  - persistent settings for inbox alerts and app icon badge behavior
  - primary-rail behavior that respects those settings before requesting
    permission, showing alerts, or syncing badge count
  - context about browser preview versus desktop-shell-only behavior
  - automated unit and E2E coverage for the new settings path
- Out of scope:
  - per-organization or per-thread notification routing
  - system tray or menu bar notification controls
  - non-inbox notification categories

## Implementation Plan

1. Extend the instance-settings contract with a dedicated notifications settings
   shape and persist it in `instance_settings`.
2. Add `/instance/settings/notifications` across server, shared contracts, UI
   API helpers, route registration, settings memory, and prefetch paths.
3. Build a dedicated notifications page with:
   - OS permission state and repair actions
   - an inbox alerts toggle
   - an app icon badge toggle
   - environment guidance for browser preview versus Electron shell behavior
4. Update the primary-rail inbox effect so:
   - desktop/browser notifications only fire when inbox alerts are enabled
   - badge sync only happens when app icon badge is enabled
   - browser mode keeps a notification preview path, while badge stays
     desktop-shell only
5. Slim the About page back down to lifecycle actions and point notification
   management to the new page.

## Design Notes

- The page should match the structural pattern of ChatGPT desktop settings:
  a dedicated navigation entry with list-style rows, not a debug dump.
- Rudder only has one meaningful desktop notification category today, so the
  settings model should stay intentionally small.
- Badge and alert toggles should be separate because they have different user
  expectations and different platform support characteristics.
- Browser dev mode should still be useful for verifying alert behavior, but it
  should not imply that app icon badges can work there.

## Success Criteria

- Settings navigation includes a dedicated `Notifications` entry.
- Rudder persists inbox alert and app icon badge preferences independently.
- Unread inbox count changes respect those preferences in both browser and
  desktop-shell contexts.
- The settings UI makes it obvious why badges are unavailable in browser mode
  and how macOS permission state affects desktop behavior.

## Validation

- `pnpm db:generate`
- `pnpm --filter @rudder/ui test -- --run ui/src/pages/InstanceNotificationsSettings.test.tsx`
- `pnpm --filter @rudder/ui test -- --run ui/src/lib/instance-settings.test.ts ui/src/lib/settings-prefetch.test.ts`
- `pnpm --filter @rudder/server test -- --run src/__tests__/instance-settings-routes.test.ts`
- `pnpm test:e2e -- tests/e2e/settings-sidebar.spec.ts`
- `pnpm -r typecheck`
- `pnpm build`

## Open Issues

- macOS ultimately owns whether Dock badges appear after permission changes, so
  Rudder should expose state and settings clearly without promising identical
  behavior across all platforms.
