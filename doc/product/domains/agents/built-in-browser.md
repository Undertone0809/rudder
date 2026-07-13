---
title: Rudder Built-in Browser
domain: agents
status: active
coverage: current
spec_depth: logic_contract
contract_ids:
  - AGENT.BROWSER.001
related_code:
  - desktop/src/browser-profile.ts
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-webview-policy.ts
  - desktop/src/browser-import-snapshot.ts
  - desktop/src/browser-import-sources.ts
  - desktop/src/browser-cookie-import-worker.ts
  - desktop/src/browser-cookie-import.ts
  - desktop/src/browser-cookie-db.ts
  - desktop/src/browser-cookie-crypto-macos.ts
  - desktop/src/browser-keychain-macos.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/navigation-guard.ts
  - desktop/src/preload.ts
  - desktop/src/browser-agent-electron.ts
  - desktop/src/browser-agent-tabs.ts
  - desktop/src/browser-broker-registration.ts
  - desktop/src/browser-broker-server.ts
  - desktop/src/browser-popup-rate-limit.ts
  - desktop/src/browser-runtime-lifecycle.ts
  - desktop/src/main.ts
  - server/src/services/instance-settings.ts
  - server/src/services/browser-broker.ts
  - server/src/services/browser-capability.ts
  - server/src/middleware/auth.ts
  - server/src/routes/browser.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/services/runtime-kernel/model-fallback.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/organization-intelligence-profiles.ts
  - server/src/services/integrations/feishu/inbound-dispatcher-db.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - cli/src/agent-v1-mcp-server.ts
  - cli/src/commands/client/browser.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/DesktopBrowserLinkBridge.tsx
  - ui/src/lib/browser-side-panel.ts
  - ui/src/lib/desktop-browser-link-router.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/components/BrowserDataImportDialog.tsx
related_tests:
  - desktop/src/browser-profile.test.ts
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-webview-policy.test.ts
  - desktop/src/browser-import-snapshot.test.ts
  - desktop/src/browser-import-sources.test.ts
  - desktop/src/browser-cookie-import-worker.test.ts
  - desktop/src/browser-cookie-import.test.ts
  - desktop/src/browser-cookie-db.test.ts
  - desktop/src/browser-cookie-crypto-macos.test.ts
  - desktop/src/browser-keychain-macos.test.ts
  - desktop/src/desktop-quit-flow.test.ts
  - desktop/src/navigation-guard.test.ts
  - desktop/src/preload.browser.test.ts
  - desktop/src/browser-agent-refs.test.ts
  - desktop/src/browser-agent-tabs.test.ts
  - desktop/src/browser-broker-registration.test.ts
  - desktop/src/browser-broker-server.test.ts
  - desktop/src/browser-popup-rate-limit.test.ts
  - desktop/src/browser-runtime-lifecycle.test.ts
  - server/src/__tests__/browser-routes.test.ts
  - server/src/__tests__/auth-middleware.test.ts
  - server/src/services/browser-broker.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - server/src/__tests__/model-fallback.test.ts
  - server/src/__tests__/chat-assistant.test.ts
  - server/src/__tests__/organization-intelligence-profiles.test.ts
  - server/src/__tests__/agent-integration-feishu-db-dispatcher.test.ts
  - server/src/__tests__/organization-skills-reference.test.ts
  - cli/src/__tests__/agent-v1-mcp-server.test.ts
  - cli/src/__tests__/browser-command.test.ts
  - ui/src/pages/InstanceBrowserSettings.test.tsx
  - ui/src/components/BrowserDataImportDialog.test.tsx
  - ui/src/components/DesktopBrowserLinkBridge.test.tsx
  - ui/src/context/SidePanelContext.test.tsx
  - ui/src/lib/browser-side-panel.test.ts
  - ui/src/lib/desktop-browser-link-router.test.ts
  - tests/e2e/built-in-browser.spec.ts
  - tests/e2e/chat-side-panel.spec.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-12-built-in-browser.md
edit_policy: user_confirmed_only
---

# Rudder Built-in Browser

## AGENT.BROWSER.001

### Contract Summary

Rudder Desktop provides an instance-scoped Built-in Browser for operators and
Rudder-managed agents. It is enabled by default, opens ordinary Rudder web
links in a Browser tab in the global Side Panel by default, and stores one
persistent website profile per operating-system user and canonical Rudder
instance. Organizations intentionally share that website identity, while Agent
Browser tabs and control leases remain isolated by organization, agent, run,
and tab.

V1 is a Desktop `local_trusted` capability. It includes local macOS Chromium
cookie import, a conditional read-only `Browser` skill, and eight high-level
`rudder_browser_*` tools. It does not provide password import, arbitrary page
script execution, raw cookie access, or remote control of a local Desktop.

### Intent / User Job

- Operators can inspect and use web content without losing their current
  Rudder work surface, choose the system browser when preferred, import an
  existing signed-in session, and reset the shared Browser profile.
- Agents can perform bounded browser navigation and interaction through a
  typed, runtime-owned control surface instead of receiving raw credentials,
  unrestricted CDP, or model-supplied browser identity.

### Why / Design Reasoning

One profile per local instance makes Browser sessions useful across the whole
Rudder workspace and avoids a separate login for every organization. That
convenience is an explicit trust decision: settings and import confirmation
must disclose cross-organization session sharing. Control remains run-scoped so
shared cookies do not imply shared tab ownership.

The Browser skill and tools are one capability resolved from the live instance
setting. Rudder projects them at run time rather than writing permanent skill
assignments to every organization. High-level tools reuse the first-party
`rudder-control-plane` transport so authentication, runtime identity, and
auditing remain inside existing boundaries.

### Actors / Objects / State

- Operator: configures Browser behavior, opens Side Panel tabs, imports cookies,
  and clears data.
- Runtime agent: uses the conditional Browser skill and tools during an active
  supported local run.
- Browser settings: instance-scoped `enabled` and `openLinksIn` values. Missing
  or legacy values resolve to `true` and `built_in`.
- Browser profile: a persistent Electron partition derived from OS user plus
  canonical Rudder instance, without `orgId` in the key.
- Operator Browser tab: a global Side Panel Browser target using that profile.
- Agent Browser lease: in-memory ownership keyed by `orgId`, `agentId`,
  `runId`, and `tabId`.
- Desktop Broker: loopback-only, in-memory authenticated bridge between the
  Rudder server and Desktop-owned Browser tabs.
- Import source: an operator-selected Google Chrome, Microsoft Edge, or Brave
  Browser profile on macOS whose cookie database is read from a temporary copy.

### Entry Points / Inputs

- `Settings > Desktop app > Browser` for enablement, link destination, import,
  and clear actions.
- Ordinary external `http:` and `https:` links opened from Rudder Desktop.
- Side Panel Browser address/search input and explicit `Open externally`.
- `rudder_browser_tabs`, `rudder_browser_open`, `rudder_browser_navigate`,
  `rudder_browser_read`, `rudder_browser_click`, `rudder_browser_type`,
  `rudder_browser_screenshot`, and `rudder_browser_close`.
- Browser disable, clear, run cleanup, and Desktop shutdown lifecycle events.

### Product Logic Flow

1. A fresh or legacy instance resolves Browser as enabled and link destination
   as `built_in` unless the operator has saved another supported value.
2. Desktop configures the dedicated persistent Browser partition and its guest
   policy before creating any operator or Agent Browser guest.
3. An ordinary external web link opens or focuses a Browser Side Panel tab when
   `openLinksIn` is `built_in`, independently of whether Agent Browser access is
   enabled. The current Rudder route stays in place. The explicit external
   command always uses the system browser.
   Operator Browser popup requests are intercepted into another Side Panel tab
   instead of creating an unrestricted guest window, even when ordinary Rudder
   links are configured to use the system browser. Agent-page popups are
   denied in V1; Agents open another tab through the audited Browser tool. Each
   Side Panel context holds at most eight Browser tabs. At capacity, an ordinary
   Rudder link reuses the active Browser tab or the first Browser tab, while an
   explicit new-tab or popup request is discarded. Desktop accepts at most eight
   operator popup requests in a rolling ten-second window.
   Main-window same-origin navigation and redirects are revalidated before
   commit, so a cross-origin 30x is routed to Browser or denied rather than
   loading into the privileged Rudder renderer.
4. Side Panel and Agent Browser tabs use the same website profile. Switching
   organizations or restarting Desktop preserves cookies and site data, but a
   different Rudder instance uses a different profile.
5. In `local_trusted` mode, when Browser is enabled, organization skill
   reconciliation exposes the read-only bundled `Browser` skill. A run receives
   that skill, the capability flag, and Browser tools only when its adapter is
   `claude_local`, `codex_local`, `opencode_local`, or `pi_local`. Model fallback
   recomputes the whole capability and removes the skill, flag, and tools when
   the fallback runtime is not eligible.
6. A Browser tool call derives organization, agent, run, API, and Broker
   identity from Rudder-owned context. Browser authorization requires a
   run-scoped Agent JWT: its signed `run_id` is authoritative, an optional run
   header must match it, and a long-lived Agent API key cannot gain Browser
   access by supplying a run header. Rudder then validates the active run and
   live Browser setting and permits access only to tabs leased to that exact
   run.
7. The Desktop Broker executes only the eight bounded actions against approved
   `http:` or `https:` pages. Each run may own at most eight Agent Browser tabs,
   and one Desktop process may own at most 32 Agent Browser tabs in total; an
   additional open fails with `browser_tab_limit`. Tool activity records action
   and sanitized origin, never credentials, query tokens, form values, cookies,
   or page content.
8. On macOS, import discovery lists supported local Chromium profiles without
   reading cookie values. After operator confirmation, Desktop creates a
   consistent private snapshot through SQLite's online backup API while the
   source browser remains open, obtains required Keychain access, imports
   supported cookies without replacing existing destination cookies, cleans the
   snapshot, and reports imported, skipped, and failed counts with skip reasons
   grouped separately from failures. The read-only snapshot path does not alter
   Cookie records or source DB/WAL contents; SQLite may update transient
   shared-memory coordination metadata while opening the live database.
9. Disabling Agent Browser access immediately stops new import/control admission,
   closes Agent Browser tabs, revokes leases, rejects current Browser tool calls,
   and removes the Browser skill and tools from later run projections before
   waiting for any in-flight import to finish. It preserves operator Browser
   tabs, profile data, and `openLinksIn`; ordinary operator links continue to
   follow that independent destination preference while Agent access is off.
10. Clearing Browser data immediately stops admission and closes all Browser
    tabs and leases, then waits for any admitted import and performs Electron's
    exhaustive session-data removal, including cookies, cache, local storage,
    CacheStorage, service workers, HTTP auth state, and other Chromium browsing
    data. It preserves `enabled` and `openLinksIn` settings.
11. Graceful Desktop quit closes import admission, aborts any active import
    worker, and waits for its private snapshot cleanup before runtime shutdown.
    Import directories carry an opaque canonical-instance owner and live process
    marker. Startup reaps only dead snapshots for that instance and current OS
    user; it preserves live, foreign-instance, unmarked, malformed, symlinked,
    and unrelated temporary entries.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Fresh Desktop instance | No saved Browser fields | Browser is enabled and Rudder web links use the Side Panel Browser | Legacy absence must not disable the capability or default links externally | Settings service/UI tests |
| Built-in link | `openLinksIn=built_in`, external HTTP(S) URL, regardless of Agent Browser enablement | Open or focus a Side Panel Browser tab and preserve the current Rudder route | Do not replace the Rudder route or open the system browser because Agent Browser access is off | Side Panel E2E and Desktop smoke |
| External preference or explicit escape | `openLinksIn=default_browser`, or operator selects `Open externally` | Open through the operating-system browser | Do not silently reopen the URL inside Rudder | Settings and link-router evidence |
| Supported Agent call | Browser enabled, supported local runtime, run-scoped Agent JWT, active run, owned tab | Execute the bounded action through the authenticated Broker | Model arguments or unsigned headers must not override identity, credential, or lease ownership | Auth, route, Broker, MCP, and adapter tests |
| Unsupported deployment or runtime | Deployment is not `local_trusted`, or adapter is not Claude/Codex/OpenCode/Pi local | Do not project a usable Browser capability; reject a stale unsupported-runtime API call with `browser_runtime_unsupported` | Skill, flag, and tools must not disagree or survive an ineligible fallback | Capability, organization skill, run-context, route, and fallback tests |
| Forged run context | Agent JWT run header differs from its signed `run_id`, or a long-lived Agent key supplies a run header | Reject before run lookup or Broker dispatch | One run must not impersonate another run of the same Agent | Auth middleware and Browser route tests |
| Cross-run tab call | Tab belongs to another org, agent, or run | Reject without revealing tab content | Shared cookies must not grant shared tab control | Browser route/Broker tests |
| Browser unavailable | Enabled but no healthy local Desktop Broker | Return stable `browser_unavailable` | The run must not hang or receive a false success | Browser route tests |
| Agent Browser disabled | Capability is off at projection or call time | Remove the skill and tools from later run projections; reject current calls with `browser_disabled`; revoke Agent tabs while preserving operator tabs and link routing | A stale run snapshot must not retain control, and Agent enablement must not override `openLinksIn` | Skill reconciliation, adapter, link-router, Side Panel E2E, and Desktop smoke tests |
| Operator tab capacity | Side Panel context already has eight Browser tabs | Ordinary Rudder links reuse an existing Browser tab; popup and explicit new-tab requests are discarded | Do not create an unbounded guest or native window | Side Panel capacity and popup tests |
| Agent tab capacity | Run already has eight tabs or Desktop has 32 Agent tabs | Reject another open with `browser_tab_limit` until an owned tab closes | One run must not exhaust the Desktop with unbounded hidden tabs | Agent tab controller tests |
| Cookie import | macOS supported Chromium source selected and operator confirms | Import supported cookies locally, preserve existing cookies, and report partial outcomes | Do not read before confirmation, alter source Cookie records or DB/WAL contents, expose values, or claim password import | Desktop importer and dialog tests |
| Source browser open | Selected Chromium Cookie database is actively used in WAL mode | Create an online consistent snapshot and import without interrupting the source browser | Do not require browser shutdown, copy a torn database/WAL pair, alter source Cookie records or DB/WAL contents, or expose filesystem paths, cookie data, or Keychain details; transient SQLite shared-memory coordination updates are allowed | Snapshot, Desktop smoke, IPC, preload, and dialog tests |
| Unsupported import | Non-macOS, unsupported encryption/data type, or password request | Show the capability as unavailable or count the item as unsupported/failed | Do not report unsupported data as imported | Importer and dialog tests |
| Quit or crash during import | Desktop quits gracefully or a prior same-instance process crashed after creating a marked snapshot | Abort and await cleanup on graceful quit; reap dead same-instance residue on startup | Do not leave recoverable raw snapshots indefinitely or delete a live/foreign-instance snapshot | Profile, worker, snapshot, and quit-flow tests |
| Clear data | Operator confirms shared-profile clear | Stop admission and close tabs immediately, then clear the whole Electron Browser session and preserve settings | Do not wait behind an import before revoking guests, clear only one storage subset/organization, or reset Browser preferences | Desktop profile tests and real Desktop smoke |

### Actor-Visible Input

The operator sees a Browser settings page with enablement, link destination,
`Import...`, and `Clear all browsing data`, plus a disclosure that sessions are
shared across organizations and agents in this Rudder instance. The import
dialog shows discovered source profiles, supported data types, confirmation,
progress, and explicit partial-success or error results. Passwords are shown as
unavailable, not as a successful import option.

The runtime agent sees the read-only `Browser` skill and the eight typed Browser
tools only when Rudder resolves the capability for the run. Tool arguments
contain action inputs such as URL, tab id, element reference, or text, but not
organization, agent, run, API, or Broker credentials.

### Operator-Visible Output

- Browser Side Panel tabs keep the current Rudder route visible and expose
  address/search, navigation, reload, close, and explicit external-open actions.
- Settings show saved state and visible confirmation/results for disable,
  import, and shared-profile clear operations.
- Stable Agent errors distinguish disabled, unavailable, unsupported runtime,
  capacity, invalid URL/reference, and unowned-tab cases without exposing secret
  or page data.

### Persisted Evidence

- Instance Browser settings persist independently of any organization.
- Cookies and site data persist only in the dedicated instance Browser profile;
  Browser tabs, leases, and Broker credentials do not. Copied import databases
  are ephemeral: normal/cancel/quit paths remove them, and startup safely reaps
  dead marked residue owned by the same instance.
- Agent Browser activity persists the organization, agent, run, tab, action,
  and sanitized origin needed for audit, without sensitive page input/output.
- Import source paths, cookie values, Keychain secrets, and raw source databases
  are not product evidence and must not enter renderer/server payloads or logs.

### Canonical Scenarios

1. Default operator link:
   - Trigger: operator clicks an external web link on a fresh Desktop instance.
   - Expected state/action: a Browser Side Panel tab opens on the shared profile.
   - Visible output: current Rudder route remains visible beside the page.
   - Evidence: default settings, Side Panel E2E, and Desktop smoke.

2. Cross-organization session reuse:
   - Trigger: operator signs in to a website, switches organizations, and opens
     that site again.
   - Expected state/action: website identity remains signed in while panel tab
     state follows normal Side Panel session rules.
   - Visible output: the destination site sees the same local Browser session.
   - Evidence: shared partition and organization-switch acceptance test.

3. Isolated Agent control:
   - Trigger: one active run attempts to read a tab opened by another run.
   - Expected state/action: Rudder rejects the unowned tab request.
   - Visible output: stable safe error; no tab content or credential disclosure.
   - Evidence: Browser route and Broker isolation tests.

4. Disable and re-enable:
   - Trigger: operator disables Agent Browser access, opens a Rudder web link,
     then later enables Agent access again.
   - Expected state/action: Agent tabs and leases close immediately; later runs
     lose the skill/tools; operator tabs and saved website data remain available.
   - Visible output: the link continues to follow the saved `openLinksIn`
     preference while Agent access is disabled.
   - Evidence: settings, skill reconciliation, runtime, and Desktop tests.

### Invariants / Non-Goals

- Profile identity is OS user plus canonical Rudder instance, never
  organization. Shared profile data must be disclosed before import and clear.
- `openLinksIn` controls operator link routing only. Selecting the system
  browser must not disable the Agent Browser skill or tools, and must not send
  popup requests from an already-open Rudder Browser tab to the system browser.
- Agent Browser enablement controls Agent skill/tool and import admission only.
  It must not close operator Browser tabs, hide the operator Browser target, or
  override the independently persisted `openLinksIn` destination.
- Tab/control identity is always `orgId + agentId + runId + tabId`; profile
  sharing never weakens run ownership.
- Operator Browser capacity is eight tabs per Side Panel context. At capacity,
  ordinary Rudder links reuse an existing tab, while popup and explicit new-tab
  requests are discarded. Operator popups are limited to eight per rolling ten
  seconds per Desktop process.
- Agent Browser capacity is eight tabs per run and 32 tabs per Desktop process.
  Capacity never weakens run ownership or creates an implicit cross-run reuse.
- Browser guests do not share the Rudder UI/API session partition and run
  sandboxed without Node integration, untrusted preload, unrestricted popups,
  permissions, downloads, or non-web protocol navigation by default.
- The privileged Rudder renderer revalidates both navigation and redirect
  targets. External 30x destinations must never inherit the Rudder preload or
  privileged IPC sender identity.
- Agent-page popups are denied in V1 so every Agent tab open is live-validated,
  run-owned, bounded, and activity-logged by an explicit Browser tool call.
- Only bounded high-level actions are agent-visible. Raw cookies, tokens,
  arbitrary JavaScript, unrestricted CDP, Broker credentials, and model-supplied
  identity are out of scope.
- V1 import is real local macOS Chromium cookie import only. Passwords, history,
  bookmarks, extensions, downloads, Windows/Linux encrypted cookie formats, and
  daily-browser replacement are not promised.
- Import snapshot cleanup is isolated by opaque canonical-instance ownership,
  current OS user, and live process marker. It must not remove another instance's
  or a still-running process's snapshot.
- The Browser capability is instance-eligible only in `local_trusted` mode and
  run-eligible only for Claude, Codex, OpenCode, and Pi local adapters. Web,
  remote, and other runtimes do not receive a false promise of local Desktop
  Browser control. A future secure remote Broker requires a new contract
  decision.
- Desktop-to-server Browser registration and lifecycle calls and
  server-to-Desktop Broker command requests use literal loopback HTTP endpoints
  and reject HTTP redirects so credentials, command bodies, and page input
  cannot be forwarded to another origin.
- The external Chrome connector proposal is a separate capability and must not
  be represented as the Rudder Built-in Browser.

### Drift Boundaries

Update this contract when changing default enablement/link destination, profile
or tab ownership scope, supported link protocols, clear/disable lifecycle,
import platforms/data types, Browser skill/tool names or projection, runtime
eligibility, Broker identity/authorization, or persisted/redacted evidence.

Internal Electron, IPC, MCP, or importer refactors that preserve these product
semantics do not require a contract change.

### Traceability

Related contracts:

- `ORG.SETTINGS.001` owns Browser settings persistence and operator controls.
- `CHAT.SIDE.PANEL.001` owns Browser tab workbench and route-preserving UI.
- `AGENT.SKILLS.001` owns conditional bundled skill projection.
- `AGENT.CONTROL.TOOLS.001` owns typed tool transport and runtime identity.
- `AGENT.RUNTIME.ADAPTERS.001` owns supported local runtime projection.
- `AGENT.RUNTIME.PERMISSIONS.001` owns managed env and host-data boundaries.

Related plan:

- `doc/plans/2026-07-12-built-in-browser.md`

Known gaps:

- Password import and Windows/Linux cookie import require separate product and
  security decisions.
- Remote-runtime Browser control and per-origin Agent approval policy require
  separate product and security decisions.

Known V1 risk:

- Another same-instance `local_trusted` instance-admin Desktop/client may
  replace the one active in-memory Broker registration. Token-matched unregister
  prevents a stale Desktop shutdown from removing the replacement, but Broker
  generation and owner binding are deferred.
