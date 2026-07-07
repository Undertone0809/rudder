# Probe Workflow

Use this reference for real local runtime verification setup and probe design.

## Source Of Truth

Start with the real local Rudder API:

```bash
curl -sS http://127.0.0.1:3100/api/health
```

Record `version`, `deploymentMode`, `authReady`, and instance identity. If the
user named another base URL, use that exact base and say so.

Do not substitute unit tests, DB fixtures, or isolated mocks for a user-requested
real local runtime probe.

## Disposable Data

Prefer public APIs to create proof data:

- organization
- agent with target runtime and model
- issue assigned to the agent
- wakeup run or issue-assignment run

Keep identifiers in the mutation ledger. Do not silently delete evidence data
unless the user asks for cleanup.

## Probe Script Pattern

If the repo has a purpose-built script such as
`scripts/real-local-rudder-tools-runtime-probe.mjs`, prefer it. It should:

- create disposable org/agent/issue/run data
- inject a prompt forbidding Bash, shell, curl, and `rudder` CLI fallback
- wait for terminal run status
- load run-intelligence log or filesystem run log
- parse structured tool calls per runtime
- detect model-visible CLI fallback
- detect internal MCP/tool errors such as `isError`, `status:error`,
  `rudder_cli_command_failed`, missing argument, auth, or org failures
- read back terminal effect such as issue status and comments
- emit one JSON object with verdict and evidence

When the script verdict and transcript disagree, trust the transcript and fix
or flag the script.

## Minimum Commands

Tool availability:

```bash
node scripts/real-local-rudder-tools-runtime-probe.mjs \
  --runtime=<runtime> \
  --model=<model> \
  --timeout-ms=180000
```

Issue workflow:

```bash
node scripts/real-local-rudder-tools-runtime-probe.mjs \
  --runtime=<runtime> \
  --model=<model> \
  --issue-workflow \
  --timeout-ms=240000
```

Rerun a failed runtime with one alternate known-good model only when the goal is
to separate provider/model failure from adapter failure. Keep both results.

## Proof Levels

- `availability`: one tool like `rudder_agent_me` worked.
- `workflow`: representative work loop completed with persisted effect.
- `manifest`: every exposed tool is listed with schema/metadata and identity
  boundary checked.
- `full execution`: every safe tool or representative class was executed.

Do not call `availability` proof a full workflow pass.

