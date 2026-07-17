# Reporting

Use concise Chinese by default when the user asked in Chinese.

## Verdict Vocabulary

- `PASS`: real local runtime executed the requested tool/workflow with
  transcript evidence and terminal readback.
- `FAIL`: runtime ran but did not meet acceptance criteria.
- `BLOCKED_PROVIDER`: provider/model/auth/rate-limit failure prevented tool
  execution.
- `PARTIAL`: some proof exists, but requested workflow or full matrix coverage
  is incomplete.
- `NOT_RUN`: runtime or tool class has not been exercised in this pass.

Do not use `PASS` with a buried caveat that the required real environment was
not run.

## Matrix Format

```markdown
Verdict: PARTIAL

Runtime matrix:
| Runtime | Model | Verdict | Run | Evidence | Fallback |
| --- | --- | --- | --- | --- | --- |
| Codex | ... | PASS | ... | ... | no |
| OpenCode | opencode/mimo-v2.5-free | FAIL | ... | no JSON output | no calls |
| OpenCode | deepseek/deepseek-chat | PASS | ... | issue workflow done | no |
| Pi | opencode/deepseek-v4-flash-free | BLOCKED_PROVIDER | ... | 429 before tool calls | no calls |

Key findings:
- ...

Mutation ledger:
- ...

Not covered:
- ...

Next actions:
- ...
```

## Required Details

Always include:

- API base and `/api/health` facts
- runtime, model, run id
- org/agent/issue ids for disposable proof data
- exact tool names observed
- fallback result: yes/no and evidence
- internal tool errors: yes/no and evidence
- terminal readback: run status, issue status, comments, final text
- whether old verifier/reviewer evidence is stale after code changes

## Language Discipline

Use precise statements:

- "OpenCode adapter passed with `deepseek/deepseek-chat`; default
  `opencode/mimo-v2.5-free` failed before emitting JSON."
- "Pi is blocked by provider 429 after managed extension setup, before any tool
  execution."
- "This proves model-visible tool usage, not full execution of all 69 tools."
- "Availability probe passed; issue workflow not covered."

Avoid:

- "all green" when any runtime is partial or blocked
- "tested all tools" when only a representative workflow ran
- "MCP auth fixed" when the run failed before a tool call
- "no CLI involved" unless you mean model-visible fallback and have transcript
  evidence

