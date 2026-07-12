# Rudder Browser Tool Contract

Browser tools are exposed by the first-party `rudder-control-plane` transport
only when the deployment is `local_trusted`, the instance Browser capability is
enabled, and the current adapter is `claude_local`, `codex_local`,
`opencode_local`, or `pi_local`. Runtime fallback recomputes this gate and removes
the Browser skill, capability flag, and tools together when the target runtime is
not eligible.

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
Those values are never valid model arguments. Browser authorization requires a
run-scoped Agent JWT; the JWT's signed run is authoritative and any transport
run header is only a matching assertion.

## Stable Errors

- `browser_disabled` (`409`): Browser is disabled in instance Settings. Do not
  retry until the operator enables it.
- `browser_unavailable` (`503`): no live Rudder Desktop Browser Broker is
  accepting commands. Retry only after Desktop reconnects.
- `browser_runtime_unsupported` (`403`): the current Agent runtime is not one of
  the supported local Browser adapters. Do not retry through the same runtime.
- `browser_run_required` (`400`): the runtime did not provide a run id.
- `agent_run_context_mismatch` (`403`): a transport run header does not match
  the run signed into the runtime credential. Do not retry with another run id.
- `browser_run_credential_required` (`403`): the request used a credential that
  is not bound to one run. Browser cannot be authorized with a long-lived Agent
  API key plus a caller-supplied run id.
- `browser_run_forbidden` (`403`): the run identity does not match the authenticated
  organization and Agent. Do not retry with guessed identity.
- `browser_run_inactive` (`409`): the run has already ended. Do not retry from
  that run.
- `browser_tab_not_found` (`404`): the tab no longer exists. List tabs and open
  a replacement when needed.
- `browser_tab_forbidden` (`403`): the tab belongs to another run. Never probe
  or reuse it.
- `browser_ref_not_found` (`404`): the element ref is stale, changed, hidden,
  covered, disabled, or no longer belongs to the latest snapshot. Read again;
  refs are intentionally invalidated after every click or type action.
- `browser_unsafe_url` (`422`): the URL, protocol, or Rudder control-plane
  origin is not allowed. Correct the URL instead of retrying it unchanged.
- `browser_invalid_argument` (`400` or `422`): a tool argument is malformed or
  outside its bound. Correct the request before retrying.
- `browser_navigation_failed` (`502`): Chromium could not complete navigation.
  Inspect or list the tab before deciding whether to retry.
- `browser_tab_limit` (`429`): the run or Desktop tab limit was reached. Reuse
  or close an owned tab before opening another. V1 permits eight tabs per run
  and 32 Agent Browser tabs per Desktop process.
- `browser_timeout` (`504`): the command expired in a queue or timed out during
  execution. List tabs before retrying because an active timed-out tab is
  closed to prevent late side effects.
- `browser_result_too_large` (`413`): the screenshot exceeded the bounded
  response size. Use `read` or another narrower evidence path.
- `browser_broker_protocol_error` / `browser_broker_error` (`502`): Desktop
  returned an invalid or internal Broker result. Do not blindly retry a
  consequential action; inspect the tab or report the failure.

The Browser profile may contain sessions shared by organizations in the same
local Rudder instance. Tab ownership remains isolated by organization, Agent,
and run. Shared login state never broadens the task's authorization boundary.
