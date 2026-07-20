# OpenCode Runtime Notes

OpenCode verification must separate adapter correctness from provider/model
availability. A default model can fail while the same adapter works with another
model.

## Transcript Shape

OpenCode raw logs are JSONL. Tool calls look like:

```json
{
  "type": "tool_use",
  "part": {
    "tool": "rudder-operating-layer_rudder_agent_me",
    "state": {
      "status": "completed",
      "input": {}
    }
  }
}
```

Tool-call step finishes often have `reason: "tool-calls"` and should still
count usage/cost. Terminal steps often have `reason: "stop"`.

## Known Traps

- Some OpenCode provider/model combinations emit no JSON output and should fail
  with a startup idle message such as "stopped after 90s without emitting JSON
  output". This is provider/model failure, not proof that MCP is broken.
- OpenCode can emit synthetic continuation summaries. Do not treat those as
  final assistant answers or as missing tools.
- Provider raw XML-like `<tool_call>` text can appear as text. Do not count it
  as assistant final prose.
- A run may call one tool and then end without final text. That is not a full
  workflow pass.

## Model Matrix Practice

When default OpenCode fails:

1. Keep the default model result as `FAIL` or `BLOCKED_PROVIDER`.
2. Rerun one known alternate model to test the adapter path.
3. Report both, for example:
   - `opencode/mimo-v2.5-free`: no JSON output, no tool calls
   - `deepseek/deepseek-chat`: issue workflow passed with Rudder tools

Do not hide the default-model failure behind the alternate-model pass.

## Healthy Evidence

OpenCode workflow proof should include:

- expected `rudder-operating-layer_rudder_*` tool calls
- no shell/curl/rudder CLI fallback in structured `tool_use`
- no internal tool errors
- final issue status and comments when running issue workflow
- non-contradictory final text or an explicit final-text failure classification

