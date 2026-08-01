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
  - desktop/src/local-app-framework.ts
  - desktop/src/local-app-icon-discovery.ts
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
  - ui/src/components/AppsContextSidebar.tsx
  - ui/src/pages/Apps.tsx
  - ui/src/context/LiveSurfaceRuntimeContext.tsx
  - ui/src/components/workbench/MessengerMainWorkbench.tsx
related_tests:
  - desktop/src/local-apps-registry.test.ts
  - desktop/src/local-apps-discovery.test.ts
  - desktop/src/local-app-framework.test.ts
  - desktop/src/local-app-icon-discovery.test.ts
  - desktop/src/local-apps-controller.test.ts
  - desktop/src/local-apps-runtime.test.ts
  - desktop/src/local-apps-ipc.test.ts
  - ui/src/components/side-panel/LocalAppsPanel.test.tsx
  - ui/src/components/side-panel/LocalAppPanelView.test.tsx
  - ui/src/context/LiveSurfaceRuntimeContext.test.tsx
  - ui/src/lib/local-apps.test.ts
  - tests/e2e/messenger-local-apps.spec.ts
  - tests/e2e/app-builder.spec.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-23-messenger-work-packages-local-apps.md
  - doc/plans/2026-07-23-messenger-main-workbench-promotion.md
  - doc/plans/2026-07-29-app-builder-prd.md
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
- Make starting a local command a direct action against a reviewed definition;
  Apps treats clicking a registered App as that direct action.
- Keep the service alive while its view moves, closes, or is removed from
  Messenger. Stop it through an explicit lifecycle action or Desktop shutdown,
  with bounded safety cleanup when startup, readiness, or runtime ownership
  fails.
- Preserve a durable Messenger entry when the installation-local runtime is
  unavailable without silently starting code.

### Why / Design Reasoning

A Saved View is a durable directory entry, a Main tab is a session working
instance, and a Local App process plus Browser guest is a physical runtime.
Conflating those lifecycles would make background hydration or Messenger
navigation capable of running commands, make removing a row capable of killing
work, or make a transfer lose runtime state. Apps is the deliberate launcher
exception: clicking a registered App is direct operator intent. Keeping the
remaining lifecycles separate preserves process safety and exact-instance
continuity.

Server storage cannot safely own local paths, commands, environment variables,
ports, PIDs, or live URLs. Those values are device-specific and potentially
sensitive. Electron main therefore owns reviewed definitions, process
attestation, partitions, and lifecycle control; the Server owns only opaque
Saved View identity and group placement.

### Actors / Objects / State

- **Operator**: reviews a discovered definition, opens a registered App
  directly, uses explicit lifecycle controls when needed, and moves or saves
  its view.
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
- Apps workspace registered-App rows, tabs, and row More menus.
- Explicit `Start & open`, `Stop`, retry, and review actions.
- Main Workbench Local App tab hover/focus More menu and its `Project settings`
  action.
- Side Panel `Move to Messenger` for the active exact Local App tab.
- Messenger Saved View row and `/messenger/saved/:savedViewId`.
- Main Workbench tab Close, Remove from Messenger, tab switching, and reload.

### Product Logic Flow

1. Desktop discovers a candidate definition but does not execute it.
2. The review dialog always shows the composed start command, project folder,
   open path, and local-code warning. The structured executable, literal
   arguments, editable working directory, readiness path and timeout, open path,
   and inherited environment names are available under `View advanced
   settings`. The operator may approve from the summary without expanding that
   disclosure; expanding it is the path for inspecting or editing the complete
   launch definition. A changed definition requires a new review.
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
9. A valid `APP.BUILDER.001` managed session is the narrow exception to the
   ordinary direct-Start rule. One explicit `Register & preview` action may
   register and start the exact Rudder-owned template revision after its build
   succeeds.
   The managed action cannot accept Agent-provided executable, shell text,
   absolute cwd, port, or environment values. A changed launch definition
   requires review. After that first review, a direct click on its registered
   row in the Apps workspace may reuse or start the reviewed revision.
   Background hydration, Messenger Saved Views, and ordinary Agents remain
   unable to start it.
10. If listener ownership cannot be proven, the runtime enters a bounded
   unavailable or orphaned-unverified state. Rudder never guesses a PID to kill
   and ordinary Local Apps never run install, build, migration, or recovery
   commands automatically. App Builder setup uses its separate typed,
   template-scoped contract.
11. `Project settings` shows the reviewed Local App definition from the Main
    tab. A stopped or failed definition is editable and saved through the same
    native review path as the catalog. A running, starting, or stopping
    definition is read-only until the operator explicitly chooses `Stop &
    edit`; opening or dismissing settings alone never stops the process.
12. Experimental Sites is the admission gate for both manually loaded Local
    Apps in the Apps workspace and managed App Builder Apps. Disabling Sites
    rejects new operations, drains admitted operations, stops every
    running/transitioning owned definition, and preserves definitions and data.
    Re-enabling never passively restarts a definition.
13. The Apps workspace is an application launcher, not a passive Saved View.
    Clicking a registered App is direct operator intent to open its reviewed
    revision. Rudder automatically reuses or starts its one generation,
    attests the target, and renders the webpage in the main content. Closing or
    switching its tab never stops the generation. Infrequent settings, link,
    browser, and Stop actions live in the registered row's hover/focus More
    menu rather than a persistent runtime sidebar.
14. When an explicit Local App start fails or an active generation later enters
    `failed`, the failure surface offers **Ask AI for help** alongside retry.
    It opens a new Chat with a reviewable, unsent diagnostic draft containing
    only the App label and generic recovery request. The recovery draft has an
    isolated local draft scope, so an existing New Chat draft is preserved. It neither retries or
    starts the App nor automatically sends a message, creates a run, loads
    logs, or includes local paths, commands, arguments, environment names or
    values, readiness/open paths, ports, URLs, PIDs, partitions, or raw error
    text. The operator may add reviewed details and explicitly send the Chat.

### Common Web Project Compatibility

Manual Local App discovery recognizes direct development scripts for common Web
projects, including Vite, React/Vite, Vue/Vite, Next, Astro, SvelteKit, Nuxt,
Vue CLI, and `react-scripts`, when launched through npm, pnpm, Yarn, or Bun.
Rudder appends its allocated loopback host and port only to a direct supported
framework command. Custom executables, dependency-only projects, and shell
compound scripts remain unchanged rather than receiving arguments that could be
interpreted by the wrong process.

Recognized frontend projects use `/` as the default readiness path because an
HTML response proves the development server is serving. Generic or API-only
projects retain `/api/health` as the fallback. An explicit `rudder.app.json`
readiness path or a documented README health route takes precedence over either
default.

The Apps catalog prefers an App-provided favicon, manifest icon, or conventional
project logo asset. When no project asset is available, a recognized framework
badge is used; generic projects keep the ordinary fallback icon. The icon is
presentation metadata only and never grants runtime authority.

### Decision Table

| Situation | Required behavior | Forbidden behavior |
|---|---|---|
| Definition is discovered | Show the command/folder/open-path summary, warning, and an Advanced disclosure for the complete launch definition | Execute it |
| Operator approves without opening Advanced | Approve the exact summarized definition and its installation-local revision | Treat approval as permission for a later changed definition |
| Operator selects `Start & open` on an approved definition | Start once, attest loopback listener, open isolated guest | Use a shell or accept a foreign listener |
| Definition revision changed | Require renewed review | Reuse old approval silently |
| Definition already has a running generation | Reuse that generation for another view | Run a second command |
| Exact Side tab moves to Messenger Main | Transfer the same guest and host lease | Reload, duplicate guest, or restart service |
| Saved row opens while service is stopped | Show stopped/unavailable state with explicit action | Auto-start |
| Registered App row opens in Apps after review | Reuse or auto-start the reviewed revision and render its attested guest | Require a second Start action or expose an unattested origin |
| Apps tab closes or switches | Keep the owned generation resident | Stop or restart it |
| Saved row opens on Web, another Desktop, or without local binding | Keep row and explain unavailability | Delete row or fabricate a runtime |
| Remove from Messenger | Remove durable binding; keep open Main tab session-only | Close tab or stop process |
| Close Main tab | Dispose that view; keep Saved row and running process | Remove row or stop process |
| Switch Main tabs | Park/focus guest without process change | Stop or restart process |
| Operator selects Stop | Stop the owned generation and update all attached views | Leave some views claiming it is running |
| Readiness/listener attestation fails | Fail boundedly and report the causal state | Open an unattested origin |
| Common frontend project is discovered | Use `/` readiness, inject the allocated loopback host/port into its direct framework command, and show its project/framework icon | Require `/api/health`, change a custom or compound script, or treat the icon as authority |
| Generic or API-only project is discovered | Keep `/api/health` as the default unless manifest/README configuration overrides it | Assume every project serves an HTML root |
| Project has no icon asset | Show the recognized framework badge, or the generic fallback for unknown projects | Fail discovery or infer runtime authority from branding |
| Explicit start fails or a running generation enters `failed` | Offer Retry & open and Ask AI for help with an unsent, sanitized Chat draft | Auto-retry/start/send, create a run, or transfer raw local diagnostics into Chat |
| Process ownership is uncertain | Quarantine as orphaned-unverified | Guess-kill a process |

### Actor-Visible Input

- Always-visible composed start command, project folder, open path, and
  local-code warning.
- Advanced launch fields for the resolved executable, literal arguments,
  working directory, readiness endpoint and timeout, open path, and inherited
  environment names.
- Explicit Start, Retry & open, Stop, Move, Remove, Close, and review actions.
- **Ask AI for help** for explicit start failures and `failed` runtime state;
  the operator reviews and sends the resulting Chat draft.
- Hover/focus More menu on a Main Local App tab, with `Project settings` and an
  explicit `Stop & edit` transition when the runtime is active.
- Hover/focus More menu on each Apps sidebar row for App settings, source,
  current attested link/browser actions, managed development data, and
  explicit Stop.
- Local runtime status and unavailable reason.

### Operator-Visible Output

- A Local App tab in Side Panel or full-bleed Main Workbench.
- A registered App opened full-bleed in the Apps main content, without a
  persistent right runtime-control column.
- A registered App row with its discovered project icon or framework fallback
  badge when no project icon is available.
- A Main-tab project settings dialog that shows the reviewed configuration,
  prevents active-runtime edits, and updates the tab label after a successful
  reviewed save.
- A compact default review state with the execution summary and warning;
  complete structured launch authority remains inspectable and editable through
  the Advanced disclosure.
- Stable runtime status: starting, running, stopped, failed, or
  orphaned-unverified, with unavailable presented when the local binding or
  supported Desktop environment is absent.
- Clear errors for changed definitions, readiness failure, ownership mismatch,
  missing binding, another device, or unsupported Web environment.
- A failure-recovery Chat draft that contains the App label and generic request
  only; raw local diagnostics remain visible only on the Desktop failure
  surface unless the operator deliberately adds them. The failure page offers
  Ask AI for help; source access remains in the row More menu rather than as a
  duplicate failure-page action.
- Messenger row with a Local App icon and title, never a local path, command,
  PID, port, or live URL.

### Persisted Evidence

- Installation-local reviewed definitions and their approved revisions.
- Installation-local runtime generation metadata needed for safe recovery and
  shutdown.
- Server-side opaque Saved View target identity and custom-group membership.
- Tests prove that no local command, path, environment, PID, port, or live URL
  enters the Saved View payload.
- Selecting Ask AI for help does not persist or send Local App diagnostics. A
  Chat is created only after the operator reviews and explicitly sends its
  draft.

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

#### Card Studio or another Vite project

The operator registers an existing Vite, React/Vite, or Vue/Vite project whose
script may assume a fixed development port. Discovery keeps its direct package
manager command, Rudder supplies the isolated loopback host and port, readiness
checks `/`, and the Apps row shows the project's own logo when present or its
framework badge otherwise. A custom server wrapper or API-only project is left
unchanged and retains its explicit or `/api/health` readiness contract.

### Invariants / Non-Goals

- Start is always a direct operator action against a reviewed definition.
  `Start & open`, an explicit App Builder `Register & preview`, and clicking a
  registered row in the Apps workspace are direct actions; background
  hydration and Messenger Saved View navigation are not.
- Review approval is revision-specific. The operator is not required to expand
  Advanced before approval, but the complete structured definition must remain
  available there and any later definition change requires renewed review.
- Opening or dismissing project settings never stops a Local App; changing an
  active definition requires the operator to choose `Stop & edit` explicitly.
- Background hydration, Messenger navigation, reload, restore, Move, Remove,
  Close, and passive status/log retry do not execute commands. Explicit
  `Start & open`, `Retry & open`, or a registered-App click inside Apps may
  execute the reviewed command; an explicit, valid managed App Builder session
  may execute only its Rudder-owned template command.
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
- Ordinary Local Apps do not automatically install dependencies, build
  projects, run migrations, repair services, expose non-loopback listeners, or
  guess process ownership. App Builder's separately confirmed fixed runner is
  the only managed setup/check exception.
- Ask AI for help is a navigation-and-prefill aid, not a runtime action. It
  cannot start, retry, inspect, or transmit Local App diagnostics by itself.

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
  `ui/src/lib/local-apps.ts`,
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
