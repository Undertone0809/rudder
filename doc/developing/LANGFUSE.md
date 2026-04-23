# Langfuse

This guide describes how to run and verify Rudder's phase-1 Langfuse integration locally.

## Role split

- Rudder remains the source of truth for execution, budgets, activity history, and evaluation ownership.
- Langfuse is a derived plane for traces, scores, dashboards, and experiments.
- Rudder IDs remain the canonical correlation IDs. Langfuse traces are derived from Rudder execution IDs.

## What is instrumented in phase 1

The shared execution observability contract currently covers:

- heartbeat runs
- issue-backed runs, emitted as `issue_run` instead of generic `heartbeat_run`
- plugin job runs
- workspace operations
- assistant chat turns, emitted as `chat_turn`
- chat execution actions such as convert-to-issue and approval-backed mutations, emitted as `chat_action`
- activity mutations tied to execution
- cost events tied to execution

Additional payload detail now exported on top of the common dimensions:

- `chat_turn` root input keeps the user message and, when the adapter exposes invocation metadata, the effective runtime instruction/prompt plus prompt metrics
- `heartbeat_run` / `issue_run` root metadata records the configured instructions file path, loaded skill keys, and a reduced loaded-skills snapshot for the runtime

Common exported dimensions include:

- `surface`
- `rootExecutionId`
- `orgId`
- `agentId`
- `issueId`
- `pluginId`
- `sessionKey`
- `runtime`
- `trigger`
- `status`
- `release`
- `deploymentMode`
- `localEnv`

Heartbeat run live eval emits Langfuse scores from Rudder's `run-intelligence-core` diagnosis layer:

- `run_health`
- `failure_taxonomy`
- `task_outcome`
- `budget_guardrail`
- `cost_efficiency`
- `human_intervention_required`
- `recovery_success` when the run is a recovery run

Create-agent benchmark runs add a workflow-specific layer on top of the same trace pipeline:

- trace tags:
  - `workflow:create-agent`
  - `benchmark:true`
  - `benchmark-case:<case-id>`
- trace metadata:
  - `benchmarkCaseId`
  - `expectedPath`
  - `requestedRole`
  - `requestedRuntimeType`
  - `evaluationVersion`
  - `judgeVersion`
- deterministic scores:
  - `create_agent_request_completed`
  - `create_agent_path_correct`
  - `create_agent_payload_valid`
  - `create_agent_reports_to_valid`
  - `create_agent_runtime_valid`
  - `create_agent_skills_valid`
  - `create_agent_source_issue_linked`
  - `create_agent_no_filesystem_fallback`
  - `create_agent_overall_correctness`
- optional quality scores:
  - `create_agent_config_quality`
  - `create_agent_reasoning_quality`
  - `create_agent_governance_judgment_quality`

## Required env

Put these env vars in the repository root `.env` by default:

```dotenv
LANGFUSE_ENABLED=true
LANGFUSE_BASE_URL=http://localhost:3000
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_ENVIRONMENT=local
```

Rudder now loads the workspace-root `.env` even when you start a package-level dev process such as `pnpm --filter @rudder/server dev`.

You can still provide the same values via shell env if you want to override them for a single process:

```sh
export LANGFUSE_ENABLED=true
export LANGFUSE_BASE_URL=http://localhost:3000
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_ENVIRONMENT=local
```

If `LANGFUSE_ENABLED` is not `true`, Rudder behaves exactly as before and does not emit to Langfuse.

## Avoid mixed dev runtimes

Do not run multiple Rudder worktrees against the same local instance at the same time.

In particular, avoid combinations like:

- `/Users/zeeland/projects/rudder`
- `/Users/zeeland/projects/rudder-staging`

when both use:

- `RUDDER_LOCAL_ENV=dev`
- `RUDDER_INSTANCE_ID=dev`

Why this breaks observability:

- both servers write to the same `~/.rudder/instances/dev/runtime/server.json`
- both servers compete for `:3100` and may fall back to `:3101` or `:3102`
- the board or desktop shell can end up talking to a different server than the one you think you started
- one worktree may have Langfuse configured while the other does not, which makes chat and run traces appear to "randomly" disappear

If a chat or run is missing in Langfuse, check these first:

```sh
curl http://127.0.0.1:3100/api/health
cat ~/.rudder/instances/dev/runtime/server.json
lsof -nP -iTCP -sTCP:LISTEN | rg 'node.*(3100|3101|3102|13100|13101|13102)'
```

Recommended practice:

- keep only one `dev` Rudder server running at a time
- if you need two worktrees live, initialize the second one with `pnpm rudder worktree init` so it gets its own repo-local `RUDDER_HOME`, `RUDDER_INSTANCE_ID`, and ports
- after stopping conflicting servers, restart the intended worktree and re-check `runtime/server.json`

## Start Rudder with Langfuse

### Normal dev path

Restart the usual dev runtime after the root `.env` is in place:

```sh
pnpm dev
```

If you only want the server process, this also works and still reads the repo-root `.env`:

```sh
pnpm --filter @rudder/server dev
```

### Isolated verification path

If you already have a `pnpm dev` runtime on `:3100` and do not want to disturb it, you can start a second server that reuses the same embedded Postgres and only changes the API/UI port:

```sh
PORT=3300 \
RUDDER_LOCAL_ENV=e2e \
RUDDER_INSTANCE_ID=e2e \
RUDDER_UI_DEV_MIDDLEWARE=true \
DATABASE_URL=postgresql://rudder:rudder@127.0.0.1:54329/rudder \
LANGFUSE_ENABLED=true \
LANGFUSE_BASE_URL=http://localhost:3000 \
LANGFUSE_PUBLIC_KEY=pk-lf-... \
LANGFUSE_SECRET_KEY=sk-lf-... \
LANGFUSE_ENVIRONMENT=local \
pnpm --filter @rudder/server dev
```

This path is useful when:

- the existing `:3100` runtime already has the org and agent data you want to test
- you want a Langfuse-enabled server without restarting the main dev loop

## Verify the integration

### 1. Confirm the Rudder server is healthy

```sh
curl http://127.0.0.1:3100/api/health
```

or, for the isolated sidecar:

```sh
curl http://127.0.0.1:3300/api/health
```

### 2. Pick an org and an agent

List orgs:

```sh
curl http://127.0.0.1:3100/api/orgs | jq '.[] | {id,name,status}'
```

List agents for one org:

```sh
curl http://127.0.0.1:3100/api/orgs/<org-id>/agents | jq '.[] | {id,name,status,agentRuntimeType}'
```

### 3. Trigger a heartbeat run

Manual invoke works even when scheduled heartbeats are disabled, as long as the agent can be invoked on demand.

```sh
curl -X POST \
  "http://127.0.0.1:3100/api/agents/<agent-id>/heartbeat/invoke?orgId=<org-id>"
```

If you are using the isolated sidecar server, send the same request to `:3300`.

The response returns the queued heartbeat run:

```json
{
  "id": "heartbeat-run-id",
  "status": "queued"
}
```

### 4. Resolve the Langfuse deep link from Rudder

Rudder exposes deterministic Langfuse links via the run-intelligence API:

```sh
curl "http://127.0.0.1:3100/api/run-intelligence/orgs/<org-id>/runs?limit=5" | jq '.[0].langfuse'
```

Expected shape:

```json
{
  "traceId": "langfuse-trace-id",
  "traceUrl": "http://localhost:3000/project/<project-id>/traces/<trace-id>"
}
```

You can also inspect a specific run:

```sh
curl "http://127.0.0.1:3100/api/run-intelligence/runs/<run-id>" | jq '{run: .run.id, langfuse: .langfuse}'
```

### 5. Check the trace and scores in Langfuse

Open the returned `traceUrl` in Langfuse.

For a heartbeat run, expect:

- a root trace whose identity maps back to `heartbeat_runs.id`
- transcript-derived child observations for model turns, tool calls/results, and stderr/system events when available
- live eval scores attached after diagnosis completes

For issue-backed executions, expect the same root execution ID mapping, but the exported `surface` dimension should be `issue_run`.

For direct assistant chat turns, expect traces with `surface=chat_turn`, `sessionKey=<chat-conversation-id>`, and nested model/tool observations.

For chat-side execution flows such as convert-to-issue, lightweight operation resolution, and chat approval application, expect traces with `surface=chat_action` and `sessionKey=<chat-conversation-id>`.

For quick database-level verification against self-hosted Langfuse, query ClickHouse directly:

```sh
docker exec langfuse-clickhouse-1 clickhouse-client --query \
  "SELECT id, name, project_id, environment, created_at FROM traces ORDER BY created_at DESC LIMIT 5"

docker exec langfuse-clickhouse-1 clickhouse-client --query \
  "SELECT name, value, string_value, trace_id, created_at FROM scores ORDER BY created_at DESC LIMIT 20"
```

## Run create-agent benchmarks locally

The first benchmark loop is local and manual on purpose. Rudder owns the cases and evaluator; Langfuse stays the derived comparison layer.

Example single case:

```sh
pnpm --filter @rudder/cli dev benchmark create-agent run approval-cto-under-ceo \
  --org-id <org-id> \
  --benchmark-agent-id <agent-id> \
  --fixture ceo=<ceo-agent-id>
```

Example set:

```sh
pnpm --filter @rudder/cli dev benchmark create-agent run-set smoke \
  --org-id <org-id> \
  --benchmark-agent-id <agent-id> \
  --fixture ceo=<ceo-agent-id>
```

Useful follow-up commands:

```sh
pnpm --filter @rudder/cli dev benchmark create-agent rescore \
  .artifacts/create-agent-benchmark/runs/<case-id>-<run-id>/result.json

pnpm --filter @rudder/cli dev benchmark create-agent sync-langfuse \
  .artifacts/create-agent-benchmark/runs/<case-id>-<run-id>/result.json

pnpm --filter @rudder/cli dev benchmark create-agent report \
  .artifacts/create-agent-benchmark/runs/<case-id>-<run-id>/result.json --markdown
```

Each run writes local artifacts under `.artifacts/create-agent-benchmark/`:

- `result.json`: full captured run detail, created agent/approval diff, evaluator output, Langfuse linkage
- `report.md`: compact human-readable summary for repeated comparison

When Langfuse is enabled, use the stored `traceUrl` or filter traces by:

- tag `workflow:create-agent`
- tag `benchmark:true`
- tag `benchmark-case:<case-id>`
- metadata `benchmarkCaseId=<case-id>`

If `OPENAI_API_KEY` is absent, the judge is skipped and deterministic correctness still runs. If Langfuse credentials are absent, the local report still completes and score sync is marked as skipped.

## What "working" means

The integration is working when all of the following are true:

- the Rudder run completes or fails normally without Langfuse blocking execution
- `GET /api/run-intelligence/...` returns a non-null `langfuse.traceUrl`
- the trace appears in the Langfuse project
- the run has the expected Langfuse dimensions such as `surface`, `orgId`, `agentId`, `runtime`, and `status`
- heartbeat runs emit the expected score set after run diagnosis

## Failure modes to expect

- Missing Langfuse credentials: Rudder logs a warning and disables Langfuse export.
- Langfuse export failure: Rudder logs the export error but does not block the heartbeat, budget logic, or activity logging.
- No `traceUrl` yet: the trace may not have been flushed yet, or the Langfuse client may be disabled for that server instance.

## Current API surfaces

Internal verification currently uses:

- `POST /api/agents/:id/heartbeat/invoke`
- `GET /api/run-intelligence/orgs/:orgId/runs`
- `GET /api/run-intelligence/runs/:runId`
- `GET /api/run-intelligence/runs/:runId/events`
- `GET /api/run-intelligence/runs/:runId/log`

These APIs are sufficient for local observability verification without adding a separate Rudder UI surface in phase 1.
