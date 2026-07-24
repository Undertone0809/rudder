---
title: Messenger Main Workbench Promotion
date: 2026-07-23
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_saved_views
  - main_workbench
  - side_panel
  - desktop_local_apps
issue:
related_plans:
  - 2026-07-23-messenger-work-packages-local-apps.md
  - 2026-07-20-messenger-saved-views.md
  - 2026-07-01-global-side-panel-workbench.md
supersedes:
  - 2026-07-20-messenger-saved-views.md
related_code:
  - ui/src/lib/main-workbench-state.ts
  - ui/src/context/MainWorkbenchContext.tsx
  - ui/src/context/LiveSurfaceRuntimeContext.tsx
  - ui/src/context/SavedViewPromotionContext.tsx
  - ui/src/components/workbench/MessengerMainWorkbench.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/MessengerSavedViewWorkspace.tsx
  - desktop/scripts/smoke.mjs
  - tests/e2e/messenger-saved-views.spec.ts
  - tests/e2e/messenger-local-apps.spec.ts
commit_refs:
  - 1f96b6862
  - 1c7cc1273
  - c3c9190a4
  - 6a3045215
  - 6514e539e
  - 1a8f9d574
  - 223c3128a
updated_at: 2026-07-23
---

# Messenger Main Workbench Promotion

## Summary

Move an exact eligible Side Panel view into a session-level, organization-scoped
Messenger Main Workbench. Messenger remains the durable directory, while Main
tabs are the current working instances. A move transfers the same physical
Browser or Local App guest, or the same editor/work-surface session, instead of
opening a replacement.

This plan replaces the earlier Saved View behavior that reopened content in the
Side Panel. It retains the Local App safety and process-lifecycle constraints
from `2026-07-23-messenger-work-packages-local-apps.md`.

## Product Logic Delta

The implementation affects `CHAT.SIDE.PANEL.001`,
`MESSENGER.SAVED.VIEWS.001`, `MESSENGER.CUSTOM.GROUPS.001`, and
`AGENT.BROWSER.001`, plus a proposed Local App Main-host lifecycle contract.
The guarded `doc/product/**` registry is not edited without separate explicit
authorization. Code and tests will ship with a concrete registry delta proposal.

## First-Principles Model

- A Messenger Saved View row is a durable entry in a custom group.
- A Main Workbench tab is a session working instance.
- A Browser, Local App, editor, or embedded work surface is a physical runtime
  with exactly one visual host lease.
- Durable identity, tab identity, and runtime identity are related but never
  interchangeable.
- URL, file path, resource key, and Saved View ID cannot replace the exact
  `viewInstanceId`.

## Required Journeys

### Move the exact Side tab

When Side contains Browser A, B, and C, moving B freezes B's context,
`viewInstanceId`, and source revision. The keep mutation atomically creates or
reuses the host Chat/Issue group, stages B in Main, waits for the Main anchor,
claims the same runtime, and only then detaches B. A and C remain in Side in
their original order; C becomes active, otherwise A. Side closes only when B was
its final tab.

Explicit server failure leaves Side and Messenger unchanged. An uncertain
commit retains Side and retries with the same mutation ID. If the server commit
succeeds but the Main claim fails, both the durable row and Side source remain
with an explicit retry action.

### Continue work in Main

Main has one mixed WAI-ARIA tab strip for Browser, Library, Automation, and
Local App tabs. Browser uses the same full-bleed chrome as an expanded Side
Panel: the mixed tab strip touches the Browser toolbar and web content directly.
There is no nested Browser card, rounded inner frame, inset padding/background,
or second Browser tab strip.

The `+` creates a session-only Browser tab. `Cmd/Ctrl+T`, `Cmd/Ctrl+W`, and
`Ctrl+Tab` resolve against the physical guest owner. A session-only Browser can
be kept only after explicit group confirmation.

### Saved row, remove, and close

Saved rows use the same density, drag affordance, keyboard movement, selection,
and actions as Chat/Issue rows. Browser rows show title plus favicon or a
Web/Globe fallback and never expose the URL.

Removing a Saved View deletes only durable membership; an open Main tab remains
unchanged as session-only. Closing a Main tab releases that instance but keeps
the Saved row for a later cold reopen. Clicking a row focuses the exact live Main
tab or hydrates it in Main and never opens Side.

### Browser and Local App runtime continuity

Side and Main share eight live Browser guests per organization. Live transfer
does not increase the count and cannot be rejected for capacity. A cold reopen
at capacity shows a recoverable capacity state without reusing or evicting an
unrelated exact tab.

For `/Users/zeeland/projects/uranus/rudder/mkt/dashboard`, moving the Local App
preserves its PID, runtime generation, partition, `webContentsId`, URL, and page
marker. Move, Main tab switching, Main Close, and Remove never start or stop the
service. Only explicit Stop terminates it. Unavailable or stopped bindings stay
isolated inside that exact Main tab and never auto-start.

### Library and Automation

Moving a Library view preserves the exact draft, selection, cursor, scroll,
undo/redo, autosave, and stale-write state. Two instances of the same file stay
independent. Automation preserves its exact subview and local interaction state.
Deleted, forbidden, conflict, stopped, and crash states are isolated to the
affected Main tab.

## Implementation

1. Use the pure `main-workbench-state` reducer for organization-scoped tab,
   runtime, promotion, failure, retry, remove, close, capacity, and neighbor
   semantics.
2. Mount promotable physical surfaces in a route-independent stable runtime
   layer. Side and Main register geometry anchors; a generation-checked lease
   positions one runtime without DOM reparenting or guest recreation.
3. Separate route context from the displayed Side context so Messenger Main
   navigation does not hide surviving source tabs.
4. Implement a two-phase promotion context around the existing idempotent Saved
   View API and exact Side detach revision.
5. Route `/messenger/workbench` and `/messenger/saved/:id` to the same full-bleed
   Main Workbench. Keep Main tab order independent from custom-group order.
6. Put Saved rows in the mixed sortable custom-group model, with pointer and
   keyboard DnD and a menu fallback.
7. Route Desktop guest shortcuts and popup/new-window events by ephemeral
   physical guest ownership without persisting PID, port, or `webContentsId`.

## Verification

- Reducer and component tests cover exact transfer, retries, claim failure,
  remove/close orthogonality, capacity, organization isolation, neighbor
  selection, metadata, route synchronization, DnD, and keyboard behavior.
- E2E covers A/B/C exact movement, mixed Main tabs, same-URL independent
  instances, automatic group creation, group DnD, direct routes, reload,
  unavailable states, and organization isolation.
- Packaged Desktop Browser smoke proves unchanged guest identity, count,
  history, form, scroll, zoom, and heap marker, plus full-bleed geometry.
- Packaged MKT smoke proves unchanged PID, generation, partition, guest ID, and
  page marker, and verifies that Remove and Close do not stop the process.
- Final gates are lint, recursive typecheck, test suite, build, relevant E2E,
  product-logic check, Desktop verification, rendered screenshots, and two
  adversarial review/black-box verification rounds.
