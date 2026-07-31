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
  - desktop/src/browser-shortcuts.ts
  - desktop/src/side-panel-close-shortcut.ts
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
  - packages/shared/src/browser-shortcuts.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/DesktopBrowserLinkBridge.tsx
  - ui/src/components/workbench/BrowserLiveSurface.tsx
  - ui/src/lib/browser-side-panel.ts
  - ui/src/lib/desktop-browser-link-router.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/components/BrowserDataImportDialog.tsx
related_tests:
  - desktop/src/browser-profile.test.ts
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-webview-policy.test.ts
  - desktop/src/browser-shortcuts.test.ts
  - desktop/src/side-panel-close-shortcut.test.ts
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
  - packages/shared/src/browser-shortcuts.test.ts
  - ui/src/pages/InstanceBrowserSettings.test.tsx
  - ui/src/components/BrowserDataImportDialog.test.tsx
  - ui/src/components/DesktopBrowserLinkBridge.test.tsx
  - ui/src/components/workbench/BrowserLiveSurface.test.tsx
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
links in a Browser tab in the global Side Panel by default, can transfer an
exact operator tab into the Messenger Main Workbench, and stores one
persistent website profile per operating-system user and canonical Rudder
instance. Organizations intentionally share that website identity, while Agent
Browser tabs and control leases remain isolated by organization, agent, run,
and tab. Explicit operator address-bar input may also bootstrap a narrowly
defined canonical local absolute `file:///` target; renderer links, page-driven
navigation, and Agent Browser control remain HTTP(S)-only.

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
`rudder-tools` transport so authentication, runtime identity, and
auditing remain inside existing boundaries.

### Actors / Objects / State

- Operator: configures Browser behavior, opens Side or Main Browser tabs,
  transfers exact tabs into Messenger, imports cookies, and clears data.
- Runtime agent: uses the conditional Browser skill and tools during an active
  supported local run.
- Browser settings: instance-scoped `enabled` and `openLinksIn` values. Missing
  or legacy values resolve to `true` and `built_in`.
- Browser profile: a persistent Electron partition derived from OS user plus
  canonical Rudder instance, without `orgId` in the key.
- Operator Browser tab: an organization-scoped exact working instance hosted
  by Side or Messenger Main using that profile.
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
- Side or Main Browser address/search input, including explicit canonical local
  absolute `file:///` URLs, and explicit `Open externally`.
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
   The first time an active Browser surface is shown in the Side Panel, Rudder
   shows a localized onboarding card explaining that Rudder starts with the
   Built-in Browser for web links and that the operator can choose the Built-in
   Browser or system default browser under `Settings > Desktop app > Browser`.
   `Browser settings` dismisses the card and opens that exact settings
   destination as an overlay while preserving the current route as its
   background. `Got it` dismisses the card in place. Either action records the
   one-time dismissal in local renderer storage and synchronizes it across
   active Browser surfaces; if durable storage is unavailable, a session
   fallback prevents repeat prompts for the current session. The card is not
   shown when the same Browser target is hosted in the Messenger Main
   Workbench.
   Operator Browser popup requests are intercepted into another tab on the
   surface that owns the source guest instead of creating an unrestricted guest
   window, even when ordinary Rudder links are configured to use the system
   browser. Agent-page popups are denied in V1; Agents open another tab through
   the audited Browser tool. Side and Main share at most eight live operator
   Browser guests per organization. At capacity, an ordinary Rudder link may
   focus an already mapped exact target, but a new, popup, or cold Saved View
   request is rejected or shown as a recoverable capacity state; Rudder never
   silently reuses or evicts an unrelated exact tab. Moving a live guest between
   Side and Main transfers ownership without increasing the count and must
   still succeed. Desktop accepts at most eight operator popup requests in a
   rolling ten-second window.
   Main-window same-origin navigation and redirects are revalidated before
   commit, so a cross-origin 30x is routed to Browser or denied rather than
   loading into the privileged Rudder renderer.
   An explicit operator submission in the Browser address bar may bootstrap a
   canonical local absolute `file:///` URL in that Browser tab. The allowlist
   requires an empty authority and an absolute decoded path, and rejects remote
   authorities (including `localhost`), UNC or UNC-equivalent paths (including
   encoded leading slash or backslash separators), and relative `file:` forms;
   rejected address input follows normal search-query handling. This bootstrap
   exception does not apply to renderer links or Browser-page popups, redirects,
   in-page navigation, or frame navigation, which remain HTTP(S)-only. A missing
   local file renders the normal Browser main-frame failure state in the same
   tab while preserving its attempted address and the current Rudder route.
4. Side, Main, and Agent Browser tabs use the same website profile. Switching
   organizations or restarting Desktop preserves cookies and site data, but a
   different Rudder instance uses a different profile. Operator tab/session
   ownership remains organization-scoped even though website identity is
   instance-scoped.
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
   `http:` or `https:` pages. Agent Browser open and navigate calls reject every
   `file:` target, including canonical local absolute forms accepted from the
   operator address bar. Each run may own at most eight Agent Browser tabs, and
   one Desktop process may own at most 32 Agent Browser tabs in total; an
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
| First Side Panel Browser onboarding | An active Side Panel Browser surface has no recorded dismissal | Explain the default and both link destinations; let the operator dismiss in place or jump directly to `Settings > Desktop app > Browser` without losing the background route | Do not show the card in Main Workbench, repeat it after dismissal, or send the operator to a generic settings landing page | Browser surface component tests and built-in Browser E2E |
| Built-in link | `openLinksIn=built_in`, external HTTP(S) URL, regardless of Agent Browser enablement | Open or focus a Side Panel Browser tab and preserve the current Rudder route | Do not replace the Rudder route or open the system browser because Agent Browser access is off | Side Panel E2E and Desktop smoke |
| Operator local-file address | Operator explicitly submits a canonical local absolute `file:///` URL with empty authority and a non-UNC decoded path | Bootstrap that target in the current Browser tab; preserve the Rudder route; show the normal in-tab failure state if the file is missing | Do not grant the file target Rudder renderer/API privileges or replace the Browser guest on failure | URL-policy tests, Browser E2E, and real Desktop smoke |
| Noncanonical file address | Explicit address input is remote-authority, `localhost`, UNC/UNC-equivalent, encoded-separator, or relative `file:` input | Treat the input as a search query instead of a local file navigation | Do not resolve or fetch a remote share or reinterpret a relative path as local authority | Side Panel URL normalization and profile-policy tests |
| Non-address or Agent file request | `file:` comes from a renderer link, page popup, redirect, in-page/frame navigation, or Agent Browser tool | Ignore or reject the request under the HTTP(S)-only boundary and keep the current page/tab ownership intact | The operator bootstrap exception must not become a page or Agent privilege escalation | Link-router, webview-policy, Broker smoke, and Desktop smoke tests |
| External preference or explicit escape | `openLinksIn=default_browser`, or operator selects `Open externally` | Open through the operating-system browser | Do not silently reopen the URL inside Rudder | Settings and link-router evidence |
| Supported Agent call | Browser enabled, supported local runtime, run-scoped Agent JWT, active run, owned tab | Execute the bounded action through the authenticated Broker | Model arguments or unsigned headers must not override identity, credential, or lease ownership | Auth, route, Broker, MCP, and adapter tests |
| Unsupported deployment or runtime | Deployment is not `local_trusted`, or adapter is not Claude/Codex/OpenCode/Pi local | Do not project a usable Browser capability; reject a stale unsupported-runtime API call with `browser_runtime_unsupported` | Skill, flag, and tools must not disagree or survive an ineligible fallback | Capability, organization skill, run-context, route, and fallback tests |
| Forged run context | Agent JWT run header differs from its signed `run_id`, or a long-lived Agent key supplies a run header | Reject before run lookup or Broker dispatch | One run must not impersonate another run of the same Agent | Auth middleware and Browser route tests |
| Cross-run tab call | Tab belongs to another org, agent, or run | Reject without revealing tab content | Shared cookies must not grant shared tab control | Browser route/Broker tests |
| Browser unavailable | Enabled but no healthy local Desktop Broker | Return stable `browser_unavailable` | The run must not hang or receive a false success | Browser route tests |
| Agent Browser disabled | Capability is off at projection or call time | Remove the skill and tools from later run projections; reject current calls with `browser_disabled`; revoke Agent tabs while preserving operator tabs and link routing | A stale run snapshot must not retain control, and Agent enablement must not override `openLinksIn` | Skill reconciliation, adapter, link-router, Side Panel E2E, and Desktop smoke tests |
| Operator tab capacity | Side plus Main already own eight live Browser guests for the organization | Live Side-to-Main transfer succeeds; ordinary links may reuse an eligible tab; popup/new/cold-open requests fail visibly | Do not create guest nine, block a transfer, or evict/reuse an unrelated exact tab | Main reducer, Side capacity, popup, and packaged Desktop tests |
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

On the first active Side Panel Browser surface, the operator also sees a
localized, one-time onboarding card with `Browser settings` and `Got it`
actions. The settings action opens the Browser subsection directly rather than
requiring the operator to find it from the general settings landing page.

The runtime agent sees the read-only `Browser` skill and the eight typed Browser
tools only when Rudder resolves the capability for the run. Tool arguments
contain action inputs such as URL, tab id, element reference, or text, but not
organization, agent, run, API, or Broker credentials.

When an operator Side or Main Browser surface owns keyboard focus, Desktop reserves the
platform browser mappings for reload, reload ignoring cache, new tab, location,
back, forward, zoom in, zoom out, and zoom reset. Browser visibility alone does
not establish this scope: focus in Chat, Library, a dialog, or another Rudder
surface leaves the command with Rudder or the native shell. Close-tab dispatch
targets the actual owning Side or Main tab and must not close the Desktop shell.

### Operator-Visible Output

- Browser Side Panel tabs keep the current Rudder route visible, while Browser
  Main tabs fill the Messenger work area directly beneath the mixed Main tab
  strip. Both expose address/search, navigation, reload, close, and explicit
  external-open actions.
  The first Side Panel appearance additionally shows the compact Browser
  onboarding card until either action dismisses it.
  Canonical local files use the same tab shell; missing files show the attempted
  address and actionable main-frame failure state without replacing the route.
- Focused Browser tabs accept `Command` on macOS or `Ctrl` elsewhere with `R`,
  `Shift+R`, `T`, `L`, `[`, `]`, `+`, `-`, and `0`. Location focus selects the
  current address. Zoom is per operator tab, spans 25% through 500%, and shows
  a percentage in the Browser title row whenever it is not 100%.
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

2. Explicit local-file inspection:
   - Trigger: operator enters a canonical local absolute `file:///` URL in the
     Browser address bar, then enters a missing local-file URL.
   - Expected state/action: the existing Browser tab loads the first file and
     keeps the second attempted address while showing `ERR_FILE_NOT_FOUND`.
   - Visible output: local content and title are inspectable beside the unchanged
     Rudder route; the missing-file case remains recoverable in the same tab.
   - Evidence: Browser URL-policy tests, Browser E2E, and real Desktop smoke.

3. File-navigation boundary:
   - Trigger: a page, renderer link, or Agent Browser call requests a `file:` URL,
     or the operator enters a remote-authority, UNC-equivalent, or relative form.
   - Expected state/action: page/renderer/Agent requests are rejected; invalid
     address forms become searches instead of file navigation.
   - Visible output: the current page and Rudder route remain intact, with no
     unauthorized Side Panel or native-window target.
   - Evidence: profile, webview-policy, link-router, Broker, and Desktop smoke
     tests.

4. Cross-organization session reuse:
   - Trigger: operator signs in to a website, switches organizations, and opens
     that site again.
   - Expected state/action: website identity remains signed in while panel tab
     state follows normal Side Panel session rules.
   - Visible output: the destination site sees the same local Browser session.
   - Evidence: shared partition and organization-switch acceptance test.

5. Isolated Agent control:
   - Trigger: one active run attempts to read a tab opened by another run.
   - Expected state/action: Rudder rejects the unowned tab request.
   - Visible output: stable safe error; no tab content or credential disclosure.
   - Evidence: Browser route and Broker isolation tests.

6. Disable and re-enable:
   - Trigger: operator disables Agent Browser access, opens a Rudder web link,
     then later enables Agent access again.
   - Expected state/action: Agent tabs and leases close immediately; later runs
     lose the skill/tools; operator tabs and saved website data remain available.
   - Visible output: the link continues to follow the saved `openLinksIn`
     preference while Agent access is disabled.
   - Evidence: settings, skill reconciliation, runtime, and Desktop tests.

7. Focused operator keyboard control:
   - Trigger: operator focuses a Browser tab, toolbar, address field, or page and
     invokes a reserved browser shortcut.
   - Expected state/action: Desktop suppresses its native accelerator and routes
     the action only to the active operator Browser tab; hidden tabs and Agent
     Browser guests do not receive it.
   - Visible output: page navigation, tab creation, address selection, or zoom
     occurs without reloading, closing, or zooming the Rudder shell.
   - Evidence: shared and Desktop resolver tests, Side/Main component tests,
     Side Panel E2E, and packaged Desktop smoke.
8. Exact Side-to-Main transfer:
   - Trigger: operator moves a live Browser tab into Messenger while sibling
     Side tabs remain.
   - Expected state/action: the same guest and `webContentsId` acquire the Main
     host lease without increasing live Browser count.
   - Visible output: the page fills Main with its history, form, scroll, and
     zoom intact; siblings remain in Side.
   - Evidence: Main promotion tests and packaged Desktop Browser smoke.

9. First-use Browser destination guidance:
   - Trigger: operator opens an active Browser surface in the Side Panel before
     dismissing Browser onboarding.
   - Expected state/action: Rudder explains the default Built-in Browser
     behavior and both supported link destinations. `Browser settings` records
     dismissal and opens `/instance/settings/browser` over the current route;
     `Got it` records dismissal without navigation.
   - Visible output: the onboarding card appears only in Side Panel, does not
     recur after dismissal, and never overlays the same Browser target in Main.
   - Evidence: Browser surface component tests and built-in Browser E2E.

### Invariants / Non-Goals

- Rudder Account authentication and Browser capability are independent. A
  normal authenticated browser never receives Desktop Bridge or Broker access
  from its account session alone. Formal Local Board and CLI paths require the
  user session plus the existing Desktop/run capability checks.
- Sign-out or global account revocation removes authenticated Board/Browser/CLI
  admission, but it does not implicitly delete the Desktop-owned Browser
  profile or website data.
- Profile identity is OS user plus canonical Rudder instance, never
  organization. Shared profile data must be disclosed before import and clear.
- `openLinksIn` controls operator link routing only. Selecting the system
  browser must not disable the Agent Browser skill or tools, and must not send
  popup requests from an already-open Rudder Browser tab to the system browser.
- Agent Browser enablement controls Agent skill/tool and import admission only.
  It must not close operator Browser tabs, hide the operator Browser target, or
  override the independently persisted `openLinksIn` destination.
- Agent tab/control identity is always `orgId + agentId + runId + tabId`;
  operator live identity is organization plus exact `viewInstanceId`. Profile
  sharing never weakens either ownership model.
- Operator Browser capacity is eight live guests across Side and Main per
  organization. A live transfer does not increase usage and cannot be rejected
  at the limit. New tabs, popups, and cold Saved View opens fail visibly at the
  limit; Rudder does not silently reuse or LRU-evict an unrelated exact tab. A
  focused new-tab shortcut is still consumed at the limit so it cannot create a
  native shell tab. Operator popups are limited to eight per rolling ten
  seconds per Desktop process.
- Operator page zoom is in-memory and per Browser tab. It does not scale the
  Rudder shell, cross tab boundaries, persist across restart, or add an Agent
  Browser zoom tool. Blank or not-yet-ready tabs safely consume unsupported
  page actions without invoking Electron webview methods.
- Agent Browser capacity is eight tabs per run and 32 tabs per Desktop process.
  Capacity never weakens run ownership or creates an implicit cross-run reuse.
- Browser guests do not share the Rudder UI/API session partition and run
  sandboxed without Node integration, untrusted preload, unrestricted popups,
  permissions, downloads, or non-web protocol navigation by default.
- Canonical local absolute `file:///` navigation is an operator-address-bar
  bootstrap exception only. Remote authorities, `localhost`, UNC and encoded-
  separator equivalents, and relative `file:` forms are not local-file targets.
- Renderer links, Browser-page popups, redirects, in-page/frame navigation, and
  Agent Browser tools remain HTTP(S)-only and must never inherit the operator
  local-file bootstrap exception.
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

Update this contract when changing default enablement/link destination,
first-use Browser onboarding or its settings destination, profile or tab
ownership scope, supported link protocols, clear/disable lifecycle, import
platforms/data types, Browser skill/tool names or projection, runtime
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
