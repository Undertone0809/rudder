# Codex Runtime Notes

Codex should receive a Rudder-managed MCP server in its managed
`CODEX_HOME/config.toml`. Inherited external MCP/plugin config should stay
stripped unless the runtime explicitly supports it.

## Transcript Shape

Look for raw events like:

```json
{"type":"item.completed","item":{"type":"mcp_tool_call","server":"rudder-tools","tool":"rudder_agent_me"}}
```

Server-qualified tool names may appear as:

- `rudder-tools_rudder_agent_me`
- `rudder-tools_rudder_issue_context`
- `rudder-tools_rudder_issue_checkout`
- `rudder-tools_rudder_issue_comment`
- `rudder-tools_rudder_issue_done`

## Known Traps

- Codex can show the MCP tool call but the result may contain an internal
  `rudder_cli_command_failed`; this is not a pass.
- Do not accept final prose saying the tool worked unless the structured
  `mcp_tool_call` exists and the result is not an error.
- If a run uses shell or command tools to call `rudder ...`, that is fallback.

## Healthy Evidence

For issue workflow proof, require:

- all four issue tools observed
- no shell/Bash/curl fallback
- no internal MCP error
- final issue status `done`
- progress and done comments present when requested

