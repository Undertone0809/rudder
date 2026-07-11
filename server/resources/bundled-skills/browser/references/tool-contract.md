# Rudder Browser Tool Contract

Browser tools are exposed by the first-party `rudder-control-plane` transport
only when the instance Browser capability is enabled for the current local run.

## Tools

- `rudder_browser_tabs`: list tabs owned by the current run.
- `rudder_browser_open`: open an HTTP(S) URL and return its `tabId`.
- `rudder_browser_navigate`: navigate a run-owned `tabId` to an HTTP(S) URL.
- `rudder_browser_read`: return the current URL, title, readable text, and
  interactive elements with opaque `ref` values.
- `rudder_browser_click`: click one `ref` from the latest page snapshot.
- `rudder_browser_type`: replace the value at one `ref`; optional `submit`
  submits the owning form after input events are dispatched.
- `rudder_browser_screenshot`: return a PNG capture for the current tab.
- `rudder_browser_close`: close one run-owned tab.

All tools derive `orgId`, `agentId`, and `runId` from Rudder runtime context.
Those values are never valid model arguments.

## Stable Errors

- `browser_disabled`: Browser is disabled in instance Settings.
- `browser_unavailable`: no live Rudder Desktop Browser Broker is registered.
- `browser_run_required`: the runtime did not provide a run id.
- `browser_run_forbidden`: the run identity does not match the authenticated
  organization and Agent.
- `browser_run_inactive`: the run has already ended.
- `browser_tab_not_found`: the tab does not exist for this run.
- `browser_tab_forbidden`: the tab belongs to another run.
- `browser_unsafe_url`: the URL or protocol is not allowed.
- `browser_invalid_argument`: a tool argument or page reference is invalid.

The Browser profile may contain sessions shared by organizations in the same
local Rudder instance. Tab ownership remains isolated by organization, Agent,
and run. Shared login state never broadens the task's authorization boundary.
