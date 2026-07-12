---
name: browser
description: Control Rudder's built-in Browser with run-scoped tools for opening tabs, navigating, reading structured page snapshots, clicking, typing, taking screenshots, and closing tabs. Use when a task requires inspecting or interacting with a web page or a locally served app through the Rudder Browser.
---

# Browser

Use the Rudder-managed Browser tools instead of launching another browser or
trying to read browser profile data directly.

## Workflow

1. Call `rudder_browser_tabs` to reuse a tab when possible, or
   `rudder_browser_open` with an `http:` or `https:` URL.
2. Call `rudder_browser_read` before interacting. Use only element references
   returned by the latest read result.
3. Call `rudder_browser_click` or `rudder_browser_type` for one clear action.
   Leave `submit` false unless submitting is explicitly intended. Every click
   or type invalidates the snapshot refs, so read again before another action.
4. Read again after navigation or mutation. Capture a screenshot when visual
   evidence matters.
5. Close tabs that are no longer needed.

## Boundaries

- Never pass organization, Agent, run, API, or Broker identity as tool input.
  Rudder injects and verifies that context.
- Treat an authenticated website session as available state, not as authority
  to perform a purchase, publish, delete, send, approve, or other consequential
  external action. Follow the task's approval boundary.
- Do not request, expose, copy, or infer cookies, session tokens, passwords, or
  Browser profile paths.
- Do not use arbitrary JavaScript, CDP, custom protocols, `file:` URLs, or
  `data:` navigation.
- A tab belongs to one Rudder run. Do not guess or reuse a tab id from another
  run.
- If a tool returns `browser_disabled`, stop and report that Browser is disabled
  in Settings. If it returns `browser_unavailable`, report that Rudder Desktop
  is not connected. Do not work around either state with another browser unless
  the user explicitly asks for that alternative.
- If a tool returns `browser_runtime_unsupported`, report that the current
  runtime cannot control Rudder Browser. Do not simulate Browser control with
  shell requests or another browser.
- If a ref is stale, covered, disabled, or changed, call `rudder_browser_read`
  again instead of guessing. If a tab reaches a timeout or disappears, list
  tabs before retrying so a late action is not duplicated.

Read [references/tool-contract.md](references/tool-contract.md) when exact tool
arguments, result fields, or stable error meanings are needed.
