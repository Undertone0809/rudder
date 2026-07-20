# Claude Runtime Notes

Claude should use a managed MCP config with strict config behavior. User-supplied
`--mcp-config` or disabling strict MCP config should not override the Rudder
operating-layer server.

## Transcript Shape

Look inside assistant messages:

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {"type": "tool_use", "name": "mcp__rudder-operating-layer__rudder_agent_me"},
      {"type": "tool_result", "is_error": false}
    ]
  }
}
```

Tool names usually look like:

- `mcp__rudder-operating-layer__rudder_agent_me`
- `mcp__rudder-operating-layer__rudder_issue_context`
- `mcp__rudder-operating-layer__rudder_issue_checkout`
- `mcp__rudder-operating-layer__rudder_issue_comment`
- `mcp__rudder-operating-layer__rudder_issue_done`

## Known Traps

- Claude may complete the product effect and then fail run status due to
  autocompact/thrashing. Classify separately:
  `tool/product effect passed; runtime terminal status failed`.
- Bash fallback is visible as a `tool_use` named `Bash`. Inspect its input for
  `rudder ...` or `curl` against Rudder APIs.
- Tool result content can contain structured errors even when the message stream
  continues.

## Healthy Evidence

Claude workflow proof should include:

- strict managed MCP config active
- expected `mcp__rudder-operating-layer__...` tool uses
- no `Bash` fallback for Rudder operating-layer work
- no `tool_result.is_error`
- persisted issue/comment/readback evidence
- clean terminal run status, or an explicit finalizer failure classification

