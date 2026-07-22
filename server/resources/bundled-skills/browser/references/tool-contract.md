# Rudder Browser Tool Contract

This reference describes the separate first-party `rudder-browser` transport.
It is available only when deployment is `local_trusted`, the instance Browser
setting is enabled, and the runtime is `claude_local`, `codex_local`,
`opencode_local`, or `pi_local`. Runtime fallback removes the Browser skill,
capability flag, and server or native bridge together. `rudder-tools`
never exposes Browser tools.

The transport polls a Broker-free, run-authenticated liveness endpoint. Live
disable or run termination aborts active Browser HTTP work, suppresses queued
stdio responses, revokes Browser state, and permanently exits that process.
Re-enable requires a fresh Browser server.

## Codex In-App Browser Parity

The baseline is the complete dynamic documentation returned by the Codex
In-app Browser bundle `26.707.91948` on 2026-07-17. That IAB advertises only the
Browser `visibility` and `viewport` capabilities plus the Tab `pageAssets`
capability. Rudder uses typed MCP tools instead of the JavaScript object API and
targets the mapped core task outcomes below.

| Codex In-app Browser API | Rudder Browser MCP |
| --- | --- |
| `browser.user.openTabs()` | `rudder_browser_user_tabs` (coarse origin discovery only) |
| `browser.tabs.list()`, `selected()`, `get()` | `rudder_browser_tabs` |
| `browser.tabs.new()`, `tab.goto()` | `rudder_browser_open`, `rudder_browser_navigate` |
| `tab.back()`, `forward()`, `reload()`, `close()` | matching navigation tools and `rudder_browser_close` |
| `tab.title()`, `tab.url()` | tab results, locator reads, and `rudder_browser_read` |
| `tab.playwright.domSnapshot()` | `rudder_browser_snapshot` |
| Playwright locator builders, filters, reads, and actions | `rudder_browser_locator` |
| `frameLocator(...)` | locator `frame` chain |
| `playwright.evaluate(...)`, `locator.evaluate(...)` | intentionally unavailable; use bounded declarative reads |
| `expectNavigation`, URL/load waits | locator `expectNavigation`, `rudder_browser_wait` |
| `tab.cua.*` | `rudder_browser_cua` |
| `tab.dom_cua.*` | `rudder_browser_dom_cua` |
| `tab.getJsDialog()` and dialog methods | `rudder_browser_dialog` or atomic `dialogResponse` |
| `tab.screenshot(...)` | `rudder_browser_screenshot` |
| `tab.clipboard.*` | `rudder_browser_clipboard` |
| `tab.dev.logs(...)` | `rudder_browser_logs` |
| Browser `visibility` capability | `rudder_browser_visibility` |
| Browser `viewport` capability | `rudder_browser_viewport` |
| Tab `pageAssets` capability | `rudder_browser_assets` |

`browser.nameSession()` has no separate MCP action because every Rudder Browser
session is already identified by its signed organization, Agent, and run. User
tab ids are read-only context. Unlike Codex, Rudder returns only hostname and
origin summaries for operator tabs because the Desktop profile can serve more
than one organization. Titles, paths, queries, fragments, and credentials are
never exposed to an Agent. This is shape/discovery parity, not exact user-tab
inspection parity. The current IAB does not advertise extension-only tab
claiming, history, finalize/handoff, browser authentication, raw CDP, bot-
detection, or secure credential handoff, so those are not IAB parity blockers.
Rudder also intentionally rejects arbitrary `file:` navigation; both the
origin-only user-tab view and local-file boundary require an explicit product
permission decision before literal parity would be safe.

Rudder additionally provides one-shot download,
text/PDF and Google Workspace export, element-at-coordinate inspection,
and a compact legacy ref flow.

## Tool Inventory

### Tabs And Navigation

- `rudder_browser_user_tabs {}` lists live user-visible tabs in Rudder's
  built-in Browser as hostname and origin-only summaries. Results use opaque
  ids and are never controllable Agent tab ids. Ask for the exact URL when an
  origin alone cannot identify the requested page.
- `rudder_browser_tabs {}` lists tabs owned by the signed run and returns its
  selected tab id.
- `rudder_browser_open { url }` opens an HTTP(S) URL.
- `rudder_browser_navigate { tabId, url }` replaces a run-owned tab's page.
- `rudder_browser_back`, `rudder_browser_forward`, and
  `rudder_browser_reload` accept `{ tabId }`.
- `rudder_browser_close { tabId }` closes one run-owned tab.
- `rudder_browser_visibility { visible? }` reads or changes whether the run's
  selected tab is shown to the local operator.
- `rudder_browser_viewport { action, width?, height? }` gets, sets, or resets a
  run-wide viewport override. Set requires width 320-3840 and height 240-2160.

V1 permits eight tabs per run and 32 Agent Browser tabs per Desktop process.
User-visible tabs do not consume this Agent tab quota.

### Page Understanding

- `rudder_browser_snapshot { tabId, boxes?, depth?, maxNodes? }` returns a
  bounded accessibility-oriented DOM tree, same-origin frame boundaries,
  optional boxes, and stable DOM-CUA node ids. Depth is at most 30 and node
  count at most 3000; Chromium full-tree capture is never materialized.
- `rudder_browser_locator` accepts a locator strategy of `css`, `testId`,
  `href`, `role`, `label`, `placeholder`, or `text`. Locators may use a frame
  chain, a scoped parent, filters, `and`, `or`, and an explicit index or
  first/last position.
- Locator read actions are `count`, `allTextContents`, `textContent`,
  `innerText`, `attribute`, `visible`, `enabled`, `checked`, and
  `selected`.
- Arbitrary page or locator JavaScript evaluation is intentionally unavailable
  because side-effect checks do not prevent credential reads.
- `rudder_browser_read { tabId }` returns bounded visible text and opaque refs
  for the legacy compact flow.

### Interaction

- Locator actions are `click`, `dblclick`, `fill`, `type`, `press`, `check`,
  `uncheck`, `setChecked`, `select`, `wait`, `hover`, `scroll`, and `drag`.
- Click options include mouse button, modifiers, optional navigation
  expectation, and an atomic dialog response.
- Locator navigation expectations capture the main-frame loader and event
  sequence before the action. Success requires a new main-frame commit (or
  same-document navigation) plus the requested load state; the old document
  cannot satisfy the wait.
- File upload is disabled until Rudder can bind a run-owned staged handle rather
  than trusting a model-supplied filesystem path.
- `rudder_browser_cua` supports coordinate `click`, `doubleClick`, `move`,
  `scroll`, `drag`, `keypress`, `type`, and read-only `elementInfo`.
- `rudder_browser_dom_cua` supports `get`, node `click`, `doubleClick`,
  `scroll`, `keypress`, and `type`.
- `rudder_browser_click` and `rudder_browser_type` operate only on refs from
  the latest `rudder_browser_read` result.

### Dialogs, Evidence, And Artifacts

- `rudder_browser_dialog { tabId, action, promptText? }` gets, accepts, or
  dismisses an alert, confirm, or before-unload dialog. JavaScript prompts are
  dismissal-only in Electron; acceptance fails closed after dismissal.
- `rudder_browser_screenshot` supports viewport, full-page, explicit clip, or
  unique-locator PNG/JPEG captures. Decoded image bytes are capped at 10 MB.
  Full-page dimensions beyond Chromium's 16384-pixel limit fail explicitly
  instead of returning a silently truncated image marked `fullPage`.
- `rudder_browser_logs` reads at most 500 buffered log entries and can filter by
  level or substring and clear the buffer.
- `rudder_browser_clipboard` reads, writes, or clears a virtual run clipboard.
  Text, binary Base64 entries, MIME types, and presentation style are bounded.
  State remains in Desktop memory and is never installed on
  `navigator.clipboard`. Explicit CUA copy, cut, and paste chords transfer only
  the focused selection and never reach the native OS clipboard path.
- `rudder_browser_download` downloads explicit locator media or arms one
  download-trigger click. Each artifact is capped at 25 MB.
- `rudder_browser_assets` first creates an inventory, then bundles an explicit
  `assetIds` or `kinds` selection. Each asset is capped at 25 MB, each bundle at
  100 MB, and each run at 250 MB. Response bodies are canceled while streaming
  as soon as a byte limit is crossed; bundle admission is serialized per run.
  Navigation makes an inventory stale and unknown requested ids are rejected;
  callers must list the current page again. Inline SVGs are inventory metadata
  only (`id`, media `type`, `origin`, `width`, and `height`); raw markup and page
  attributes are never returned or bundled.
- `rudder_browser_content` exports text or PDF, or an eligible Google
  Doc, Sheet, or Slides page to `pdf`, `md`, `docx`, `xlsx`, `csv`, or `pptx`.
  Content exports are capped at 25 MB.
- `rudder_browser_wait` waits for a URL substring, text, text disappearance, or
  bounded time. URL input is never treated as a regular expression.

All returned paths are temporary run-owned artifacts. Explicit tab close,
Browser disable, run cleanup, and Desktop shutdown await artifact deletion.

## Identity And Logging

Every tool derives `orgId`, `agentId`, and `runId` only from the signed runtime
credential. Model arguments cannot select another identity, Broker, profile,
API URL, or key. Browser authorization requires a run-scoped Agent JWT; a run
header is only a matching assertion.

Browser request bodies are marked sensitive before HTTP error logging. Values,
clipboard data, prompt text, and Broker tokens
are never written as durable request-body diagnostics. Activity records contain
only action, status, safe origin, tab id, and stable error code.

## Stable Errors

- `browser_disabled` (409): Browser is disabled. Do not retry from the old MCP
  process.
- `browser_unavailable` (503): Desktop has no live Browser Broker.
- `browser_runtime_unsupported` (403): the runtime adapter is not eligible.
- `browser_run_required` (400): runtime context has no run id.
- `agent_run_context_mismatch` (403): transport and signed run differ.
- `browser_run_credential_required` (403): the credential is not run-scoped.
- `browser_run_forbidden` (403): signed organization, Agent, and run ownership
  do not match.
- `browser_run_inactive` (409): the run has ended.
- `browser_tab_not_found` (404): the run tab no longer exists.
- `browser_tab_forbidden` (403): the tab belongs to another run.
- `browser_ref_not_found` (404): the ref, node, or locator is stale, missing,
  hidden, covered, disabled, or ambiguous.
- `browser_unsafe_url` (422): protocol, URL, or Rudder app origin is
  blocked.
- `browser_invalid_argument` (400 or 422): arguments exceed schema bounds.
- `browser_navigation_failed` (502): Chromium could not complete navigation.
- `browser_tab_limit` (429): reuse or close an owned tab.
- `browser_timeout` (504): the operation expired; active timed-out tabs close
  to prevent late side effects.
- `browser_result_too_large` (413): narrow the result or artifact selection.
- `browser_action_failed` (502): the bounded Electron action failed.
- `browser_broker_protocol_error` or `browser_broker_error` (502): Desktop
  returned an invalid or internal Broker result.

Website login state may be shared by organizations using the same local Rudder
instance. Tab, clipboard, viewport, dialog, download, asset, and artifact state
remain isolated by organization, Agent, and run. Shared login state never
expands authorization.
