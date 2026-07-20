---
title: Messenger Saved Views
date: 2026-07-20
kind: implementation
status: planned
area: chat
entities:
  - messenger_chat
  - messenger_saved_views
  - side_panel
issue:
related_plans:
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-07-07-messenger-side-panel-session-state.md
  - 2026-07-17-safe-change-throughput-architecture-optimization.md
supersedes: []
related_code:
  - packages/db/src/schema/messenger_saved_views.ts
  - packages/db/src/schema/messenger_custom_groups.ts
  - packages/shared/src/types/messenger.ts
  - packages/shared/src/validators/chat.ts
  - server/src/routes/messenger.ts
  - server/src/services/messenger.ts
  - ui/src/api/messenger.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/components/messenger/MessengerThreadListViews.tsx
  - ui/src/lib/side-panel-targets.ts
  - ui/src/pages/Messenger.tsx
  - tests/e2e/messenger-saved-views.spec.ts
  - desktop/scripts/smoke.mjs
commit_refs: []
updated_at: 2026-07-20
---

# Messenger Saved Views

## Summary

Add durable, operator-scoped Messenger Saved Views for eligible Side Panel
targets. An operator can save a Browser tab, Automation, or Library document,
entry, file, or directory without interrupting the current workbench. Saved
Views appear in a fixed `Saved` section immediately below `New chat`, can mix
with ordinary Messenger items inside custom groups, and reopen through
`/messenger/saved-views/:id`.

The saved record is a durable pointer to a workbench target, not a message
thread. It never receives unread state, attention state, mark-read behavior, or
a synthetic latest-message timestamp.

## Problem

Side Panel tabs are intentionally session-scoped. They preserve adjacent work
while an app session remains alive, but they are not a durable way to keep a
useful web page, automation, or Library object in the Messenger directory for
later. Reusing chat-thread semantics would provide persistence at the cost of
false unread badges, false recency, and misleading message actions.

Saved Views close that gap while keeping the Side Panel as the workbench and
Messenger as the durable directory. Browser targets receive a best-effort live
resume while their original guest still exists and a truthful URL fallback
when it does not.

## Product Logic Alignment

This approved implementation changes the guarded Product Logic Registry:

- Add `MESSENGER.SAVED.VIEWS.001`.
- Update `CHAT.SIDE.PANEL.001` for non-disruptive save and target restoration.
- Update `MESSENGER.CUSTOM.GROUPS.001` for mixed thread/Saved View membership.
- Update `MESSENGER.ATTENTION.001` to exclude Saved Views from message-derived
  unread, attention, mark-read, and activity-time semantics.

## Scope

In scope:

- Save the current Side Panel target when it is Browser, Automation,
  `library_document`, `library_entry`, `library_file`, or
  `library_directory`.
- Persist organization scope, operator scope, display metadata, a typed target
  descriptor, fallback state, hidden state, and stable manual ordering.
- Add list, create, update/hide/restore/reorder, get, and delete API behavior
  under the organization-scoped Messenger API.
- Render visible ungrouped Saved Views in a fixed `Saved` section below
  `New chat` and allow Saved Views to be members of existing custom groups.
- Route selection through `/messenger/saved-views/:id` and open or focus the
  corresponding Side Panel target.
- Preserve a live Browser guest when the original guest still exists; otherwise
  reopen the last persisted URL in the normal Browser partition.
- Add database migration, shared types/validators, server/API/UI coverage,
  production-shaped E2E coverage, and packaged Desktop verification.

Out of scope:

- Saving issue, chat, side-chat, or placeholder targets.
- Treating a Saved View as a chat conversation or any other Messenger thread.
- Cross-operator or cross-organization sharing.
- Cross-device synchronization of live Browser guest state.
- Persisting or replaying Browser history stacks, scroll position, form state,
  POST bodies, in-page application memory, or unsaved page edits.

## Data And API Design

Add an organization-owned, operator-owned `messenger_saved_views` table. Each
record has `id`, `orgId`, `userId`, `targetKind`, typed `targetPayload`,
`title`, `subtitle`, optional `favicon`, fixed-section `sortOrder`, `hiddenAt`,
and created/updated timestamps. The schema must enforce organization ownership
and support stable visible and hidden ordering per operator.

Browser identity is its live `tabId`, never only its URL. Repeated Add from the
same live tab reuses the existing record (or restores it when hidden); two live
tabs at the same URL create distinct records. Automation and every Library
variant deduplicate by owning resource identity and restore an existing hidden
record rather than creating another.

Custom-group membership uses the stable Messenger directory key
`saved-view:<id>`. That key is only a directory identity; it does not opt the
record into thread APIs or thread attention semantics. Existing thread keys and
legacy custom-group persistence remain compatibility-preserving while the
group-entry model is generalized to mixed Messenger directory items. Deleting
a Saved View removes its custom-group membership in the same transaction.
The database keeps the legacy `thread_key` column as an opaque key. Group APIs
accept and return generic `itemKey` / `item` while continuing to accept and
return compatible `threadKey` / `thread` fields for thread-backed callers.
Every hydrated entry returns `itemKey` and `item`; thread-backed entries also
return `threadKey` and `thread` aliases, while Saved Views never populate the
thread aliases. Mutation requests accept either generic `itemKey`/`itemKeys` or
legacy `threadKey`/`threadKeys`. When both aliases are supplied they must be
equal or validation returns `400`; generic fields are canonical after
validation.

Expose organization-scoped board APIs to:

1. List visible and, when explicitly requested, hidden Saved Views in stable
   order.
2. Create a Saved View from a validated supported target descriptor.
3. Read one Saved View for the route-backed detail selection.
4. Update its name, hidden/restored state, and order.
5. Delete the record and its custom-group membership.

Every read and mutation must enforce organization and operator scope. Mutations
must use the normal validation, HTTP error, and activity-log conventions.
Missing or inaccessible owning-domain targets return an actionable unavailable
state without granting access from a stored descriptor.

## Interaction Design

### Add

The active Side Panel target exposes `Add to Messenger` only for the supported
target kinds. Browser places the action in the address bar before New tab;
Automation and Library targets place it at the right side of their target
header. The action states are `Add to Messenger`, `In Messenger`, and
`Restore in Messenger`; a blank Browser tab cannot be saved. A successful add
confirms persistence but does not navigate the Messenger route, close or hide
the Side Panel, change the active Side Panel tab, or switch to the new Saved
View. Failure leaves the current workbench unchanged and surfaces the mutation
error.

### Directory And Route

Messenger keeps a fixed `Saved` directory section immediately below
`New chat`; it is not inserted into `Latest activity` by a fabricated
timestamp. Visible Saved Views that are not in a custom group appear there in
manual order. A Saved View assigned to a custom group renders in that group
alongside thread-backed members and is not duplicated in the fixed section.
Rows show favicon or target-kind icon, title, and domain/path/automation
subtitle, with Move to group, Hide, and Remove actions. The section header
provides `Hidden (n)` management with Restore and Remove.

Selecting a Saved View navigates to `/messenger/saved-views/:id`. The route
loads the operator-scoped record and asks the shared Side Panel controller to
open or focus its target. The global Side Panel is forced to its expanded
workspace width while the Messenger sidebar remains visible. Direct
reload/deep-link follows the same path.

### Hide, Restore, And Delete

Hide removes a Saved View from the visible Messenger directory without deleting
it. Hidden management offers Restore. Hide and Restore preserve the record's
custom-group membership and manual position, so Restore returns it to the same
group/order location when that group still exists. If its former group was
deleted while it was hidden, Restore returns it to the fixed `Saved` section in
its preserved Saved View order.

Delete removes the Saved View record and all of its custom-group membership,
but it does not close, replace, or mutate a Side Panel target that is already
active. If the deleted Saved View route is selected, Messenger moves to its
normal safe Saved directory state while the adjacent target may remain open.

### Browser Continuity

Saving a Browser target records its durable fallback label and last eligible
URL and associates it with the current Browser target identity. While the
original Browser guest exists, selecting the Saved View focuses that same live
guest so its in-memory navigation, page, and form state survive as a best
effort capability.

The live association ends when the original guest is explicitly closed, the
Side Panel session is reset, Browser data is reset, or the app restarts. The
next selection creates a normal Browser target from the last persisted URL in
the dedicated Browser partition. It can therefore use partition cookies that
still exist, but it must not claim to restore navigation history, scroll/form
state, POST state, or page memory. A Browser-data reset may also have removed
those cookies. Normal Browser URL, sandbox, popup, permission, download, file,
and control-plane-origin policies remain unchanged.

Browser guest ownership moves into an App-level `BrowserRuntimeProvider` with
a stable guest layer keyed by `tabId`. The normal and expanded global Side
Panel workspaces register display anchors; they do not reparent or remount the
`<webview>` when the route or Side Panel context changes. The provider owns
navigation, zoom, errors, title, favicon, and last-used state, and keeps no more
than eight live guests by evicting the least-recently-used inactive guest.
Eviction never deletes a Saved View. Deduplicated, throttled navigation, title,
and `page-favicon-updated` changes update the durable fallback URL, title, and
favicon without changing Messenger activity ordering.

Missing or inaccessible Automation and Library resources keep their Saved View
row and show an unavailable state. In web/mobile builds without an Electron
guest, Browser Saved Views remain visible and ask the operator to open them in
Rudder Desktop; Automation and Library Saved Views continue to open normally.

## Implementation Plan

1. Add and export the Saved View schema, generate the migration, and adapt
   custom-group entries to support saved-view membership without breaking
   existing thread keys.
2. Add shared Saved View types, supported target discriminators, request
   validators, route constants/exports where applicable, and serialization
   tests.
3. Add organization/operator-scoped service methods and Messenger routes for
   list/get/create/update/reorder/hide/restore/delete, including atomic cleanup
   of membership and activity logging.
4. Extend custom-group hydration to resolve both thread summaries and Saved
   Views while keeping Saved Views outside attention and mark-read code paths.
5. Add the fixed `Saved` section, hidden-item management, mixed custom-group
   rendering/actions, and `/messenger/saved-views/:id` selection in the
   Messenger UI.
6. Add `Add to Messenger` to supported Side Panel targets without changing current
   route, visibility, tab order, or active tab.
7. Extract the App-level Browser runtime and stable guest layer. Add the
   live-Browser association and throttled last-URL/title/favicon update path.
   Reuse a living guest when possible; otherwise create a fresh target through
   the existing Browser profile and policy boundary. Enforce the eight-guest
   inactive-LRU limit without deleting Saved View records.
8. Add focused schema/service/route/type/UI tests and the real Messenger Saved
   View E2E workflow, including organization/operator isolation and Browser
   fallback corner cases.
9. Run packaged Desktop verification and visually inspect the Messenger
   directory, mixed custom groups, hidden management, and Browser restoration.

## Invariants And Compatibility

- Saved View ids, target descriptors, routes, and mutations never authorize
  cross-organization or cross-operator access.
- A Saved View is not returned by Messenger thread endpoints and cannot be
  marked read/unread, counted for attention, or ordered from a fake message
  time.
- Existing Messenger thread keys, custom groups, and thread behavior remain
  compatible.
- Add, hide, restore, and delete do not implicitly close an active Side Panel
  target or change the active tab.
- Saved Library targets still pass through current organization-scoped Library
  path/object checks when reopened.
- Saved Automation targets still use owning Automation APIs and lifecycle.
- Saved Browser targets still use `CHAT.SIDE.PANEL.001` and the Built-in Browser
  security/profile rules; saved persistence grants no new navigation privilege.

## Success Criteria

- Browser, Automation, and all four supported Library target variants can be
  saved from the Side Panel without a route, visibility, or active-tab change.
- Messenger shows a fixed `Saved` section below `New chat`, supports the stable
  Saved View route, and can mix Saved Views with ordinary items in custom
  groups without duplicated rows.
- Hide/Restore preserves group and order; Delete removes record/membership but
  leaves an already active target alone.
- Saved Views never show or change unread count, attention, mark-read, or a
  synthetic latest-message timestamp.
- Browser selection reuses the live guest while it exists and truthfully falls
  back to the last URL after restart, reset, or explicit close.
- Cross-organization, cross-operator, missing-target, long-list ordering, and
  persistence/reload cases are covered.

## Validation

- `pnpm db:generate`
- Focused database, shared type/validator, Messenger service/route, Side Panel,
  and Messenger component tests.
- `pnpm test:e2e tests/e2e/messenger-saved-views.spec.ts --project=chromium`
  with Browser, Automation, every Library target kind, custom-group mixing,
  hide/restore/delete, direct route reload, isolation, and unavailable-target
  cases.
- `pnpm product-logic:check`
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `pnpm desktop:verify`
- Browser/Desktop visual verification with final screenshots stored outside
  the repository before hand-off.

## Open Issues

None. The implementation boundary and fallback behavior are approved by this
plan.
