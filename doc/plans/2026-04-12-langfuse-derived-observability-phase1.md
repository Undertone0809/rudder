# Langfuse Derived Observability Phase 1

Status: implemented scaffold
Date: 2026-04-12

## Position

Rudder remains the source of truth for execution ownership, governance, budgets, activity history, and eval case ownership.
Langfuse is a derived plane for traces, scores, experiments, and metrics.

## Phase-1 Scope

- Self-hosted Langfuse for internal ops and platform developers
- Root execution tracing for:
  - heartbeat runs
  - plugin job runs
  - standalone workspace operations
- Child observation export for:
  - heartbeat lifecycle/status/process events
  - workspace operations attached to heartbeat runs
  - cost events tied to heartbeat runs
  - activity mutations tied to heartbeat runs
- Live eval score export from Rudder-owned run diagnosis
- Run-intelligence responses can expose Langfuse trace deep links

## Environment

Phase-1 server config reads:

- `LANGFUSE_ENABLED`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_ENVIRONMENT`

## Contract

All exported execution telemetry maps onto a shared execution-observability contract with the following stable dimensions:

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

Rudder IDs stay canonical. Langfuse trace IDs are deterministic derivatives of Rudder root execution IDs.

## Live Eval

Heartbeat run scoring reuses Rudder diagnosis from `@rudderhq/run-intelligence-core`.
Phase-1 score names:

- `run_health`
- `failure_taxonomy`
- `task_outcome`
- `budget_guardrail`
- `cost_efficiency`
- `human_intervention_required`
- `recovery_success`

## Legacy Eval Note

`pnpm evals:smoke` is now an explicit legacy stub and should not be treated as the benchmark path.
Use the benchmark direction in `doc/plans/2026-04-07-rudder-benchmark-v0.1.md` for Rudder-owned eval cases and runners.
