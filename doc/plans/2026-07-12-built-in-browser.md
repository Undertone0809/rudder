---
title: Rudder Built-in Browser
date: 2026-07-12
kind: proposal
status: completed
area: desktop
entities:
  - built_in_browser
  - browser_profile
  - browser_skill
  - browser_data_import
issue:
related_plans:
  - 2026-06-30-chat-side-panel.md
  - 2026-07-01-global-side-panel-workbench.md
supersedes: []
related_code:
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - desktop/src/browser-profile.ts
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-agent-tabs.ts
  - desktop/src/browser-import-snapshot.ts
  - desktop/src/browser-cookie-import-worker.ts
  - desktop/src/browser-cookie-import.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/navigation-guard.ts
  - desktop/src/browser-broker-registration.ts
  - desktop/src/browser-broker-server.ts
  - desktop/src/browser-popup-rate-limit.ts
  - server/src/services/instance-settings.ts
  - server/src/services/browser-broker.ts
  - server/src/services/browser-capability.ts
  - server/src/routes/browser.ts
  - server/src/services/runtime-kernel/model-fallback.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/services/agent-run-context.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - cli/src/agent-v1-mcp-server.ts
  - ui/src/context/SidePanelContext.tsx
  - ui/src/components/DesktopBrowserLinkBridge.tsx
  - ui/src/lib/desktop-browser-link-router.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
commit_refs:
  - 5d44a2b29cf30fc69f2201b695076bc3e7e69c94
updated_at: 2026-07-12
---

# Rudder Built-in Browser

## Overview

Add a first-party Browser to Rudder Desktop that serves both the operator and
Rudder-managed agents.

The operator can open web links without leaving Rudder, manage Browser settings,
clear all Browser data, and import cookies from a supported local Chromium
profile. Agents receive a Rudder-managed `Browser` skill and high-level Browser
tools by default, backed by the same persistent Browser profile.

The profile is scoped to the current local Rudder instance and operating-system
user. All organizations in that instance intentionally share cookies, signed-in
website sessions, cache, and site data. Tabs and control leases remain isolated
by agent run even though identity state is shared.

## What Is The Problem?

Rudder already has a Browser target in the global Side Panel, but it is an
unmanaged Electron `<webview>`:

- it uses the default Electron session rather than an instance-specific Browser
  profile;
- normal web links still leave Rudder through the system browser;
- the Browser has no instance settings, data reset, or import workflow;
- bundled skills are currently either always loaded or manually selected, so
  there is no capability-gated `Browser` skill;
- agents have no first-party, runtime-owned Browser tools;
- the current guest view permits popups and lacks the security policy required
  for a shared authenticated profile.

This prevents the Side Panel Browser from becoming a dependable product
surface, and it prevents agents from using browser automation as a standard
Rudder capability.

## Product Decisions

1. **Built-in by default.** Rudder Browser is enabled by default in Rudder
   Desktop.
2. **Built-in links by default.** Web links opened from Rudder default to the
   Rudder Browser. The operator can switch the destination to the system
   browser.
3. **One profile per local instance.** The profile scope is current OS user plus
   canonical Rudder instance. `orgId` is deliberately not part of the profile
   key.
4. **Shared identity, isolated control.** Organizations share cookies and login
   state, while agent tabs and leases are keyed by organization, agent, run, and
   tab.
5. **Skill and tools are one capability.** In `local_trusted` mode, enabling
   Browser activates the bundled `Browser` skill for organization inventory.
   Supported local runtimes receive that skill, the capability flag, and Browser
   tools together. Disabling or becoming runtime-ineligible removes the whole
   capability and revokes current control.
6. **Runtime-managed rather than copied.** Rudder does not write one Browser
   skill assignment per organization or agent. It resolves an active bundled
   capability on each inventory and run-context reconciliation.
7. **Import must be real.** The first importer supports cookies from discovered
   local Chromium profiles on platforms where Rudder can decrypt them safely.
   Unsupported data is reported explicitly and never counted as imported.

## What Will Be Changed?

### Settings

Add `Settings > Desktop app > Browser` with:

- `Enable Rudder Browser`;
- `Open web links from Rudder in` with `Rudder Browser` and `Default browser`;
- `Import...`;
- `Clear all browsing data`.

The page states that browsing data and signed-in website sessions are shared by
all organizations and agents in the current Rudder instance.

### Operator Browser

- Move Side Panel Browser webviews onto a dedicated persistent Electron
  partition.
- Route normal external `http:` and `https:` links through one application link
  router.
- Open built-in links as Browser Side Panel tabs without changing the current
  Rudder route.
- Keep an explicit `Open externally` command that always uses the system
  browser.
- Apply a guest navigation, popup, permission, download, and protocol policy.
- Revalidate main-window redirect targets so external 30x destinations never
  load into the privileged Rudder renderer.
- Bound each Side Panel context to eight Browser tabs. At capacity, ordinary
  Rudder links reuse an existing Browser tab, while popup and explicit new-tab
  requests are discarded. Accept at most eight popups per rolling ten seconds.

### Browser Data

- Discover supported local browser profiles without reading their data until
  the operator starts an import.
- Show a source picker and data-type selection dialog based on detected
  capabilities.
- Import cookies into the Rudder Browser partition and return imported,
  skipped-existing, skipped-invalid, and failed counts.
- Clear cookies, cache, storage, service workers, HTTP auth state, and site
  permissions with Electron's exhaustive session clear after immediately
  stopping admission, closing Browser tabs, and revoking agent leases.

### Agent Capability

- Add `server/resources/bundled-skills/browser/SKILL.md` with Browser operating
  guidance and safety boundaries.
- Make `Browser` a capability-gated bundled skill that is read-only, projected
  for every organization in an enabled `local_trusted` instance, and loaded only
  for supported Claude/Codex/OpenCode/Pi local runs.
- Extend the first-party `rudder-control-plane` MCP/native bridge with high-level
  Browser tools rather than creating a second duplicated transport.
- Derive organization, agent, and run identity from runtime-owned context. Tool
  arguments cannot override identity or broker credentials.
- Enforce deployment, current Browser setting, and runtime eligibility again at
  tool-call time and return stable `browser_disabled`,
  `browser_runtime_unsupported`, or `browser_unavailable` errors.

## Success Criteria For Change

- A fresh Rudder Desktop instance reports Browser enabled and opens Rudder web
  links in the Side Panel Browser by default.
- The operator can switch link destination to the system browser and the choice
  persists across restart.
- Browser cookies and site data persist across Side Panel tabs, organization
  switches, and Desktop restart, but do not cross Rudder instances.
- Disabling Browser immediately closes Browser tabs, revokes agent leases, and
  routes later links externally without deleting Browser data.
- Clearing Browser data signs the shared profile out of websites across all
  organizations while preserving Browser settings.
- The Import dialog discovers supported local Chromium profiles, imports valid
  cookies, preserves existing destination cookies, and reports partial failure
  accurately.
- Every existing and future organization in an enabled `local_trusted` instance
  exposes the read-only bundled `Browser` skill.
- Every supported local runtime receives Browser tool definitions and
  runtime-owned identity. The server rejects disabled, unavailable, cross-run,
  unsupported-runtime, unsafe-protocol, capacity, and invalid-tab calls.
- E2E coverage exercises Settings, global link routing, organization sharing,
  disable/clear behavior, and the Import dialog. Packaged Desktop verification
  exercises the real Electron partition and link route.

## Out Of Scope

- Importing saved passwords in this slice. Standard Electron does not expose a
  supported password-store import or autofill API. This requires a separately
  governed Rudder password manager or a maintained native Chromium importer.
- Importing full browser history, bookmarks, extensions, or downloads.
- Treating every organization as a separate browser identity.
- Exposing raw cookies, tokens, Chromium profile paths, arbitrary JavaScript, or
  unrestricted CDP to agents.
- Making Agent-created tabs globally shareable or concurrently controllable.
- Replacing the user's daily system browser in this slice.
- Merging this feature with the Local Browser MCP proposal. That proposal
  controls an external Chrome installation and should remain a separate future
  `External Chrome Connector` capability.

## Non-Functional Requirements

### Security

- Browser profile storage must not share the default Rudder UI/API session.
- Only `http:` and `https:` navigation is allowed. `file:`, `javascript:`,
  `data:`, `devtools:`, Rudder control-plane origins, and arbitrary custom
  protocols are rejected.
- Browser guests run with sandboxing, context isolation, no Node integration,
  no untrusted preload, no unrestricted popup creation, and denied permissions
  by default.
- Browser tools expose navigation, reading, clicking, typing, screenshot, tab,
  and close operations only.
- Agent Browser tabs are capped at eight per run and 32 per Desktop process.
- Broker credentials remain in Desktop/server memory and are never injected
  into model-visible prompts or tool arguments.
- Activity evidence records organization, agent, run, tab, action, and sanitized
  origin without logging query tokens, cookies, form values, or page content.

### Reliability

- Browser setting defaults are applied when no row or legacy field exists.
- Tool-call authorization checks the live setting instead of trusting only the
  run-start snapshot.
- A missing Desktop Broker produces `browser_unavailable`; it must not hang an
  agent run.
- Import is partial-success safe and does not overwrite existing Rudder Browser
  cookies.
- An open source browser fails before copy with an actionable, sanitized close-
  and-retry message. No source path or raw worker error reaches the renderer.
- Disable and clear revoke guests immediately rather than waiting behind an
  in-flight import; clear waits before final exhaustive session removal.
- Graceful Desktop quit closes import admission, aborts the active import
  worker, and waits for its temporary snapshot cleanup before stopping the
  local runtime. Startup removes only dead, current-instance import snapshots;
  live and foreign-instance snapshots are preserved.

### Maintainability

- Operator Browser, Browser Broker, profile import, link routing, and MCP
  dispatch have separate modules and focused tests.
- Browser activation uses one shared capability resolver for skill loading and
  tool availability.
- Platform-specific import code is isolated behind a source adapter.

### Usability And Accessibility

- Settings and Import dialog controls are keyboard reachable and visibly
  labeled.
- Import progress, success, partial success, cancellation, and errors are
  visible without raw platform stack traces.
- Destructive clear behavior requires confirmation and names the cross-
  organization logout impact.

## User Experience Walkthrough

### Default Link Flow

1. The operator clicks an external web link anywhere in Rudder.
2. Rudder keeps the current workspace route open.
3. The global Side Panel opens a Browser tab with the requested URL.
4. Additional links open or focus Browser Side Panel tabs.
5. `Open externally` sends the active page to the system browser.

### Change Link Destination

1. The operator opens `Settings > Desktop app > Browser`.
2. The page shows Browser enabled and `Rudder Browser` selected.
3. The operator selects `Default browser`.
4. Later web links leave Rudder through the operating system browser.
5. Agent Browser capability remains enabled because link destination and Agent
   capability are separate settings.

### Import Browser Data

1. The operator clicks `Import...`.
2. Rudder discovers supported local browser profiles and opens a dialog modeled
   after the Codex import flow.
3. The operator chooses a browser profile and supported data types.
4. Rudder explains that imported signed-in sessions become available to every
   organization and agent in this instance.
5. The operator starts import. The source database is copied to a private,
   instance-owned temporary directory before read access so the source browser
   is not modified.
6. Rudder imports valid cookies, preserves existing destination cookies, cleans
   temporary files on success, failure, cancellation, or graceful quit, and
   reports detailed counts.
7. After a process crash, the next startup removes dead snapshots owned by that
   same instance without touching a live or foreign-instance import.

### Disable And Clear

1. Disabling Browser closes Browser Side Panel tabs and active Agent Browser
   tabs, then removes Browser skill/tool access from future runs.
2. Existing cookies and site data remain on disk for later re-enable.
3. `Clear all browsing data` closes tabs, revokes leases, clears the persistent
   partition, and signs every organization out of imported websites.
4. Browser enabled state and link-destination preference are not reset.

### Agent Browser Flow

1. A run starts while Browser is enabled.
2. Rudder realizes the bundled `Browser` skill and first-party Browser tools for
   the runtime.
3. The agent opens a tab. Runtime-owned organization, agent, and run identity
   becomes the lease owner.
4. The agent navigates, reads a structured page snapshot, clicks, types, or
   captures a screenshot through high-level commands.
5. Another run cannot access that tab even though both runs share website
   cookies.
6. The tab closes on explicit close, run cleanup, disable, clear, or Desktop
   shutdown.

## Implementation

### Product Or Technical Architecture Changes

```text
Settings API
  -> instance Browser settings
  -> Browser capability resolver
     -> conditional bundled Browser skill
     -> conditional Browser MCP/native tools
     -> live server-side enable check

Rudder link click
  -> Desktop link router
  -> renderer SidePanelContext
  -> Browser target
  -> instance-scoped Electron partition

Agent Browser tool
  -> rudder-control-plane MCP/native bridge
  -> authenticated Rudder Browser API
  -> in-memory Desktop Broker registration
  -> run-owned hidden Browser tab
  -> shared Electron partition

Import dialog
  -> Desktop IPC
  -> platform browser source adapter
  -> copied source cookie database
  -> destination Electron cookie store
```

### Browser Settings Model

```ts
type InstanceBrowserSettings = {
  enabled: boolean; // default true
  openLinksIn: "built_in" | "default_browser"; // default built_in
};
```

Browser settings are instance-scoped server state so background runs and every
organization resolve the same capability. Browser data itself lives only in the
Desktop partition.

### Persistent Profile

The Electron partition is derived from the canonical Rudder instance id or root
and never includes an organization id:

```text
persist:rudder-browser-v1-<sanitized-or-hashed-instance-id>
```

The implementation must configure partition policy before any Browser guest or
agent tab is created.

### Link Router

The application distinguishes two commands:

- `openWebLink(url)`: respect Browser settings;
- `forceOpenExternal(url)`: explicit system-browser escape hatch.

Electron main intercepts new-window requests and sends supported web links to a
renderer bridge. The bridge reads current Browser settings and opens a Browser
Side Panel target or calls the force-external IPC. Same-origin Rudder routes stay
in the app, and non-web protocols keep their existing system behavior.

### Desktop Broker

Desktop owns a loopback-only Browser Broker with a random in-memory credential.
It registers its endpoint and credential with the local Rudder server after
startup. The server keeps registration in memory and never returns the broker
credential to clients or agents.

V1 keeps one active Broker registration. A later valid same-instance
`local_trusted` instance-admin registration replaces the previous registration;
token-matched unregister prevents stale shutdown from clearing the replacement,
but generation and owner binding are deferred.

Agent Browser requests pass through an authenticated Rudder API so the server
derives organization, agent, and run identity. The server checks the live
Browser setting, sanitizes evidence, and forwards only the allowed command to
the Broker.

Browser authorization requires a run-scoped Agent JWT. The signed `run_id` is
authoritative; an optional `X-Rudder-Run-Id` header must match it and cannot
override it. Long-lived Agent API keys cannot obtain Browser access by naming a
run. This prevents one concurrent run of an Agent from impersonating another.

### Runtime Tool Surface

V1 tool names:

- `rudder_browser_tabs`
- `rudder_browser_open`
- `rudder_browser_navigate`
- `rudder_browser_read`
- `rudder_browser_click`
- `rudder_browser_type`
- `rudder_browser_screenshot`
- `rudder_browser_close`

The tools reuse the existing first-party `rudder-control-plane` transport.
`codex_local`, `claude_local`, `opencode_local`, and `pi_local` receive the same
managed identity boundary. Other adapters and remote runtimes do not receive the
Browser skill, capability flag, or tools, and stale unsupported-runtime calls
return `browser_runtime_unsupported` rather than a false promise of local
Desktop control.

### Capability-Gated Bundled Skill

Bundled skills are split conceptually into:

```text
always bundled
  + capability-bundled Browser when local_trusted && browser.enabled
  + run materialization when adapter is Claude/Codex/OpenCode/Pi local
  = active bundled skills and tools for this run
```

The Browser projection remains Rudder-managed and read-only. Disabling removes
the projection during the next organization reconciliation and prevents runtime
materialization immediately. Model fallback recomputes the same gate and removes
the Browser skill, capability flag, skill sync, and tools together when the
fallback runtime is unsupported.

### Cookie Import

The first source adapter targets macOS Chromium profiles such as Google Chrome,
Microsoft Edge, and Brave Browser. It:

1. reads profile display metadata;
2. copies the selected profile's Cookies database and WAL companions to a
   temporary directory;
3. asks macOS Keychain for the source browser's Safe Storage secret when needed;
4. decrypts supported cookie formats locally;
5. validates scheme, host, path, expiry, SameSite, and secure fields;
6. preserves existing destination cookies;
7. writes valid cookies through Electron's supported `session.cookies` API;
8. removes temporary copies on normal, error, cancellation, and graceful-quit
   paths; startup safely reaps dead same-instance crash residue.

No imported cookie value crosses the renderer or Rudder server API.

### Breaking Change

No public API breaking change is intended. Existing external-browser behavior
changes only because the new default destination is Rudder Browser. Operators
can restore the previous behavior in Settings.

## Security

New local endpoints are loopback-only and authenticated with an in-memory
credential. Agent requests enter through the existing Rudder API authentication
boundary and never accept model-supplied organization, agent, run, API, or
broker identity.
Every credential-bearing Browser hop rejects HTTP redirects, including Desktop
registration/lifecycle requests to the local API and server requests to the
Desktop Broker.

The Agent Browser route accepts only a run-scoped Agent JWT. A mismatched run
header is rejected before run lookup, and a long-lived Agent API key cannot
bootstrap Browser authority from an unsigned run header.

The importer reads only the explicitly selected local profile. It does not
modify the source browser, upload data, or persist raw cookie databases. Cookie
values are written directly from Desktop main into Electron's cookie store.

Imported authenticated sessions are deliberately shared across organizations.
The Settings page and Import confirmation must disclose that trust decision.

## Delivery Phases

### Phase 1: Product Contract And Settings

- land this proposal and Product Logic contracts;
- add persisted Browser settings with default-on semantics;
- add Settings navigation, page, import dialog states, and API tests.

### Phase 2: Operator Browser Foundation

- create and secure the persistent partition;
- implement global link routing and force-external escape;
- implement disable and clear lifecycle;
- add Browser Side Panel and packaged Desktop proof.

### Phase 3: Import

- implement source discovery and macOS Chromium cookie import;
- add fixture-based decryption/import tests and visible partial-success results;
- verify source data is never modified or returned to the renderer.

### Phase 4: Agent Capability

- add the bundled Browser skill and capability resolver;
- add Browser API, Broker, tool manifest, CLI fallback, and runtime injection;
- verify one real local Agent run plus cross-run isolation and disabled cases.

### Phase 5: Password Import Follow-Up

- decide between a Rudder-owned encrypted credential vault with autofill and a
  maintained native Chromium importer;
- add explicit approval, OS security, migration, clear, and breach-boundary
  contracts before importing any saved password.

## What Is Your Testing Plan (QA)?

### Goal

Prove that Browser defaults, persistence, link routing, data boundaries, import,
skill loading, tool identity, and cleanup work through the real Desktop and
Agent paths.

### Prerequisites

- a disposable Rudder Desktop instance;
- two disposable organizations;
- a synthetic Chromium profile fixture containing valid, expired, malformed,
  duplicate, and encrypted cookies;
- at least one MCP-capable local runtime;
- no use of the operator's real browser profile in automated tests.

### Test Scenarios / Cases

1. Default Browser settings are enabled and select Rudder Browser.
2. Settings persist and are shared across organizations.
3. A Rudder web link opens a Side Panel Browser tab; system mode uses the
   external escape path.
4. Same-origin routes and unsupported protocols are not misrouted.
5. Browser profile data persists across organization switches and restart.
6. Different Rudder instance ids do not share Browser data.
7. Disabling closes tabs, revokes leases, hides skill/tools, and preserves data.
8. Clear removes Browser data but preserves settings.
9. Import discovery lists fixture profiles and never reads cookies before the
   operator starts import.
10. Import preserves existing cookies and reports valid, expired, malformed,
    unsupported-encryption, and write-failure results.
    An open source browser produces an actionable sanitized close-and-retry
    result.
11. Browser skill is realized for every agent when enabled and absent when
    disabled.
12. Browser tools derive identity from a run-scoped JWT, reject mismatched or
    unsigned run headers and reserved identity arguments, enforce live enabled
    state, reject unsafe URLs, and isolate tabs by run.
13. Packaged Desktop smoke opens a real webview on the dedicated partition and
    proves clear/persistence behavior.
14. Side Panel contexts enforce the eight-tab cap and popup rate limit; Agent
    tabs enforce the eight-per-run and 32-per-process caps.
15. Deployment/runtime eligibility and model fallback keep Browser skill, flag,
    sync, tools, and API authorization consistent.
16. Main-window cross-origin redirects are intercepted before commit, and clear
    removes cookies, local storage, and CacheStorage through the real Electron
    partition.
17. The Import dialog shows Cookies as supported, shows Passwords as unavailable,
    and never sends a password-import field to Desktop.
18. Graceful quit during import aborts the worker and waits until its raw
    snapshot is removed before runtime shutdown.
19. Startup removes dead same-instance import residue while preserving live
    same-instance and foreign-instance temporary directories.
20. Both Desktop-to-server lifecycle requests and server-to-Desktop Broker
    command requests reject redirects before forwarding credentials or bodies.

### Expected Results

All supported paths return explicit success or stable error states. No test
reads the user's real browser data, exposes cookie values in logs, or relies on
unit tests as a substitute for packaged Desktop and Agent-path acceptance.

### Pass / Fail

- Product logic: PASS. `pnpm product-logic:check` validated 67 contracts.
- Unit and integration checks: PASS for the Browser delivery. The clean
  pre-reconciliation serial Vitest run completed 494 files with 3,927 passed
  and 2 skipped tests. After adding four final reconciliation tests, the full
  serial rerun reached 493/494 files with 3,928 passed and 2 skipped; one
  unrelated asynchronous issue-lifecycle wakeup assertion was flaky, and that
  complete file passed 67/67 on immediate isolated rerun. The final
  popup/import-state reconciliation packet passed 9/9 focused tests. A parallel
  `pnpm test:run` also hit 14 unrelated five-second git/worktree or readiness
  timeouts; all three affected files passed 27/27 on serial isolated rerun.
- Browser E2E: PASS. The focused Browser, Agent integrations, and full nearest
  Side Panel packet passed 17/17. The runtime-managed Browser skill scenarios
  passed 2/2. The final Built-in Browser rerun, including system-browser popup
  routing and disabled Import, passed 2/2.
- Packaged Desktop verification: PASS. `pnpm desktop:verify` completed dev smoke,
  packaging, server-package verification, packaged clean smoke, and upgrade
  smoke. The packaged acceptance scenario covered the real Electron partition,
  import, organization sharing, instance isolation, restart persistence,
  disable preservation, clear, Side Panel webview, and Agent MCP discovery plus
  open/read/close.
- Spawned product verifier: PASS. The independent verifier reproduced the
  packaged Desktop, Browser/Settings, Side Panel, skill, lifecycle, race, and
  authorization acceptance paths with no handoff blocker.
- Final functional, adversarial, and heuristic reviews: PASS. All three
  reviewers returned `accept`; the heuristic review's popup-routing and
  disabled-Import revisions were implemented, tested, and accepted on rerun.
- Full repository E2E: not clean. The broad run reported 331 passed and 131
  failed. Read-only triage found one Browser-caused stale tool-count assertion,
  which was corrected from 69 to 77; the remaining failures were existing
  branch/test drift outside the Browser path. Browser, Settings, skill, and
  complete nearest Side Panel suites pass independently.

## Documentation Changes

- Add a dedicated Browser Product Logic Contract.
- Update `ORG.SETTINGS.001`, `AGENT.SKILLS.001`,
  `AGENT.INSTRUCTIONS.001`, and `AGENT.CONTROL.TOOLS.001` traceability and
  behavior where applicable.
- Add new Browser contract ids to `doc/product/registry.yml`.
- Keep the Local Browser MCP proposal separate and clarify that it is an
  external Chrome connector rather than Rudder Browser.
- Update Desktop engineering documentation for the partition, Broker, import,
  and packaged verification path.

## Open Issues

- Password import needs a separate security and storage decision; it is not
  represented as working in this proposal.
- Windows Chromium App-Bound Encryption and Linux keyring variants need native
  source adapters before those platforms can claim cookie import parity.
- Remote runtimes cannot control a local Desktop Browser unless a future secure
  remote Broker transport is designed.
- V1 permits another same-instance `local_trusted` instance-admin Desktop/client
  to replace the active in-memory Broker registration. Broker generation and
  owner binding remain a hardening follow-up.
- A future permission page may add per-origin and external-side-effect approval
  policies without changing the shared-profile decision.
