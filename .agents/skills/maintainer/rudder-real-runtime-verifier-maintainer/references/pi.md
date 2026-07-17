# Pi Runtime Notes

Pi may expose Rudder control-plane tools through a managed native extension
instead of a standard MCP config path. From the model's perspective, the action
must still be a typed Rudder tool, not Bash/curl/CLI fallback.

## Transcript Shape

Look for Pi tool execution events:

```json
{"type":"tool_execution_start","toolName":"rudder_agent_me","args":{}}
{"type":"tool_execution_end","toolName":"rudder_agent_me","isError":false}
```

Issue workflow tools should appear as:

- `rudder_issue_context`
- `rudder_issue_checkout`
- `rudder_issue_comment`
- `rudder_issue_done`

## Managed Extension Evidence

Healthy setup logs may include:

- adapter-managed Pi runtime state
- managed Pi model compatibility config
- managed Rudder tool extension path such as
  `.pi/agent/extensions/rudder-control-plane/index.ts`
- loaded tool manifest/schema count when available

This setup evidence alone is not a pass. The transcript still needs actual
`tool_execution_*` events and terminal product readback.

## Known Traps

- If Pi registers permissive `{}` schemas, the model may call required-argument
  tools with `{}` and get "Missing required argument". Treat this as schema
  failure even if it later recovers.
- If MCP result `isError: true` is wrapped as a successful Pi
  `tool_execution_end`, the runtime is hiding tool failure. Treat as failed or
  suspect.
- Provider 429s can occur before any tool call. Classify as
  `BLOCKED_PROVIDER`; do not call it Rudder auth/org failure.
- Pi auth-required messages are separate from runtime isolation and tool
  registration. Report them as provider auth blockers.

## Healthy Evidence

Pi workflow proof should include:

- managed Rudder extension configured
- schemas loaded for tools that need structured input
- `tool_execution_start/end` for every expected Rudder tool
- `isError=false` and no nested structured error
- no shell/Bash/curl/rudder CLI fallback
- persisted issue status/comments or requested terminal readback

