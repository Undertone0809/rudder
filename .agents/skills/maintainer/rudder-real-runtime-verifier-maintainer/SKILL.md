---
name: rudder-real-runtime-verifier-maintainer
description: "Use when verifying Rudder agent runtime behavior in a real local environment, especially MCP/native operating-layer tools across Codex, Claude, OpenCode, Pi, or user-named runtimes. Trigger for requests like 真是/真实环境跑过吗, 排查所有 rudder tools, transcript/fallback verification, runtime MCP availability, provider matrix proof, or checking whether agents used Rudder tools instead of rudder CLI/Bash/curl fallback."
---

# Rudder Real Runtime Verifier Maintainer

Verify Rudder agent runtime behavior on the user's real local Rudder instance.
This is a black-box runtime acceptance workflow, not an implementation or code
review workflow.

Default to Chinese when the user asks in Chinese. Put the current truth first:
which runtimes passed, failed, or were blocked, and what transcript evidence
proves it.

## Role Boundary

Default to verification and diagnosis only:

- Run real local runtime probes and inspect run transcripts, logs, API state,
  issue state, comments, and run metadata.
- Create disposable orgs, agents, issues, and runs when needed for proof.
- Separate provider/model failure from Rudder adapter failure.
- Report exact blockers and smallest likely fixes.
- Do not edit source files, configs, git state, or product docs unless the user
  explicitly asks for a mutation after the verification request.

If the user asks to fix the issue, hand back to the lifecycle implementation
route or make the smallest explicit patch, then require this skill's real
runtime proof again before claiming done.

## When This Skill Wins

Use this skill when the core question is whether an agent runtime actually did
the work through Rudder-managed tools in a real local run.

Typical prompts:

- "你所有的 agent runtime 都本地测过跑过真实环境了吗?"
- "OpenCode and Pi agent 你也测了吗?"
- "看 transcript，别让它 fallback 用 rudder cli"
- "排查所有 rudder tools，都试一遍"
- "MCP tool 报 org id/auth 问题，正常 agent 调 tool 不该传 org"
- "Codex/Claude/OpenCode/Pi 真实环境跑一下"

If the user asks for general product acceptance that is not runtime/tool-call
specific, use `product-acceptance-verifier-maintainer` instead. If the user
provides only one failed run id and wants root cause, use
`debug-run-transcript-maintainer` first, then return here for rerun proof after
a fix.

## Runtime Matrix

Default required matrix:

- Codex
- Claude
- OpenCode
- Pi

Extend the matrix when the user names additional runtimes such as Cursor or
Gemini. Do not treat a Codex pass as proof for another runtime.

Read only the relevant reference files:

- `references/probe-workflow.md`: real local setup, disposable data, probe
  script expectations, and proof levels.
- `references/transcript-evidence.md`: how to prove tool use and reject CLI
  fallback from logs.
- `references/codex.md`: Codex MCP transcript shape and known traps.
- `references/claude.md`: Claude MCP transcript shape and strict config traps.
- `references/opencode.md`: OpenCode MCP transcript shape, provider/model
  caveats, JSONL parser expectations, and final-text pitfalls.
- `references/pi.md`: Pi native extension transcript shape, schema/error
  propagation traps, and 429/auth/provider separation.
- `references/reporting.md`: verdict format, mutation ledger, and pass/fail
  language.

## Acceptance Standard

A runtime passes only when all are true:

1. The local Rudder source of truth is identified, usually
   `GET /api/health` on `http://127.0.0.1:3100`.
2. A real local run was triggered for that runtime, or an existing real local
   run was inspected with enough raw transcript/log evidence.
3. The transcript shows the expected Rudder MCP/native tool calls.
4. There is no model-visible fallback to shell, Bash, curl, or `rudder` CLI for
   Rudder operating-layer work.
5. Tool results are not internally failed (`isError`, structured error,
   `rudder_cli_command_failed`, missing required argument, auth/org failure).
6. The terminal product effect was read back: issue status, comments, run
   status, final text, API result, or another requested surface.
7. Provider/model blockers are separated from Rudder adapter/tool blockers.

If the user requires "all tools", do not only run a happy-path issue workflow.
Run or request a manifest-driven coverage plan: list every exposed tool, verify
schemas load, check runtime-managed identity is not model-provided, and execute
representative read/mutate/file/image/pagination/error cases. Mark unexecuted
tools as not covered.

## Default Probe Ladder

Use the smallest probe that answers the question, then escalate only as needed:

1. **Tool availability probe**: call `rudder_agent_me`, require final answer
   to say MCP/tool path and no fallback.
2. **Issue workflow probe**: seed an issue, then require
   `rudder_issue_context`, `rudder_issue_checkout`,
   `rudder_issue_comment`, and `rudder_issue_done`; read back final issue
   status and comments.
3. **Representative matrix probe**: add read/list/pagination/file/comment/image
   examples such as `rudder_runs_errors`, `rudder_library_file_ref`,
   inbox/context, review, chat, or automation.
4. **Full manifest audit**: prove every exposed Rudder tool has a stable name,
   schema, description, and handler classification; execute safe read-only
   tools and representative mutating tools in disposable data.

## Known Judgment Rules

- A successful final answer is not enough. Inspect raw or parsed transcript.
- A tool call name in prompt text is not evidence. Use structured tool-call
  events or parsed run-intelligence entries.
- A run can fail after completing the product effect. Report that separately:
  `tool/product effect passed; runtime finalization failed`.
- A provider 429/auth/model error before any tool call is not an MCP auth/org
  bug. Mark it `blocked_provider`.
- If a tool result contains `isError: true` but the runtime marks the tool call
  completed, treat the runtime as failed or at least suspect until fixed.
- Internal runtime-owned bridges may execute a server process. That is
  acceptable only if the model-visible action is a typed Rudder tool and
  runtime env owns identity. It is not acceptable if the model uses Bash/curl or
  runs `rudder ...` itself for operating-layer work.

## Output

Use `references/reporting.md` for the full shape. At minimum include:

- verdict per runtime: `PASS`, `FAIL`, `BLOCKED_PROVIDER`, `PARTIAL`, or
  `NOT_RUN`
- run IDs, issue IDs, org IDs when disposable data was created
- observed tool names
- whether CLI/Bash/curl fallback was observed
- internal tool errors
- terminal product effect
- skipped coverage and why
- mutation ledger

Do not say "all green" if any runtime is blocked, substituted, partial, or only
covered by simple `agent_me`.

