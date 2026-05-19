---
name: debug-run-transcript-maintainer
description: |
  Debug and analyze Rudder agent run transcripts, run logs, and execution traces. Use this skill whenever the user mentions:
  - "debug run", "分析 run", "查看 run"
  - "为什么这个 agent 执行失败", "run 出错了"
  - "transcript 怎么看", "run 的日志"
  - a run ID or run ID prefix
  - agent execution, tool calls, stdout/stderr 调试

  Prefer this skill whenever the user wants to understand what happened during a run, even if they only have a partial run ID or only know the agent/runtime. Do not default to raw SQL first; use Rudder's run-intelligence path first, then fall back only if needed.
---

# Debug Run Transcript

Analyze Rudder agent runs by reconstructing the execution story from the best available source.

## Purpose

Runs fail for several different reasons:
- the model/runtime emitted an error
- the transcript parser missed useful structure
- the event stream is incomplete
- the stored excerpts are too shallow
- the operator has only a partial run ID or limited context

This skill helps diagnose those cases without getting stuck on the wrong data source.

## Source Priority

Always use sources in this order:

1. **Run-intelligence loader/API**
   - Best default.
   - Reads run metadata, run events, and the underlying run log.
   - Reconstructs transcript entries with runtime-specific parsers.
2. **Filesystem run log fallback**
   - Use when the local API is unavailable but run logs exist on disk.
   - Good for transcript/tool-call reconstruction.
3. **Direct database queries**
   - Use only for targeted checks or when the first two paths are unavailable.
   - DB rows alone are not the full transcript story.

## Important Lessons / Known Traps

- Do **not** assume `~/.rudder/instances/dev/postgres-uri` exists. In this repo it is not a reliable universal entrypoint.
- Do **not** start with `heartbeat_run_events` and assume they are the complete transcript. They are supplemental run events, not the full parsed execution trace.
- Do **not** write `WHERE id LIKE 'prefix%'` against `uuid` columns. Cast first: `id::text ILIKE 'prefix%'`.
- Do **not** assume `pnpm exec tsx` works from the repo root here. Prefer the repo-local launcher:

```bash
node cli/node_modules/tsx/dist/cli.mjs ...
```

- Do **not** treat `stdout_excerpt` / `stderr_excerpt` as the whole log. They are quick diagnostics only.
- If `/api/run-intelligence/runs/<id>/log` returns `404`, do **not** assume the run has no raw log anywhere. First check whether you are querying the wrong Rudder instance (for example `dev` server/API while the run log lives under `~/.rudder/instances/e2e/data/run-logs/...`).

## Workflow

### 1. Identify the run

If the user gives:
- a full run ID: use it directly
- a short prefix like `7d28669d`: treat it as a prefix
- only an agent or timeframe: first help locate likely runs before deeper analysis

If the user provides no identifying info at all, ask for at least one of:
- run ID or prefix
- agent name
- approximate time window

### 2. Preferred path: run-intelligence CLI helpers

Use these first when working locally in this repo.

**High-level diagnosis**
```bash
node cli/node_modules/tsx/dist/cli.mjs packages/run-intelligence-core/src/cli/analyze.ts <run-id-or-prefix> [auto|quick|error|perf|full]
```

**Outline model turns / steps**
```bash
node cli/node_modules/tsx/dist/cli.mjs packages/run-intelligence-core/src/cli/trace-outline.ts <run-id-or-prefix>
```

**Inspect a specific step**
```bash
node cli/node_modules/tsx/dist/cli.mjs packages/run-intelligence-core/src/cli/trace-entry.ts <run-id-or-prefix> <stepIndex|turn:N>
```

These commands already know how to:
- search by run prefix across orgs
- fetch run metadata, events, and logs through the API
- fall back to filesystem run logs if the API path is unavailable
- parse runtime-specific stdout into transcript entries

### 3. API path if you need raw data

If the local Rudder server is up, use the run-intelligence API directly.

Useful endpoints:

```bash
curl http://127.0.0.1:3100/api/orgs
curl "http://127.0.0.1:3100/api/run-intelligence/orgs/<org-id>/runs?limit=50&runIdPrefix=<prefix>"
curl "http://127.0.0.1:3100/api/run-intelligence/runs/<run-id>"
curl "http://127.0.0.1:3100/api/run-intelligence/runs/<run-id>/events"
curl "http://127.0.0.1:3100/api/run-intelligence/runs/<run-id>/log"
```

If `RUDDER_API_URL` is set, use that base URL instead of `http://127.0.0.1:3100/api`.

### 4. Filesystem fallback

If the API path is unavailable, the run-intelligence CLI loader can still fall back to filesystem logs automatically.

Default local run-log root:

```text
~/.rudder/instances/dev/data/run-logs
```

If the run came from a different local instance, also check sibling stores such as:

```text
~/.rudder/instances/e2e/data/run-logs
```

This matters when:
- run detail and events resolve correctly through one server
- but `/run-intelligence/runs/<id>/log` returns `404`
- and the raw log actually exists under another instance root

Use the same CLI commands above before inventing a custom parser.

### 5. Direct DB fallback

Use DB queries only when you need targeted supplementary checks.

Examples:

**Run metadata by prefix**
```sql
SELECT
  r.id,
  r.status,
  r.exit_code,
  r.signal,
  r.error,
  r.error_code,
  r.started_at,
  r.finished_at,
  r.session_id_before,
  r.session_id_after,
  r.stdout_excerpt,
  r.stderr_excerpt,
  r.usage_json,
  r.result_json,
  a.name AS agent_name,
  a.agent_runtime_type
FROM heartbeat_runs r
JOIN agents a ON r.agent_id = a.id
WHERE r.id::text ILIKE '7d28669d%'
ORDER BY r.created_at DESC;
```

**Run events by prefix**
```sql
SELECT
  seq,
  event_type,
  stream,
  level,
  message,
  payload,
  created_at
FROM heartbeat_run_events
WHERE run_id::text ILIKE '7d28669d%'
ORDER BY seq, id;
```

**Likely error events**
```sql
SELECT
  seq,
  event_type,
  stream,
  level,
  message,
  payload
FROM heartbeat_run_events
WHERE run_id::text ILIKE '7d28669d%'
  AND (
    stream = 'stderr'
    OR level = 'error'
    OR event_type ILIKE '%error%'
    OR COALESCE(payload->>'isError', payload->>'is_error', 'false') = 'true'
  )
ORDER BY seq, id;
```

## Interpreting the data

When analyzing a run, focus on these in order:

1. **Run summary**
   - status
   - duration
   - runtime type / agent name
   - exit code / signal / error / error code
   - token and cost fields from `usage_json`

2. **Transcript story**
   - model turns
   - tool calls and tool results
   - stderr / system events
   - where the run first visibly goes wrong

3. **Supporting evidence**
   - run events such as `adapter.invoke`, `heartbeat.run.status`, `heartbeat.run.log`
   - `stdout_excerpt` / `stderr_excerpt`
   - session IDs before/after

## What to look for

### Tool call problems
- tool call without matching tool result
- tool result marked error
- unexpectedly large tool payloads or truncation

### Output problems
- stderr that explains the failure more clearly than `error`
- no parsed `result` entry even though raw log exists
- transcript parser missing structure that is visible in raw log

### Metadata problems
- `status` inconsistent with `exit_code` or `error_code`
- `usage_json` missing obvious token/cost fields
- `result_json` present but too shallow to explain failure

### Session / continuity problems
- surprising `session_id_before` / `session_id_after`
- retries or continuation context missing
- repeated init/start signals without a clean result

## Output Format

Present findings in this order:

### 1. Run Summary
```text
Run: 7d28669d-...
Agent: CEO (claude_local)
Status: failed
Duration: 3m 38s
Cost: $0.7919 | 47.8k in | 8.3k out | 2.1k cached
Exit Code: 1
Error: unknown session
```

### 2. What Happened
- Short narrative of the execution flow
- First clear failure point
- Whether the root cause came from transcript, raw log, or run event evidence

### 3. Key Evidence
- Tool calls
- Error snippets
- Relevant system / adapter.invoke events
- Session / retry clues

### 4. Raw Log

Only if the user asks. Save outside the repo, for example:

```bash
printf "%s" "$LOG_CONTENT" > /tmp/run-<run-id>.log
```

## Notes

- `heartbeat_run_events` may contain `stream = null` for non-log events.
- `payload` may use either `isError` or `is_error` depending on source.
- For costs/tokens, check `inputTokens`, `outputTokens`, `cachedInputTokens`, `cachedTokens`, `costUsd`, and `totalCostUsd`.
- The best default is usually: run `analyze.ts`, then `trace-outline.ts`, then inspect raw events/log only if the diagnosis is still unclear.
