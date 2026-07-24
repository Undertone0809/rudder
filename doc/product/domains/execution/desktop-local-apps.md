---
title: Desktop Local Apps
domain: execution
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - DESKTOP.LOCAL.APPS.001
related_code:
  - desktop/src/local-apps-registry.ts
  - desktop/src/local-apps-discovery.ts
  - desktop/src/local-apps-controller.ts
  - desktop/src/local-apps-runtime.ts
  - desktop/src/local-apps-ipc.ts
  - desktop/src/desktop-runtime-shutdown.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - packages/shared/src/types/messenger.ts
  - packages/shared/src/validators/messenger.ts
  - server/src/services/messenger-saved-views.ts
  - ui/src/components/side-panel/LocalAppsPanel.tsx
  - ui/src/components/side-panel/LocalAppPanelView.tsx
  - ui/src/context/LiveSurfaceRuntimeContext.tsx
  - ui/src/components/workbench/MessengerMainWorkbench.tsx
related_tests:
  - desktop/src/local-apps-registry.test.ts
  - desktop/src/local-apps-discovery.test.ts
  - desktop/src/local-apps-controller.test.ts
  - desktop/src/local-apps-runtime.test.ts
  - desktop/src/local-apps-ipc.test.ts
  - ui/src/components/side-panel/LocalAppsPanel.test.tsx
  - ui/src/components/side-panel/LocalAppPanelView.test.tsx
  - ui/src/context/LiveSurfaceRuntimeContext.test.tsx
  - ui/src/lib/local-apps.test.ts
  - tests/e2e/messenger-local-apps.spec.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-23-messenger-work-packages-local-apps.md
  - doc/plans/2026-07-23-messenger-main-workbench-promotion.md
edit_policy: user_confirmed_only
---

# Desktop Local Apps

## DESKTOP.LOCAL.APPS.001

### Contract Summary

Rudder Desktop can run an explicitly reviewed local development service and
open it in an isolated Browser guest. A Local App definition and its process
authority stay installation-local. Messenger may persist only an opaque Saved
View identity, while an exact live Local App instance can move from Side Panel
to Main Workbench without restarting either the process or guest.

### Intent / User Job

- Let an operator use a project service, such as the Rudder MKT dashboard,
  inside the same workbench as Chat, Issue, Browser, Library, and Automation.
- Make starting a local command an explicit, reviewed Desktop action.
- Keep the service alive while its view moves, closes, or is removed from
  Messenger. Stop it through an explicit lifecycle action or Desktop shutdown,
  with bounded safety cleanup when startup, readiness, or runtime ownership
  fails.
- Preserve a durable Messenger entry when the installation-local runtime is
  unavailable without silently starting code.

### Why / Design Reasoning

A Saved View is a durable directory entry, a Main tab is a session working
instance, and a Local App process plus Browser guest is a physical runtime.
Conflating those lifecycles would make navigation capable of running commands,
make removing a row capable of killing work, or make a transfer lose runtime
state. Keeping them separate preserves operator intent, process safety, and
exact-instance continuity.

Server storage cannot safely own local paths, commands, environment variables,
ports, PIDs, or live URLs. Those values are device-specific and potentially
sensitive. Electron main therefore owns reviewed definitions, process
attestation, partitions, and lifecycle control; the Server owns only opaque
Saved View identity and group placement.

### Actors / Objects / State

- **Operator**: reviews a discovered definition, explicitly starts or stops it,
  and moves or saves its view.
- **Local App definition**: installation-local executable, arguments, working
  directory, readiness check, open path, and reviewed revision.
- **Runtime generation**: one process tree, attested loopback listener, PID,
  generation number, and runtime status for one definition.
- **Local App guest**: an isolated Electron Browser guest with a
  definition-specific persistent partition and exact `viewInstanceId`.
- **Saved View binding**: organization-scoped opaque durable identity and group
  membership. It contains no executable authority.
- **Host lease**: the single visual owner of the guest: Side Panel, transferring,
  Main Workbench, parked, crashed, or disposed.

### Entry Points / Inputs

- Desktop Local Apps catalog and reviewed-definition flow.
- Explicit `Start & open`, `Stop`, retry, and review actions.
- Side Panel `Move to Messenger` for the active exact Local App tab.
- Messenger Saved View row and `/messenger/saved/:savedViewId`.
- Main Workbench tab Close, Remove from Messenger, tab switching, and reload.

### Product Logic Flow

1. Desktop discovers a candidate definition but does not execute it.
2. The operator reviews the structured executable, arguments, working
   directory, readiness rule, and open path. A changed definition requires a
   new review.
3. `Start & open` allocates an automatic loopback port, launches the structured
   executable without a shell, waits for readiness, verifies that the listener
   belongs to the launched process tree, and then opens the attested URL in the
   definition's isolated partition.
4. One definition has at most one running generation. Additional view
   instances may share that generation while retaining distinct
   `viewInstanceId` values.
5. `Move to Messenger` saves opaque identity and group placement, stages the
   exact instance in Main, claims the Main host lease, then detaches only that
   Side tab. The PID, generation, partition, `webContentsId`, current URL, and
   page state remain unchanged.
6. Clicking a Saved View focuses the live exact Main instance or cold-opens an
   unavailable/stopped state. Route hydration, reload, restore, and cold-open
   never start the service.
7. Remove from Messenger deletes only the durable binding. An open Main tab
   becomes session-only. Close disposes only that view instance. Neither action
   stops the process.
8. Explicit Stop terminates the owned process tree and updates every attached
   tab. Normal Desktop shutdown stops Desktop-owned Local App processes.
   Failed start, readiness failure, or an unexpected watchdog exit also triggers
   bounded cleanup of a process tree whose ownership Rudder can prove.
9. If listener ownership cannot be proven, the runtime enters a bounded
   unavailable or orphaned-unverified state. Rudder never guesses a PID to kill
   and never runs install, build, migration, or recovery commands automatically.

### Decision Table

| Situation | Required behavior | Forbidden behavior |
|---|---|---|
| Definition is discovered | Show reviewable candidate | Execute it |
| Operator selects `Start & open` on an approved definition | Start once, attest loopback listener, open isolated guest | Use a shell or accept a foreign listener |
| Definition revision changed | Require renewed review | Reuse old approval silently |
| Definition already has a running generation | Reuse that generation for another view | Run a second command |
| Exact Side tab moves to Messenger Main | Transfer the same guest and host lease | Reload, duplicate guest, or restart service |
| Saved row opens while service is stopped | Show stopped/unavailable state with explicit action | Auto-start |
| Saved row opens on Web, another Desktop, or without local binding | Keep row and explain unavailability | Delete row or fabricate a runtime |
| Remove from Messenger | Remove durable binding; keep open Main tab session-only | Close tab or stop process |
| Close Main tab | Dispose that view; keep Saved row and running process | Remove row or stop process |
| Switch Main tabs | Park/focus guest without process change | Stop or restart process |
| Operator selects Stop | Stop the owned generation and update all attached views | Leave some views claiming it is running |
| Readiness/listener attestation fails | Fail boundedly and report the causal state | Open an unattested origin |
| Process ownership is uncertain | Quarantine as orphaned-unverified | Guess-kill a process |

### Actor-Visible Input

- Reviewed executable, arguments, working directory, readiness endpoint, and
  open path.
- Explicit Start, Retry & open, Stop, Move, Remove, Close, and review actions.
- Local runtime status and unavailable reason.

### Operator-Visible Output

- A Local App tab in Side Panel or full-bleed Main Workbench.
- Stable runtime status: starting, running, stopped, failed, or
  orphaned-unverified, with unavailable presented when the local binding or
  supported Desktop environment is absent.
- Clear errors for changed definitions, readiness failure, ownership mismatch,
  missing binding, another device, or unsupported Web environment.
- Messenger row with a Local App icon and title, never a local path, command,
  PID, port, or live URL.

### Persisted Evidence

- Installation-local reviewed definitions and their approved revisions.
- Installation-local runtime generation metadata needed for safe recovery and
  shutdown.
- Server-side opaque Saved View target identity and custom-group membership.
- Tests prove that no local command, path, environment, PID, port, or live URL
  enters the Saved View payload.

### Canonical Scenarios

#### Rudder MKT dashboard

The reviewed definition points to
`/Users/zeeland/projects/uranus/rudder/mkt/dashboard`, executes `npm run dev`,
waits for `/api/health`, and opens `/outreach`. One command produces one runtime
generation. Moving its exact tab to Main preserves PID, generation, partition,
`webContentsId`, and a page marker. Remove and Close do not stop it; explicit
Stop does.

#### Restore on a different environment

A Messenger row is opened on Web or a Desktop without the matching
installation-local binding. Main keeps the row selected and displays an
unavailable explanation. It does not expose the original path and does not
attempt to start anything.

### Invariants / Non-Goals

- Start is always a direct operator action against a reviewed definition.
- Hydration, navigation, reload, restore, Move, Remove, Close, and passive
  status/log retry do not execute commands. Explicit `Start & open` and
  `Retry & open` may execute the reviewed command.
- Definitions and process authority are installation-local; the Server stores
  opaque identity only.
- Local App commands are structured executable invocations, never shell text.
- Opened origins are loopback listeners attested to the owned process tree.
- One definition has at most one running generation.
- Every guest has exactly one host lease and an isolated definition partition.
- Move preserves the exact live guest. Remove, Close, and tab switching do not
  start or stop the service.
- Navigation and view-lifecycle actions never stop a generation. Explicit Stop
  and Desktop shutdown do; failed start, readiness failure, or watchdog failure
  may also terminate a provably owned process tree as bounded safety cleanup.
- Rudder does not automatically install dependencies, build projects, run
  migrations, repair services, expose non-loopback listeners, or guess process
  ownership.

### Drift Boundaries

- `MESSENGER.SAVED.VIEWS.001` owns durable row identity, group placement, Main
  binding, Remove, and Close semantics.
- `CHAT.SIDE.PANEL.001` owns exact-source promotion and Side sibling behavior.
- `AGENT.BROWSER.001` owns shared Browser guest policy, shortcuts, and popup
  routing; this contract owns Local App command and process authority.
- Desktop runtime code owns attestation and shutdown mechanics. Server routes
  must remain unable to start or stop Local Apps.
- Expanding beyond Desktop, loopback development services, or explicit review
  requires a new product-logic decision.

### Traceability

- Primary implementation:
  `desktop/src/local-apps-registry.ts`,
  `desktop/src/local-apps-controller.ts`,
  `desktop/src/local-apps-runtime.ts`,
  `desktop/src/local-apps-ipc.ts`,
  `ui/src/context/LiveSurfaceRuntimeContext.tsx`, and
  `ui/src/components/workbench/MessengerMainWorkbench.tsx`.
- Primary tests:
  `desktop/src/local-apps-*.test.ts`,
  `ui/src/components/side-panel/LocalAppPanelView.test.tsx`,
  `ui/src/context/LiveSurfaceRuntimeContext.test.tsx`,
  `tests/e2e/messenger-local-apps.spec.ts`, and
  `desktop/scripts/smoke.mjs`.
- Plans:
  `doc/plans/2026-07-23-messenger-work-packages-local-apps.md` and
  `doc/plans/2026-07-23-messenger-main-workbench-promotion.md`.
