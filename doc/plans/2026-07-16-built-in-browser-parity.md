---
title: Built-in Browser MCP separation and Codex Browser parity
date: 2026-07-16
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - built_in_browser
  - browser_mcp
  - browser_automation
issue:
related_plans:
  - 2026-07-12-built-in-browser.md
  - 2026-06-30-agent-v1-mcp-tools.md
supersedes: []
related_code:
  - cli/src/agent-v1-mcp-server.ts
  - cli/src/agent-v1-registry.ts
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtime-utils/src/rudder-mcp-server.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/codex-home.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - server/src/routes/browser.ts
  - server/src/services/browser-broker.ts
  - desktop/src/browser-agent-electron.ts
  - desktop/src/browser-agent-tabs.ts
  - desktop/src/browser-broker-server.ts
  - desktop/scripts/smoke.mjs
commit_refs:
  - "feat: separate Browser MCP runtime"
  - "test: verify isolated Browser runtime adapters"
  - "fix: isolate runtime MCP credentials per run"
  - "fix: clean up run-scoped MCP credentials"
updated_at: 2026-07-23
---

# Built-in Browser MCP Separation And Codex Browser Parity

## Objective

Give Rudder-managed agents the same browser task outcomes as the current Codex
in-app Browser API while preserving Rudder's run-scoped identity, live instance
disable, audit trail, bounded results, and Desktop-owned website profile.

Browser is a separate optional runtime integration. `rudder-tools`
must never expose Browser tools. An enabled, eligible run receives a second
`rudder-browser` MCP server (or the equivalent isolated native bridge for a
runtime without MCP configuration support). A disabled or ineligible run does
not receive or launch that server.

## Affected Product Logic

- `AGENT.BROWSER.001`: expand the bounded Agent Browser from eight actions to
  the Codex Browser parity surface and define live server disable semantics.
- `AGENT.CONTROL.TOOLS.001`: remove Browser projection from
  `rudder-tools` and introduce the separate `rudder-browser` transport.
- `AGENT.RUNTIME.PERMISSIONS.001`: keep Browser availability conditional and
  revoke the optional runtime transport when the instance capability changes.

The current task authorizes implementation, but it does not explicitly
authorize semantic edits under `doc/product/**`. Those guarded contract edits
remain a named approval item and must not be applied implicitly.

## Parity Contract

The acceptance target is task-outcome parity with the Browser API exposed by
the bundled Codex Browser plugin on 2026-07-16. Rudder may use different tool
names or a coarser typed action envelope, but every supported operation below
must be discoverable, executable, bounded, and covered by a real Browser test.

### Browser And Tab Lifecycle

- list run-owned tabs, create a tab, identify the selected tab, and close a tab
- read title and URL
- navigate, back, forward, reload, and wait for URL/load state
- set Browser visibility for live operator observation
- set, inspect, and reset an explicit responsive-test viewport
- enumerate operator Browser tabs only as privacy-safe hostname/origin
  summaries, without title, path, query, fragment, or credentials

### Page Understanding And Locators

- return a bounded DOM/accessibility snapshot with stable node references
- include same-origin and permitted cross-origin frame structure where Electron
  can expose it safely
- locate by test id, stable attribute/CSS, href, role and accessible name,
  label, placeholder, or text
- scope and filter locators; count before ambiguous actions
- read text, attributes, visibility, enabled state, and checked/selected state
- provide bounded read-only page and element evaluation without arbitrary page
  mutation or Node/process access

### Interaction

- click with button/modifiers, double-click, move/hover, coordinate input,
  scroll, drag, keypress, type, and fill
- inspect the bounded element stack at a screenshot coordinate
- DOM-node click, double-click, scroll, keypress, and type
- check, uncheck, set checked, and select one or more native options
- wait for attached, detached, visible, or hidden locator state
- require a fresh snapshot after stale or ambiguous locator failures

### Dialogs, Evidence, And Developer Inspection

- inspect and accept/dismiss alert, confirm, prompt, and before-unload dialogs
- capture viewport, full-page, clipped, and element screenshots
- read bounded console logs with level, text, timestamp, and source URL filters
- expose bounded Browser-session clipboard read/write operations
- wait for and describe downloads, and download media from an explicit locator
- list page assets and bundle an explicit bounded selection into a temporary
  run-owned artifact
- assign explicit bounded local files to a unique file input
- export HTML, text, PDF, and eligible Google Workspace document formats into a
  temporary run-owned artifact

## Security And Governance Invariants

- Runtime identity comes only from the signed run credential. Model arguments
  cannot select another organization, Agent, run, Broker, profile, or API key.
- Tabs, dialogs, clipboard state, downloads, temporary assets, and viewports are
  isolated by organization, Agent, and run even though website login state is
  shared by the local instance profile.
- The model never receives raw cookies, passwords, session tokens, profile
  paths, unrestricted CDP, arbitrary Node execution, or mutable page JavaScript.
- Only approved `http:` and `https:` navigation is allowed. Rudder app
  origins and unsafe schemes stay blocked.
- Consequential website actions remain governed by the run instructions and
  approval boundary; authenticated website state does not grant authority.
- Live disable immediately stops admission, revokes tabs and ephemeral state,
  permanently exits the existing Browser stdio MCP, and revokes tabs and
  ephemeral state without disturbing the core `rudder-tools` MCP. Re-enable requires
  a freshly provisioned Browser MCP process.
- Every mutation records action intent and safe result metadata without page
  content, form values, clipboard contents, query tokens, or downloaded bytes.

## Implementation Sequence

1. Split Browser manifest and stdio mode from `rudder-tools`.
2. Inject `rudder-browser` conditionally in Codex, Claude, and OpenCode; create
   a distinct conditional Pi native bridge.
3. Expand the server route schemas and Desktop Broker command union.
4. Extend the Desktop tab abstraction and Electron implementation by capability
   group, keeping bounded internal primitives instead of exposing CDP directly.
5. Update the bundled Browser skill and sibling reference after the transport
   and tool schemas are executable.
6. Add unit, integration, adapter, route, E2E, packaged Desktop smoke, and real
   local-browser evidence for the complete matrix.
7. Run adversarial review and black-box verification before commit and push.

## Automated Evidence

- MCP tests prove `rudder-tools` never lists Browser tools and
  `rudder-browser` lists only Browser tools.
- Adapter tests prove the Browser server/bridge is present only when eligible
  and absent when disabled, including model fallback.
- Route and Broker tests cover schema bounds, live disable, signed-run identity,
  cross-run isolation, stale references, timeouts, result-size limits, and safe
  activity metadata for every mutating action group.
- Desktop controller tests cover each parity operation plus cleanup of dialogs,
  clipboard, downloads, assets, viewport state, and tabs at run end/disable.
- E2E covers the real user-visible workflow and representative complex controls,
  frames, dialogs, downloads, responsive viewport, console evidence, and
  production-shaped failure states.

## Real Environment Acceptance

Packaged Desktop must launch with an isolated disposable instance and drive a
local fixture application through the actual `rudder-browser` MCP transport.
The proof must include:

1. server discovery when enabled and absence when disabled;
2. navigation, DOM/locator interaction, visual CUA interaction, and screenshot;
3. back/forward/reload and responsive viewport verification;
4. checkbox/select/form, dialog, clipboard, console, download, and page-asset
   workflows, plus file upload, coordinate inspection, and content export;
5. cross-run tab denial and cleanup when the run finishes;
6. live Browser disable revoking the active surface while
   `rudder-tools` remains usable;
7. packaged verification through `pnpm desktop:verify` plus the relevant E2E
   suite and repository-wide lint, typecheck, tests, and build.

## Completion Rule

Completion requires evidence for every parity item above. Passing legacy
eight-tool smoke coverage or proving only MCP separation is partial progress,
not completion.

Task-outcome parity does not mean protocol identity with the Codex Browser
plugin. Rudder keeps its own run-scoped MCP schemas and does not expose raw
Browser client objects, unrestricted Playwright, tab claiming, or raw CDP.
Operator user-tab discovery is intentionally coarse because one Desktop
profile can serve multiple organizations; exact user-tab URLs require explicit
user input rather than cross-organization disclosure.

## Delivery Status

- Task 1 is complete: Browser transport and runtime credentials are isolated in
  the optional `rudder-browser` server while core tools remain in `rudder-tools`.
- Task 2A restores the committed backend, CLI, Desktop, packaged-runtime,
  governance, and documentation parity surface with focused automated coverage.
- Task 2B remains: Agent Detail metadata/UI and the user-visible Playwright E2E
  workflow, followed by final repository-wide and packaged verification.

The plan remains `in_progress` until Task 2B and the final acceptance matrix
are complete.
