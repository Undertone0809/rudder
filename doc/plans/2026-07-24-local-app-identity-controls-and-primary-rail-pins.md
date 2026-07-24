---
title: Local App Identity, Overflow Controls, and Primary Rail Pins
date: 2026-07-24
kind: implementation
status: completed
area: desktop
entities:
  - desktop_local_apps
  - messenger_saved_views
  - primary_rail
issue:
related_plans:
  - 2026-07-23-messenger-work-packages-local-apps.md
  - 2026-07-23-messenger-main-workbench-promotion.md
supersedes: []
related_code:
  - desktop/src/local-apps-discovery.ts
  - desktop/src/local-apps-registry.ts
  - desktop/src/local-apps-controller.ts
  - desktop/src/local-apps-ipc.ts
  - desktop/src/preload.ts
  - packages/db/src/schema/messenger_saved_views.ts
  - packages/shared/src/types/messenger.ts
  - packages/shared/src/validators/messenger.ts
  - server/src/services/messenger-saved-views.ts
  - ui/src/components/PrimaryRail.tsx
  - ui/src/components/side-panel/LocalAppPanelView.tsx
  - ui/src/components/messenger/MessengerSavedViewRow.tsx
  - ui/src/components/workbench/MessengerMainWorkbench.tsx
  - tests/e2e/messenger-local-apps.spec.ts
commit_refs: []
updated_at: 2026-07-24
---

# Local App Identity, Overflow Controls, and Primary Rail Pins

## Summary

Give Desktop Local Apps a recognizable identity and quieter runtime controls.
Rudder should discover a project's own website icon without executing project
code, use that icon consistently in Local Apps surfaces, replace the prominent
header Stop button with an overflow menu, and let a durable Local App Saved View
be pinned to the Primary Rail.

The implementation keeps executable authority and local file paths in Electron
main. A Primary Rail pin belongs to the organization/user Saved View, points to
the existing opaque Local App identity, and never starts the underlying service
when opened.

## Problem

The current Local App row, tab, catalog card, and runtime header always show the
same generic `AppWindow` glyph. Common Next.js, React, Vue, Vite, and static HTML
projects already contain a favicon or app icon that can identify them more
quickly.

The Local App runtime header also gives Stop disproportionate visual weight even
though it is an occasional lifecycle action. There is no nearby place to edit
the reviewed definition, inspect logs, or pin a frequently used saved app into
the shell's Primary Rail.

## Scope

In scope:

- bounded, read-only icon discovery for package-backed local development apps;
- conventions used by Next.js App Router, React/CRA, Vue/Vite, and ordinary
  `index.html` or web manifests;
- safe local image loading with root confinement, file-size limits, media-type
  checks, and a generic fallback;
- the discovered icon in the Local Apps catalog, Local App runtime header,
  Messenger Saved View row, and Main Workbench tab;
- a More menu in the runtime header containing Edit details, Logs, Pin/Unpin,
  and Stop when the runtime can be stopped;
- organization/user-scoped Primary Rail pin persistence on a Local App Saved
  View;
- pin navigation through the existing `/messenger/saved/:savedViewId` route;
- unit, service, UI, E2E, Desktop smoke, and visual verification.

Out of scope:

- executing a project, starting a temporary server, or making network requests
  to discover an icon;
- accepting a package-less static HTML directory as a new Local App launch
  type; this task recognizes HTML metadata inside an otherwise supported Local
  App project;
- storing local paths, executable data, ports, or process identifiers on the
  Server;
- automatically creating a Saved View or Messenger group only to satisfy a pin
  request;
- auto-starting a stopped Local App when a pin is opened;
- changing the existing review requirement for executable definition edits.

## Product Logic Alignment

Affected contracts:

- `DESKTOP.LOCAL.APPS.001`
- `MESSENGER.SAVED.VIEWS.001`
- the Primary Rail shell behavior mapped from the Messenger surface

This is a product-logic change rather than a regression-only restoration because
Primary Rail pin persistence and the Local App overflow actions are new visible
behavior. The guarded `doc/product/**` registry remains unchanged until the user
explicitly approves the following delta:

1. `DESKTOP.LOCAL.APPS.001`
   - Project icon discovery is bounded, read-only, root-confined, and never
     executes or fetches project content.
   - Edit remains review-gated; Stop remains explicit but may live in a More
     menu.
   - Pinning is available only for a durable Local App Saved View and opening a
     pin never starts the service.
2. `MESSENGER.SAVED.VIEWS.001`
   - A Local App Saved View may carry organization/user-scoped Primary Rail pin
     state.
   - Removing the Saved View removes its pin; closing its Main tab does not.
   - A pinned unavailable Local App remains navigable to the normal actionable
     unavailable state.
3. Primary Rail surface mapping
   - Pinned Local Apps render after fixed product destinations and use the
     locally resolved project icon when the matching Desktop definition exists.

## Data Ownership and Persistence

### Local project icon

`iconDataUrl` is installation-local display metadata on the Desktop Local App
definition. It is derived from `cwd`, excluded from the executable trust
fingerprint, refreshed when a definition is prepared or edited, and accepted
from neither renderer input nor Server payload.

Older registry records without `iconDataUrl` remain valid. Desktop lazily
discovers their icon during registry load and falls back to the generic glyph
when no safe candidate exists.

### Primary Rail pin

Add a nullable `primary_rail_pinned_at` timestamp to
`messenger_saved_views`. It is scoped by the row's existing organization and
user ownership. Only `local_app` Saved Views may set it. The Server exposes:

- a bounded pinned-list query for Primary Rail hydration;
- an idempotent pin/unpin patch through the existing Saved View update route;
- normal Saved View deletion semantics, which remove the pin with the row.

The pin stores no additional Local App authority. The existing opaque target
payload remains the navigation descriptor.

## Icon Discovery Order

Discovery evaluates candidates in deterministic priority order and returns the
first valid local image:

1. explicit `<link rel="icon">`, `shortcut icon`, or `apple-touch-icon` in a
   bounded root/public `index.html`;
2. icons referenced by a bounded local web manifest linked from HTML or found
   at conventional manifest paths;
3. Next.js metadata files under `src/app/` or `app/`, including `favicon.ico`,
   `icon.*`, and `apple-icon.*`;
4. conventional `public/favicon.*`, `public/icon.*`, and root `favicon.*`
   files used by React, Vue, Vite, and static HTML projects.

Candidate URLs must be local relative paths or same-project root paths.
`http:`, `https:`, protocol-relative, `data:`, `file:`, traversal, symlink
escape, and unsupported media are rejected. Reads are bounded. Raster formats
are checked by magic bytes. SVG is accepted only after bounded text validation
rejects scripts, event handlers, foreign objects, and external references.

## Interaction Design

### Runtime header

- Keep the icon, title, and status on the left.
- Replace the right-aligned Stop button with an icon-only More trigger.
- Menu order:
  1. Edit details
  2. Show/Hide logs
  3. Pin to Primary Rail or Unpin from Primary Rail
  4. separator
  5. Stop, shown only for starting/running/stopping states
- Stop keeps the existing disabled/loading semantics while stopping.
- Pin is enabled only when the view has a durable Saved View id. An unsaved Side
  Panel instance explains that it must first be kept in Messenger.
- Edit opens the existing structured review dialog. Saving changed executable
  details retains native confirmation and is disabled while runtime ownership
  is active or unverified.

### Primary Rail

- Fixed product destinations keep their current order.
- Pinned Local Apps appear in a visually separated, scroll-safe section after
  the fixed destinations and before Settings.
- Each pin uses the local project icon when the current Desktop installation
  matches; otherwise it uses the generic Local App fallback.
- The accessible label is the Saved View title.
- Activating a pin navigates through the organization-aware Saved View route,
  focuses an existing exact Main instance when present, or cold-opens the
  stopped/unavailable state without starting the service.
- Active indication includes the selected pinned Saved View without displacing
  or corrupting the fixed-item motion indicator.

## Implementation Plan

1. Add a pure Desktop icon-discovery module with bounded HTML/manifest parsing,
   deterministic conventions, root/symlink confinement, signature validation,
   and focused fixtures for Next.js, React, Vue/Vite, HTML, malicious paths,
   unsafe SVG, oversized files, and fallback.
2. Extend installation-local Local App definitions with derived
   `iconDataUrl`, preserve old registry compatibility, exclude display metadata
   from trust authority, and thread the value through preload/UI types.
3. Add a reusable UI Local App identity component that resolves the matching
   Desktop definition by opaque identity and renders image failure fallback.
   Adopt it in catalog rows, runtime header, Messenger rows, and Main tabs.
4. Add the Saved View pin timestamp schema/migration, shared types/validators,
   service invariants, route support, bounded pinned query, activity evidence,
   and organization/user isolation tests.
5. Propagate the current Saved View id to the live Local App surface without
   adding it to the opaque target payload. Implement More menu actions, reuse
   the existing definition review form, and keep lifecycle mutations in
   Desktop main.
6. Hydrate Primary Rail pins for the selected organization/user, render the
   dynamic icon entries, support active routing and unpin cache updates, and
   keep long rails scroll-safe.
7. Extend the Local Apps E2E fixture with icon metadata and pin APIs. Prove:
   icon rendering, More menu placement, Stop from the menu, reviewed Edit,
   pin/unpin, rail navigation, stopped/unavailable cold open, organization/user
   isolation, and deletion removing the pin.
8. Run targeted tests, `pnpm product-logic:check`, the repository-wide required
   checks, relevant E2E, and `pnpm desktop:verify`. Capture final Desktop
   screenshots showing the Saved View icon, More menu, and pinned rail entry.
9. Run independent adversarial code review and real local black-box
   verification before hand-off.

## Success Criteria

- A safe project icon is detected for representative Next.js, React, Vue/Vite,
  and HTML metadata layouts without spawning a process or fetching a URL.
- Unsafe, external, escaped, oversized, malformed, or unsupported candidates
  never become rendered icons.
- Existing definitions continue to load and receive a discovered icon when
  possible.
- All named Local App UI surfaces use the discovered icon and recover to the
  generic glyph after image failure.
- The runtime header contains More instead of a prominent Stop button.
- Edit and Stop retain their current safety gates.
- A durable Local App Saved View can be pinned/unpinned, appears in the selected
  organization's Primary Rail, and navigates to the existing Saved View route.
- Pin navigation never starts the Local App.
- Removing the Saved View removes the pin; closing a Main tab does not.
- Another organization or user cannot read or mutate the pin.
- Relevant E2E and packaged Desktop validation pass with reviewer/verifier
  acceptance evidence.

## Validation

Completed on 2026-07-24:

- 229 targeted Desktop/shared/server/UI tests passed.
- Local Apps E2E passed 3/3 in a real embedded-PostgreSQL environment; a
  screenshot-preserving workflow rerun passed 1/1.
- Independent adversarial review reported no remaining findings.
- Independent black-box verification passed the icon, More menu, pin
  navigation, no-duplicate-start, deletion, and organization/user-isolation
  acceptance criteria.
- `pnpm lint`, `pnpm product-logic:check`, and `git diff --check` passed.
- Repository-wide `pnpm test:run` completed with this feature's suites passing,
  but retained unrelated concurrent failures in Transcript, onboarding,
  integrations, Saved View workspace hydration, and embedded-PostgreSQL worker
  setup.
- `pnpm build`, `pnpm -r typecheck`, and `pnpm desktop:verify` remain blocked by
  unrelated concurrent Transcript type errors in
  `RunTranscriptView.blocks.tsx` and `RunTranscriptView.chat.tsx`
  (`TranscriptToolSemanticInfo.actionKind`). The verifier's direct Desktop
  smoke reached the real Electron UI and then hit an unrelated Main Workbench
  border-radius assertion.

- Desktop unit:
  - `desktop/src/local-app-icon-discovery.test.ts`
  - `desktop/src/local-apps-registry.test.ts`
  - controller, IPC, preload, and smoke regressions
- Shared/Server:
  - Saved View validator, service, and route tests for allowed kind, isolation,
    list bounds, idempotent pin/unpin, delete, and invalid kinds
- UI:
  - Local App identity rendering/fallback
  - Local App header More actions
  - Messenger Saved View row and Main tab icons
  - Primary Rail dynamic pins, active state, accessibility, and overflow
- E2E:
  - `tests/e2e/messenger-local-apps.spec.ts`
  - production-shaped unavailable and cross-organization cases
- Required checks:
  - `pnpm lint`
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
  - `pnpm product-logic:check`
  - relevant `pnpm test:e2e` selection
  - `pnpm desktop:verify`
- Visual:
  - Desktop screenshot of detected icon in Messenger/Main
  - Desktop screenshot of More menu
  - Desktop screenshot of pinned Local App in Primary Rail

## Open Issues

- The guarded Product Logic Registry delta above requires explicit user
  authorization before editing `doc/product/**`. Code and tests may be prepared,
  but final product-logic alignment cannot be claimed until that delta is
  approved or the user explicitly authorizes a deferred registry update.
