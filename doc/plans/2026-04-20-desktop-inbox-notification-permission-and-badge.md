---
title: Desktop inbox notification permission and dock badge
date: 2026-04-20
kind: implementation
status: completed
area: desktop
entities:
  - desktop_notifications
  - inbox_badge
  - desktop_shell
issue: RUD-41
related_plans:
  - 2026-03-26-rudder-desktop-v1.md
  - 2026-04-12-settings-about-page.md
supersedes: []
related_code:
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - ui/src/components/PrimaryRail.tsx
  - ui/src/pages/InstanceAboutSettings.tsx
commit_refs:
  - fix: complete desktop notification permission flow
updated_at: 2026-04-20
---

# Desktop Inbox Notification Permission And Dock Badge

## Summary

Finish Rudder Desktop inbox notifications as a real desktop capability instead
of a best-effort IPC hook. The implementation must handle notification
permission state explicitly, keep Dock badge behavior visible and debuggable,
and give operators a clear place to inspect and repair the desktop permission
state.

## Problem

The current implementation wires inbox count changes to Electron IPC, but it
does not complete the permission chain needed for a dependable desktop
experience on macOS. It assumes that `Notification.isSupported()` is enough,
does not request notification permission, does not surface permission status,
and does not provide a user-facing recovery path when the OS denies or has not
yet granted notification access. As a result, both notifications and Dock badge
behavior can fail silently.

## Scope

- In scope:
  - desktop notification permission status and request flow
  - Dock badge sync gated by explicit desktop permission state
  - About/settings visibility for desktop notification status and repair actions
  - automated coverage for the permission-aware desktop workflow
- Out of scope:
  - a full notification preference center with per-thread/per-org controls
  - Windows/Linux parity beyond preserving existing behavior
  - unrelated inbox count semantics

## Implementation Plan

1. Add a desktop notification permission bridge that reports current status,
   requests permission from the renderer using the web Notifications API, and
   opens desktop notification settings when the OS has denied access.
2. Update the primary-rail inbox effect so badge sync and desktop notifications
   use the explicit permission state instead of assuming support from
   `Notification.isSupported()`.
3. Extend the About page with a desktop notifications section that shows the
   current permission state and exposes contextual actions such as request
   access or open system settings.
4. Add tests for permission-state formatting and UI rendering, plus desktop-side
   coverage for the permission bridge.

## Design Notes

- Electron keeps the renderer and main process split, so permission requests
  should stay in the renderer while OS integration such as opening system
  settings stays in the main process.
- macOS notification permission is part of the OS notification system, so the
  product should treat permission as a first-class state rather than as an
  implementation detail.
- The existing `About` page already hosts desktop lifecycle actions and is the
  least surprising place for permission diagnostics and repair.
- Badge sync should remain cheap and idempotent, but it must no longer fail
  silently when the desktop permission state blocks the expected result.

## Success Criteria

- Desktop mode can report whether notification permission is `granted`,
  `default`, `denied`, or unsupported.
- Operators can trigger the permission request from the app and can reach the
  OS notification settings when access has been denied.
- Inbox count changes continue to drive Dock badge sync, but the flow no longer
  depends on blind IPC calls with no visibility into permission state.
- The desktop About page makes it obvious why notifications/badges are not
  working and what to do next.

## Validation

- `pnpm --filter @rudder/desktop typecheck`
- `pnpm --filter @rudder/ui typecheck`
- targeted Vitest coverage for the new desktop permission workflow
- relevant desktop smoke or UI automation coverage for the visible permission
  surface when feasible

## Open Issues

- Exact Dock badge behavior on macOS when notification permission is denied is
  partly OS-defined; Rudder should surface state and best-effort behavior rather
  than promise cross-version identical semantics.
