# Codex/OpenAI Compatibility

Use this guide when the target host is Codex or an OpenAI product surface that supports skills.

## Capabilities

| Capability | Support | Notes |
|------------|---------|-------|
| Draft or edit skills | Yes | Use normal skill structure with `SKILL.md` as the source of agent instructions. |
| Run execution evals | Yes | Use available subagents or `codex exec`-based flows when supported. |
| Parallel baseline runs | Usually | Depends on the current Codex host and subagent availability. |
| Description tuning | Yes | Codex backend results are judged routing proxies, not native invocation telemetry. |
| Packaging | Yes | Use `scripts/package_skill.py` when packaging is requested. |

## Routing

Codex skill routing depends primarily on the `name` and `description` fields in `SKILL.md` frontmatter. Keep all "when to use this skill" information in `description`; the body is loaded only after the skill triggers.

Use `scripts/run_eval.py --backend codex` or `scripts/run_loop --backend codex` to test whether the description makes the intended routing obvious. Treat this as a judged proxy, not proof of native skill invocation behavior.

## `agents/openai.yaml`

For Codex/OpenAI distribution, create or update `agents/openai.yaml` when the skill should have product-facing metadata, a default prompt, declared MCP dependencies, or explicit invocation policy.

`agents/openai.yaml` is machine/product metadata. It does not replace `SKILL.md`, and it should not contain the skill's execution workflow.

Recommended minimal shape:

```yaml
interface:
  display_name: "Human Readable Name"
  short_description: "Short UI summary"
  default_prompt: "Use $skill-name to complete the task."

policy:
  allow_implicit_invocation: true
```

Field guidance:

- Quote string values.
- Keep YAML keys unquoted.
- Make `interface.display_name` a human-facing name for UI lists and chips.
- Keep `interface.short_description` short enough for UI scanning, usually 25-64 characters.
- Make `interface.default_prompt` a short starter prompt that explicitly includes `$skill-name`.
- Add `interface.icon_small`, `interface.icon_large`, or `interface.brand_color` only when the user provided assets or branding.
- Add `dependencies.tools` only for real required tools, such as an MCP server the skill expects.
- Use `policy.allow_implicit_invocation: false` only when the skill should be invoked explicitly via `$skill-name` rather than routed automatically.

Example dependency block:

```yaml
dependencies:
  tools:
    - type: "mcp"
      value: "github"
      description: "GitHub MCP server"
      transport: "streamable_http"
      url: "https://api.githubcopilot.com/mcp/"
```

## Validation

Before reporting a Codex/OpenAI-targeted skill as ready:

1. Parse `SKILL.md` frontmatter and confirm `name` and `description` are valid.
2. Parse `agents/openai.yaml` if it exists.
3. Run this skill's `scripts/quick_validate.py` against the target skill.
4. If an OpenAI-provided validator is available in the host, run that as an additional compatibility check.
