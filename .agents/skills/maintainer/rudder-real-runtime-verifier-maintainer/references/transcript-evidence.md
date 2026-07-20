# Transcript Evidence

Use this reference to decide whether a run really used Rudder tools or fell back
to CLI/shell/curl.

## Evidence That Counts

Count structured runtime events, not prompt text:

- Codex: `item.completed` with `item.type === "mcp_tool_call"`.
- Claude: assistant message content entries with `type: "tool_use"` and
  `type: "tool_result"`.
- OpenCode: JSONL `tool_use` events with `part.tool`.
- Pi: `tool_execution_start` and `tool_execution_end`.
- Run-intelligence parsed transcript entries when backed by raw log.

Record the exact tool names. Preserve server-qualified names when present, such
as `rudder-tools_rudder_issue_context`.

## Fallback Detection

Flag fallback when a model-visible tool call invokes shell-like tools for Rudder
Rudder work:

- tool names like `Bash`, `bash`, `shell`, `terminal`, `exec`, `curl`
- command/input containing `rudder agent`, `rudder issue`, `rudder runs`,
  `rudder library`, `rudder chat`, `rudder automation`
- command/input containing `curl` plus Rudder API key or Rudder API route

Do not flag mere prompt text saying "Do not use Bash/curl/rudder CLI". That is
instruction text, not a tool call.

## Internal Tool Error Detection

Flag tool failures even when the runtime labels the tool call completed:

- `isError: true`
- JSON content with `"status":"error"`
- `rudder_cli_command_failed`
- missing required argument
- auth errors, invalid API key, missing runtime identity
- org ID, agent ID, run ID, or API URL requested from the model
- MCP transport/config errors

If a tool failed and the model recovered with a later correct call, report both:
the final product may pass, but the tool surface still exposed a usability or
schema problem.

## Final Text Is Secondary

Final assistant text can be wrong even after successful tool use, especially
with continuation/autocompaction. Treat final text as one surface, not the only
truth.

Useful classifications:

- `tool path passed; final text contradictory`
- `product effect passed; runtime status failed`
- `tool result failed; model recovered`
- `provider failed before tool call`
- `no transcript events emitted`

