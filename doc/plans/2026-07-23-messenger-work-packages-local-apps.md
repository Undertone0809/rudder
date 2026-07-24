---
title: Messenger Work Packages and Desktop Local Apps
date: 2026-07-23
kind: implementation
status: completed
area: chat
entities:
  - messenger_saved_views
  - messenger_custom_groups
  - side_panel
  - desktop_local_apps
issue:
related_plans:
  - 2026-07-20-messenger-saved-views.md
  - 2026-07-01-global-side-panel-workbench.md
  - 2026-07-07-messenger-side-panel-session-state.md
supersedes:
  - 2026-07-20-messenger-saved-views.md
related_code:
  - packages/db/src/schema/messenger_saved_views.ts
  - packages/shared/src/types/messenger.ts
  - packages/shared/src/validators/messenger.ts
  - server/src/services/messenger-saved-views.ts
  - server/src/services/messenger.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/MessengerContextSidebar.tsx
  - desktop/src/local-apps-runtime.ts
  - desktop/src/desktop-runtime-shutdown.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - server/src/runtime/http-server-shutdown.ts
  - tests/e2e/messenger-saved-views.spec.ts
  - tests/e2e/messenger-local-apps.spec.ts
commit_refs:
  - c95ca807c
  - c5ed54cae
  - c967781d8
  - 343d4ff78
  - b08006439
  - 00b4b30ed
  - 29e93f532
  - 643ae2a94
  - 33c97b053
  - 83c1ac69a
  - 929d3ce61
  - cdca1e5e1
  - 678386c29
  - 7bc8a9534
  - 42147d67d
updated_at: 2026-07-24
---

# Messenger Work Packages and Desktop Local Apps

## Summary

Finish the incomplete Side Panel to Messenger workflow without a fixed Saved
directory. A saved Browser, Automation, Library object, file view, or Desktop
Local App appears as a normal entry inside a Messenger custom group. Saving
from an ungrouped Chat or Issue atomically creates a group containing the host
work item and the Saved View. Saving outside Chat or Issue requires choosing an
existing group.

Add a Desktop-only Local App capability for explicitly reviewed project
development services. Launch definitions and process authority remain in
Electron main on the current installation; the Server stores only opaque Saved
View identity. The first production-shaped example is
`/Users/zeeland/projects/uranus/rudder/mkt/dashboard`, started with
`npm run dev`, checked at `/api/health`, and opened at `/outreach`.

## Product Logic Alignment

Affected contracts are `MESSENGER.SAVED.VIEWS.001`,
`MESSENGER.CUSTOM.GROUPS.001`, `CHAT.SIDE.PANEL.001`,
`MESSENGER.ATTENTION.001`, `AGENT.BROWSER.001`, and a proposed new
`DESKTOP.LOCAL.APPS.001`.

This implementation restores the already-registered Saved View capability but
intentionally changes its fixed-section and single-resource identity rules.
On 2026-07-24 the user explicitly authorized the guarded `doc/product/**`
registry update. The delta is now synchronized in the affected collaboration
and Browser contracts plus the new `DESKTOP.LOCAL.APPS.001` contract.

## Invariants

1. Every visible or unavailable Saved View has exactly one Messenger group
   membership. There is no fixed Saved section and no hidden Saved manager.
2. A Saved View is a directory item, never a message thread. It has no unread,
   attention, mark-read, or fabricated activity-time semantics.
3. Saving from a stable Chat or Issue is one Server transaction: reuse or
   create the host group, create or restore the Saved View instance, and add
   both memberships exactly once.
4. Saving outside Chat or Issue requires an existing group. It never silently
   creates a content-only group.
5. Group Separate/Delete returns `409` while any Saved View membership exists,
   including unavailable legacy records.
6. A canonical resource may have multiple view instances. Repeating Save for
   one instance is idempotent; explicit New tab creates another instance.
7. Local App command, cwd, env, PID, port, and live URL never enter Postgres or
   a Server start/stop REST API.
8. Local App start requires a direct `Start & open` user action against an
   already reviewed installation-local definition. Hydration, reload, deep
   links, tab restoration, and Desktop startup never start a service.
9. One Local App definition has at most one running generation; multiple Side
   Panel tabs share it. Closing a tab or removing/moving a Saved View never
   stops the process.
10. Only an attested loopback origin owned by the launched process tree can be
    opened in the isolated Local App Browser guest.

## User Journeys

### 1. Ungrouped Chat saves a Browser tab

The operator opens a Browser tab beside a stable Chat and selects `Keep in
Messenger`. The Server creates one editable group named from the Chat title,
adds the Chat and Saved View, and returns the placement. The exact Browser guest
moves into Messenger Main after Main claims its host lease; only that Side tab
detaches. Retrying the same mutation creates no duplicates.

### 2. Ungrouped Issue saves a Library file

The operator opens a Library file beside an Issue and keeps it. The Issue UUID
is resolved from the visible reference, a normal group is created, and both
entries appear together. A stale or unresolved Issue reference fails without
creating any partial row.

### 3. Existing group receives another item

If the current Chat or Issue already belongs to a group, the Saved View joins
that group. The success message names the destination. No second group is
created.

### 4. Global Side Panel save

From a non-Chat/Issue page, Keep opens a chooser containing existing groups.
Choosing one saves there. If no group exists, the UI explains that a work
package must first be created from a Chat or Issue.

### 5. Concurrent retry

Double click, response loss, or two equivalent requests with the same
`clientMutationId` converge to one Saved View, one host group, and one entry
per member. A transaction failure leaves none of them committed.

### 6. Same file, two views

Normal open focuses the existing file view. `Open in new tab` creates a new
`viewInstanceId`; each instance can be kept independently and restored to the
exact tab identity. Both still edit the same underlying file and retain normal
stale-write conflict handling.

### 7. Restore and remove

Selecting a Saved View opens or focuses its exact Main Workbench instance
without changing unread state. Remove deletes the Saved View and membership but
keeps an open Main tab as session-only. Closing Main keeps the durable row for a
later cold reopen. A group remains until the operator explicitly separates it.

### 8. Protected group operations

Separate or Delete on a group containing a Saved View receives a `409` with an
actionable message to move or remove those items first. After the last Saved
View is removed, the explicit operation succeeds.

### 9. Add the dashboard Local App

In `Open a panel > Local apps`, the operator picks
`/Users/zeeland/projects/uranus/rudder/mkt/dashboard`. Desktop main discovers
the supported package script and shows the canonical cwd, resolved executable,
arguments, loopback/port/readiness settings, and a warning that current project
code can modify local files and data. Confirmation persists the trusted
definition only in Electron userData.

### 10. Start and open

The operator selects `Start & open`. Desktop allocates a loopback port, starts
the structured executable without a shell, waits for `/api/health`, verifies
the listener belongs to the owned process tree, and opens `/outreach` in the
definition's isolated Local App Browser partition.

### 11. Save and reopen a Local App

The running Local App tab can be kept in the current work package. Its Server
payload contains only installation, local binding, definition, and view
identity. On a later Desktop launch the row is Stopped; route restoration alone
does not execute. An explicit `Start & open` reuses its stored local binding.

### 12. Changed definition

If cwd realpath, executable resolution, argv, selected package script,
allowlisted env, or readiness configuration changes, the trust fingerprint no
longer matches. Start returns `Review changes`; no process launches until the
operator approves the new details.

### 13. Startup failure

Missing prerequisites, port ownership mismatch, readiness timeout, or process
exit produces a bounded Failed state with safe logs and Retry/Edit/Stop. Rudder
does not run install, build, migration, or arbitrary recovery commands.

### 14. Multi-tab and stop

Two Local App tabs share one runtime generation but retain separate
`viewInstanceId` and route. Stop affects all tabs and leaves their Saved Views
in place. Closing one tab or removing one Saved View does not stop the runtime.

### 15. Quit, crash, and orphan reconciliation

Normal Desktop quit performs TERM, bounded wait, then KILL for the owned process
group. A runner control channel handles Desktop-main failure for supported
foreground services. If ownership cannot be proven on restart, state becomes
`orphaned_unverified`; restart is blocked and Rudder never guesses a PID to
kill.

### 16. Other device or Web

A Local App Saved View remains movable/removable but displays unavailable when
the current Desktop installation or local binding does not match. It never
reveals or reconstructs command/cwd/env and cannot remotely start the original
device.

## Implementation Slices

### Slice A: Saved View identity and atomic placement

- Add `instanceId` and `canonicalResourceKey` to Saved Views while retaining a
  per-instance compatibility `resourceKey`.
- Add a forward migration that backfills identity and places every legacy
  ungrouped row into an ordinary deterministic recovery group.
- Extend shared target schemas with `viewInstanceId` and opaque `local_app`
  identity.
- Add an idempotent `POST /messenger/saved-views/keep` endpoint with an anchor
  or explicit group placement and `clientMutationId`.
- Enforce group-only placement and `409` for protected Separate/Delete inside
  the same placement lock and transaction.

### Slice B: Messenger and Side Panel UI

- Add Keep actions to eligible Side Panel headers/address bar.
- Add group chooser behavior outside Chat/Issue.
- Hydrate/render Saved View rows directly inside custom groups.
- Add a Saved View route workspace that focuses/restores the exact target in
  Messenger Main.
- Add `viewInstanceId` to resource targets and explicit New tab behavior.
- Remove all fixed Saved, hidden, and loose rendering concepts.

### Slice C: Desktop Local Apps

- Add shared Desktop Local App DTOs and narrow IPC accepting opaque IDs only.
- Add a versioned, atomic, permission-restricted userData store for host,
  definitions, bindings, runtime descriptors, and bounded logs.
- Discover package-script candidates in Desktop main and require a native trust
  confirmation before persistence or changed-fingerprint execution.
- Add macOS foreground process-group ownership, singleflight start, loopback
  port allocation, readiness, listener ownership verification, Stop, quit
  cleanup, and conservative orphan reconciliation.
- Add isolated per-definition Browser partitions and block external/local
  cross-origin navigation from retaining Local App authority.

### Slice D: Verification

- Unit/integration tests cover validators, resource identity, transaction
  rollback/idempotency, protected groups, store corruption, fingerprint
  invalidation, start singleflight, readiness/ownership failure, and cleanup.
- Playwright E2E covers Chat/Issue auto-group, existing/global placement,
  same-resource multi-instance restore, remove, and protected group actions.
- Desktop smoke/packaged verification covers a repository fixture Local App.
- Real local black-box verification starts the MKT dashboard with the real
  growth DB and a temporary copy of the mail DB, opens `/outreach`, stops it,
  and proves no owned listener/process remains.
- Run `pnpm product-logic:check`, lint, recursive typecheck, tests, build,
  relevant E2E, and `pnpm desktop:verify` before handoff.

## Migration and Rollback

- Use a new forward migration; do not edit an applied migration.
- Preserve row count, hidden rows, ownership scope, and existing memberships.
- Backfill `instanceId = id` and `canonicalResourceKey = resourceKey`.
- Give every legacy ungrouped row one deterministic `Recovered items` group
  membership per operator; clear legacy hidden state because no hidden manager
  remains.
- Older clients may render `local_app` as unsupported but must not delete it.
- Feature rollback stops verified owned runtimes, disables Local App controls,
  and preserves definitions, Saved rows, groups, and multi-instance data.

## Delivery Boundary

Implementation and verification may be committed and pushed to `main` as the
user requested. This plan does not authorize production deployment. The user
separately authorized the semantic `doc/product/**` update on 2026-07-24.

## Delivery Evidence

- Messenger Saved Views render only inside ordinary custom groups; there is no
  fixed Saved section. Chat and Issue anchors atomically create a group when
  needed, while global Side Panel saves require an existing group.
- Local App definitions and launch authority remain Desktop-local. The Server
  receives only opaque Saved View identity, and restore never starts a process.
- Browser Broker generations, shared tab admission, renderer destruction,
  Desktop quit, Server close, embedded database cleanup, and packaged-smoke
  cleanup now have explicit regression coverage.
- The real `/Users/zeeland/projects/uranus/rudder/mkt/dashboard` service passed
  Start, readiness, `/outreach`, Keep in Messenger, Stop, and process/listener
  cleanup checks against temporary database copies.

## Validation

- `pnpm lint`: passed.
- `pnpm -r typecheck`: passed across 21 workspace projects.
- `pnpm build`: passed.
- `pnpm product-logic:check`: 77 contracts valid.
- Saved View and Local App Playwright E2E: 7/7 passed.
- Focused Desktop/Server regression aggregate: 12/12 files and 172/172 tests
  passed locally, then passed twice independently. Browser routes additionally
  passed 10 consecutive adversarial runs (710/710 assertions exercised).
- `pnpm desktop:verify`: development and packaged smoke paths passed, including
  clean install, startup recovery, upgrade, Local App startup, and shutdown.
- The repository-wide `pnpm test:run` was executed but is not recorded as
  green: existing cross-file mock/process isolation failures appeared only in
  aggregate runs, while their isolated files and every feature-focused suite
  passed. This remains a repository test-harness caveat rather than a relaxed
  assertion in this delivery.
- Adversarial code review found no P0/P1/P2 issue; independent black-box
  verification returned PASS.
