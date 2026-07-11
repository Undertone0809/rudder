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
  - desktop/src/browser-cookie-import.ts
  - desktop/src/main.ts
  - server/src/services/instance-settings.ts
  - server/src/services/browser-broker.ts
  - server/src/routes/browser.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - cli/src/agent-v1-mcp-server.ts
  - cli/src/commands/client/browser.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/components/BrowserDataImportDialog.tsx
related_tests:
  - desktop/src/browser-profile.test.ts
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-webview-policy.test.ts
  - desktop/src/browser-cookie-import.test.ts
  - server/src/__tests__/browser-routes.test.ts
  - server/src/services/browser-broker.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - server/src/__tests__/organization-skills-reference.test.ts
  - cli/src/__tests__/agent-v1-mcp-server.test.ts
  - cli/src/__tests__/browser-command.test.ts
  - ui/src/pages/InstanceBrowserSettings.test.tsx
  - ui/src/components/BrowserDataImportDialog.test.tsx
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
   Browser is enabled and `openLinksIn` is `built_in`. The current Rudder route
   stays in place. The explicit external command always uses the system browser.
   Browser popup requests are intercepted into another Browser tab instead of
   creating an unrestricted guest window.
4. Side Panel and Agent Browser tabs use the same website profile. Switching
   organizations or restarting Desktop preserves cookies and site data, but a
   different Rudder instance uses a different profile.
5. When Browser is enabled, organization skill reconciliation exposes the
   read-only bundled `Browser` skill. Supported local adapters receive the same
   capability flag and Browser tools through managed runtime config.
6. A Browser tool call derives organization, agent, run, API, and Broker
   identity from Rudder-owned context, validates the active run and live Browser
   setting, and permits access only to tabs leased to that exact run.
7. The Desktop Broker executes only the eight bounded actions against approved
   `http:` or `https:` pages. Tool activity records action and sanitized origin,
   never credentials, query tokens, form values, cookies, or page content.
8. On macOS, import discovery lists supported local Chromium profiles without
   reading cookie values. After operator confirmation, Desktop copies the
   selected cookie database, obtains required Keychain access, imports supported
   cookies without replacing existing destination cookies, cleans temporary
   copies, and reports imported, skipped, and failed counts.
9. Disabling Browser immediately closes operator and Agent Browser tabs, revokes
   leases, routes later links to the system browser, and removes Browser skill
   and tool access. It preserves profile data and link preference for re-enable.
10. Clearing Browser data closes all Browser tabs, revokes leases, and removes
    cookies, cache, storage, service workers, HTTP auth state, and site
    permissions. It preserves `enabled` and `openLinksIn` settings.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Fresh Desktop instance | No saved Browser fields | Browser is enabled and Rudder web links use the Side Panel Browser | Legacy absence must not disable the capability or default links externally | Settings service/UI tests |
| Built-in link | Enabled, `openLinksIn=built_in`, external HTTP(S) URL | Open or focus a Side Panel Browser tab and preserve the current Rudder route | Do not replace the Rudder route or open the system browser as the primary action | Side Panel E2E and Desktop smoke |
| External preference or explicit escape | `openLinksIn=default_browser`, Browser disabled, or operator selects `Open externally` | Open through the operating-system browser | Do not silently reopen the URL inside Rudder | Settings and link-router evidence |
| Supported Agent call | Browser enabled, supported local runtime, active run, owned tab | Execute the bounded action through the authenticated Broker | Model arguments must not override identity, credential, or lease ownership | Route, Broker, MCP, and adapter tests |
| Cross-run tab call | Tab belongs to another org, agent, or run | Reject without revealing tab content | Shared cookies must not grant shared tab control | Browser route/Broker tests |
| Browser unavailable | Enabled but no healthy local Desktop Broker | Return stable `browser_unavailable` | The run must not hang or receive a false success | Browser route tests |
| Browser disabled | Capability is off at projection or call time | Hide/remove skill and tools; reject current calls with `browser_disabled`; revoke tabs | A stale run snapshot must not retain control | Skill reconciliation, adapter, and route tests |
| Cookie import | macOS supported Chromium source selected and operator confirms | Import supported cookies locally, preserve existing cookies, and report partial outcomes | Do not read before confirmation, modify the source, expose values, or claim password import | Desktop importer and dialog tests |
| Unsupported import | Non-macOS, unsupported encryption/data type, or password request | Show the capability as unavailable or count the item as unsupported/failed | Do not report unsupported data as imported | Importer and dialog tests |
| Clear data | Operator confirms shared-profile clear | Close tabs, revoke leases, clear profile data, preserve settings | Do not clear only the active organization or silently reset Browser preferences | Desktop profile/settings tests |

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
- Stable Agent errors distinguish disabled, unavailable, invalid URL/reference,
  and unowned-tab cases without exposing secret or page data.

### Persisted Evidence

- Instance Browser settings persist independently of any organization.
- Cookies and site data persist only in the dedicated instance Browser profile;
  Browser tabs, leases, Broker credentials, and copied import databases do not.
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
   - Trigger: operator disables Browser, later enables it again.
   - Expected state/action: active tabs and leases close immediately; later
     runs lose the skill/tools; saved website data returns on re-enable.
   - Visible output: links use the system browser while disabled.
   - Evidence: settings, skill reconciliation, runtime, and Desktop tests.

### Invariants / Non-Goals

- Profile identity is OS user plus canonical Rudder instance, never
  organization. Shared profile data must be disclosed before import and clear.
- `openLinksIn` controls operator link routing only. Selecting the system
  browser must not disable the Agent Browser skill or tools.
- Tab/control identity is always `orgId + agentId + runId + tabId`; profile
  sharing never weakens run ownership.
- Browser guests do not share the Rudder UI/API session partition and run
  sandboxed without Node integration, untrusted preload, unrestricted popups,
  permissions, downloads, or non-web protocol navigation by default.
- Only bounded high-level actions are agent-visible. Raw cookies, tokens,
  arbitrary JavaScript, unrestricted CDP, Broker credentials, and model-supplied
  identity are out of scope.
- V1 import is real local macOS Chromium cookie import only. Passwords, history,
  bookmarks, extensions, downloads, Windows/Linux encrypted cookie formats, and
  daily-browser replacement are not promised.
- Web deployments and remote runtimes do not receive a false promise of local
  Desktop Browser control. A future secure remote Broker requires a new
  contract decision.
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

- Packaged Desktop, cross-organization profile, disable/clear, global link
  routing, and real Agent-run acceptance evidence must be completed before this
  implementation is considered shipped.
- Password import and Windows/Linux cookie import require separate product and
  security decisions.
