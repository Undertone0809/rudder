---
title: Self-hosted anonymous telemetry proposal
date: 2026-07-01
kind: proposal
status: proposed
area: deployment
entities:
  - self_hosted_telemetry
  - product_analytics
  - agent_work_loops
issue:
related_plans: []
supersedes: []
related_code:
  - server/src/config.ts
  - server/src/index.ts
  - server/src/home-paths.ts
  - packages/db/src/schema/organizations.ts
  - packages/db/src/schema/organization_memberships.ts
  - packages/db/src/schema/agents.ts
  - packages/db/src/schema/issues.ts
  - packages/db/src/schema/heartbeat_runs.ts
commit_refs: []
updated_at: 2026-07-01
---

# Self-hosted Anonymous Telemetry Proposal

## Overview

Rudder needs product adoption signal from self-hosted deployments, but the app is
an agent control plane and will often contain sensitive task, prompt, repository,
agent, run, and organization context. Front-end Google Analytics is not the right
primitive for this problem: it measures browser traffic, is commonly blocked or
unreachable in self-hosted/internal environments, and creates avoidable trust
risk inside the product surface.

This proposal adds a server-side anonymous telemetry heartbeat for self-hosted
Rudder instances. The heartbeat is intentionally small, schema-validated,
content-free, transparent to admins, and easy to disable. It is designed to
answer adoption and activation questions such as:

- How many active self-hosted instances exist in the last 7 / 30 days?
- What versions and deployment shapes are active?
- How many instances have created organizations, users, agents, issues, or runs?
- How many instances complete real agent-work loops weekly?

The proposal separates two systems:

1. **Telemetry client inside each Rudder server**: generates a random local
   installation id, aggregates local counts into coarse buckets, and periodically
   posts a heartbeat.
2. **Rudder telemetry collector**: accepts heartbeats, validates the strict
   payload schema, stores minimal instance-level rollups, and exposes aggregate
   internal reports.

## What Is The Problem?

Current state:

- Rudder can be run self-hosted/local with embedded PostgreSQL by default.
- The product north-star is weekly real agent-work loops completed end-to-end.
- Self-hosted users do not pass through a hosted product analytics funnel.
- Front-end analytics would only observe browser page views and user sessions,
  not durable deployments or server-side agent activity.

Problem:

- We cannot reliably know self-hosted adoption, retention, version distribution,
  or whether installations reach meaningful agent-work usage.
- Adding GA directly inside the Rudder app would create a privacy/trust mismatch
  for an OSS/self-hosted agent control plane.

Impact:

- Product decisions may optimize for visible hosted/docs traffic rather than real
  self-hosted usage.
- We may miss activation failures, stale versions, and whether the agent-work loop
  actually works outside local development.

## What Will Be Changed?

### Product behavior

- Add anonymous server-side telemetry for self-hosted deployments.
- Do not add Google Analytics to the product app for self-hosted usage tracking.
- Add a visible Admin/About telemetry status and disable instructions.
- Document exactly what is collected and not collected.

### Server behavior in self-hosted Rudder

- On startup, resolve telemetry config from env/config.
- If telemetry is disabled, do nothing except expose disabled status locally.
- If enabled, read or create a random local `telemetry_instance_id` stored under
  the Rudder instance root.
- Build a heartbeat payload from server metadata and local database aggregates.
- Send heartbeat on startup after a short jitter and then approximately every 24
  hours.
- Fail closed: network failures never block startup, requests, runs, or shutdown.

### Collector behavior

- Add a dedicated ingestion endpoint such as `POST /api/telemetry/v1/heartbeat`.
- Validate a strict schema and reject unknown/free-text fields.
- Store only the latest raw allowed heartbeat per instance plus append-only daily
  aggregate facts if needed.
- Do not store prompt/task/run content, emails, organization names, agent names,
  repository names, hostnames, URLs, secrets, API keys, or raw IP addresses.

## Success Criteria For Change

- Rudder can report active self-hosted instances in the last 7 and 30 days.
- Rudder can report version and deployment-kind distribution.
- Rudder can report activation buckets: organizations, users, agents, issues,
  runs, and completed agent-work loops.
- Telemetry payloads are content-free and validated by tests.
- Admins can disable telemetry with one env var.
- Startup and runtime behavior are unaffected if the collector is unreachable.
- Docs make the trust boundary explicit.

## Out Of Scope

- Front-end clickstream analytics inside the self-hosted product app.
- GA integration for the Rudder app. GA may still be used separately on public
  marketing/docs pages.
- Collecting exact user identity, organization identity, task content, run logs,
  prompts, model outputs, repository names, hostnames, full URLs, or secrets.
- Billing, licensing enforcement, or remote kill-switch behavior.
- Per-user behavioral attribution.

## Non-Functional Requirements

### Privacy and security

- Use a random UUID generated locally; do not derive an id from machine hardware,
  hostname, MAC address, database URL, org name, user email, or repo path.
- Use coarse buckets instead of exact sensitive operational counts where possible.
- Use an allowlist schema. Unknown fields are rejected or stripped before storage.
- Use HTTPS collector endpoints by default.
- Never include authorization secrets or provider config in payloads.
- Do not persist raw IP addresses in telemetry application tables. If platform
  logs receive IPs, configure retention/redaction separately.

### Reliability

- Telemetry is best-effort and non-critical.
- Use short request timeouts, e.g. 3 seconds.
- Retry with exponential backoff only within the scheduler; never block product
  workflows.
- Add per-instance jitter to avoid synchronized daily spikes.

### Maintainability

- Keep all local telemetry logic behind a small server-side module/facade.
- Keep payload creation pure and unit-testable.
- Keep collector schema versioned from day one.

## User Experience Walkthrough

### Admin/operator experience

1. Admin starts a self-hosted Rudder server.
2. Startup logs include a concise telemetry notice if enabled:

   ```text
   Rudder anonymous telemetry is enabled. It sends version and coarse usage
   buckets only; no prompts, task content, run outputs, secrets, emails, org
   names, agent names, repo names, hostnames, or URLs are collected. Disable with
   RUDDER_TELEMETRY_DISABLED=1.
   ```

3. Admin can open Settings/About and see:
   - telemetry status: enabled / disabled
   - instance id: masked suffix only, e.g. `...8f21`
   - last attempted heartbeat time
   - last successful heartbeat time
   - link to telemetry docs
   - disable instructions
4. If the collector is unreachable, the UI/log may show last failure locally, but
   Rudder keeps working normally.

### Rudder product team experience

1. Internal dashboard reads collector aggregates.
2. Team can answer:
   - weekly active self-hosted instances
   - monthly active self-hosted instances
   - new instances first seen this week
   - versions still active
   - how many installations created agents/issues/runs
   - how many installations completed agent-work loops

## Implementation

### 1. Local server telemetry client

Add a small module, for example:

- `server/src/services/telemetry/client.ts`
- `server/src/services/telemetry/payload.ts`
- `server/src/services/telemetry/scheduler.ts`

Responsibilities:

- `client.ts`: HTTP POST to collector with timeout.
- `payload.ts`: read local DB counts and build a schema-safe payload.
- `scheduler.ts`: startup jitter, interval, in-flight guard, backoff, shutdown
  cleanup.

Wire it from `server/src/index.ts`, near existing scheduler setup where interval
handles are tracked. The code already collects interval handles for heartbeat,
Feishu, and backup schedulers; telemetry should follow the same lifecycle so
shutdown clears the interval.

Pseudo-flow:

```ts
if (config.telemetry.enabled) {
  const telemetry = createTelemetryScheduler({ db, config, logger });
  intervalHandles.push(telemetry.intervalHandle);
  void telemetry.runOnceAfterJitter("startup");
}
```

Prefer an explicit scheduler object with `start()` / `stop()` if the existing
server lifecycle is later refactored.

### 2. Config and env gates

Extend `server/src/config.ts` with a nested config shape:

```ts
type TelemetryMode = "off" | "anonymous";

telemetry: {
  mode: TelemetryMode;
  enabled: boolean;
  endpointUrl: string;
  intervalMs: number;
  requestTimeoutMs: number;
}
```

Suggested env vars:

- `RUDDER_TELEMETRY_DISABLED=1`: hard-disable, highest priority.
- `RUDDER_TELEMETRY_MODE=off|anonymous`: explicit mode.
- `RUDDER_TELEMETRY_ENDPOINT=https://telemetry.rudderhq.com/api/telemetry/v1/heartbeat`.
- `RUDDER_TELEMETRY_INTERVAL_HOURS=24`.
- `RUDDER_TELEMETRY_TIMEOUT_MS=3000`.

Default policy recommendation for current early OSS phase:

- hosted/cloud prod: analytics can be enabled through hosted config.
- self-hosted server: default `anonymous` is acceptable only if the startup log,
  docs, Settings/About status, and one-env-var disable path are shipped in the
  same release.
- desktop/local dev: default `off` unless explicitly enabled, because local
  desktop usage may feel more personal and can be heavily experimental.

If we want the most conservative OSS trust posture, make self-hosted default
`off` and ask in setup. Product signal will be much weaker. My recommendation is
anonymous default-on only after transparency surfaces exist.

### 3. Telemetry instance id

Add a home path helper in `server/src/home-paths.ts`, for example:

```ts
export function resolveTelemetryInstanceIdPath(): string {
  return path.resolve(resolveRudderInstanceRoot(), "telemetry", "instance-id");
}
```

Create `server/src/services/telemetry/instance-id.ts`:

- ensure parent directory exists
- if file exists, read UUID
- if missing/invalid, generate `crypto.randomUUID()` and write with `0600` mode
- never use host, user, org, or machine identifiers

The id is scoped to the Rudder instance root. If the admin deletes the instance
data directory, a new id is generated. That is acceptable and privacy-preserving.

### 4. Payload schema

Use a versioned allowlist payload. Example:

```json
{
  "schema_version": 1,
  "telemetry_instance_id": "uuid-v4",
  "sent_at": "2026-07-01T02:00:00.000Z",
  "rudder_version": "0.3.1",
  "deployment_kind": "self_hosted",
  "runtime_owner_kind": "server",
  "local_env": "prod_local",
  "node_platform": "darwin",
  "database_kind": "embedded_postgres",
  "counts": {
    "organizations": "1",
    "active_members_7d": "2-5",
    "agents": "2-5",
    "issues": "21-100",
    "agent_runs_7d": "10-50",
    "succeeded_agent_runs_7d": "1-10",
    "completed_agent_work_loops_7d": "1-10"
  },
  "features": {
    "desktop_owner": false,
    "external_postgres": false,
    "langfuse_enabled": false,
    "feishu_enabled": false
  }
}
```

Important constraints:

- `telemetry_instance_id` is random and not human-derived.
- `node_platform` can be `darwin | linux | win32 | other`; do not include OS
  username, hostname, kernel release, architecture unless explicitly justified.
- Counts are buckets, not exact counts, except very coarse states like `0` and
  `1`.
- `features` are booleans from config, not names or secret-bearing values.

Bucket helper:

```ts
function bucketCount(n: number): "0" | "1" | "2-5" | "6-20" | "21-100" | "101-500" | "500+" {
  if (n <= 0) return "0";
  if (n === 1) return "1";
  if (n <= 5) return "2-5";
  if (n <= 20) return "6-20";
  if (n <= 100) return "21-100";
  if (n <= 500) return "101-500";
  return "500+";
}
```

### 5. Local database aggregation

Build local counts from existing schema:

- `organizations`: active organization bucket.
- `organization_memberships`: active member bucket.
- `agents`: agent bucket.
- `issues`: issue bucket and done issue bucket if useful.
- `heartbeat_runs`: run buckets by `created_at` / `started_at` / `finished_at`
  and status.

Suggested first-pass metrics:

- `organizations`
- `active_members_7d` — if reliable login/activity signal exists; otherwise use
  active memberships and name it `members` instead.
- `agents`
- `issues`
- `issues_done_7d`
- `agent_runs_7d`
- `succeeded_agent_runs_7d`
- `failed_agent_runs_7d`
- `completed_agent_work_loops_7d`

For `completed_agent_work_loops_7d`, start conservative. Candidate definition:

- an issue reached `status = 'done'` in the last 7 days and has a non-null
  execution run, or
- a `heartbeat_runs` row with `status = 'succeeded'`, tied to issue execution
  context, and followed by the issue becoming done.

If exact done timestamp is not available on issues, do not fake precision. Use a
lower-confidence first version based on succeeded issue-linked runs in the last 7
  days and name it `succeeded_issue_runs_7d`, then add a true loop metric when
  the product model has a durable close-out timestamp/event.

### 6. Local heartbeat state

Store local state under the instance root, not in product DB tables, for example:

- `~/.rudder/instances/<instance>/telemetry/instance-id`
- `~/.rudder/instances/<instance>/telemetry/state.json`

`state.json` can contain:

```json
{
  "last_attempted_at": "...",
  "last_succeeded_at": "...",
  "last_error_code": "timeout",
  "last_schema_version": 1
}
```

Do not store full response bodies if they could contain unexpected data. Store
short status/error codes only.

### 7. HTTP client behavior

- Method: `POST`.
- Headers:
  - `content-type: application/json`
  - `user-agent: rudder/<version> telemetry/schema-1`
- Timeout: 3 seconds by default.
- Body: strict schema payload.
- Treat `2xx` as success.
- Treat all other responses as failure for local state only.
- Never throw out to startup or request handlers.
- Add jitter: startup send after random 1-10 minutes; interval 24h +/- jitter.

### 8. Collector API

Deploy a separate telemetry collector from the product app if possible. If it
lives in the same server codebase, keep the route isolated from organization API
routes and do not require Rudder organization auth.

Endpoint:

```http
POST /api/telemetry/v1/heartbeat
content-type: application/json
```

Collector validation:

- require `schema_version = 1`
- require valid UUID `telemetry_instance_id`
- require known enum values for deployment/runtime/db/platform fields
- require all count fields to be bucket enum values
- reject unknown top-level fields if feasible
- cap body size, e.g. 16 KB
- rate-limit by instance id and IP-derived transient key
- return `204 No Content` or a tiny response such as `{ "ok": true }`

Collector must not accept arbitrary event names/payloads in v1. This avoids the
system turning into unbounded tracking infrastructure.

### 9. Collector storage model

Minimal tables:

```sql
create table telemetry_instances (
  telemetry_instance_id uuid primary key,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  rudder_version text not null,
  deployment_kind text not null,
  runtime_owner_kind text,
  local_env text,
  node_platform text,
  database_kind text,
  latest_counts jsonb not null,
  latest_features jsonb not null,
  schema_version integer not null
);

create table telemetry_heartbeats_daily (
  day date not null,
  telemetry_instance_id uuid not null,
  rudder_version text not null,
  deployment_kind text not null,
  database_kind text,
  counts jsonb not null,
  features jsonb not null,
  seen_count integer not null default 1,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  primary key (day, telemetry_instance_id)
);
```

The collector can upsert both tables on each accepted heartbeat. For product
reporting, use daily rows so weekly/monthly active instance counts do not depend
only on latest state.

Do not store:

- IP address
- user agent beyond coarse Rudder version if already in payload
- request path/query from the self-hosted instance
- arbitrary JSON fields outside the allowlist

### 10. Internal reporting queries

Examples the product team should get:

- WAIS: weekly active instances = count distinct instance ids in daily rows for
  the last 7 days.
- MAIS: monthly active instances = count distinct instance ids in daily rows for
  the last 30 days.
- New instances = `first_seen_at` in time window.
- Activated instances = latest or windowed rows where agents bucket != `0` and
  runs bucket != `0`.
- Work-loop instances = rows where completed/succeeded loop bucket != `0`.
- Version distribution = latest heartbeat per instance, grouped by version.

### 11. Tests

Local Rudder server tests:

- config parses disable and endpoint env vars correctly.
- instance id generation is random, stable across reads, and not derived from
  host data.
- payload builder emits only allowed fields and buckets counts.
- payload builder does not include known sensitive fields from orgs, users,
  agents, issues, prompts, or run excerpts.
- scheduler does not throw when collector fetch fails/times out.

Collector tests:

- accepts valid schema v1 heartbeat.
- rejects unknown fields / invalid buckets / invalid UUID / oversized body.
- upserts `telemetry_instances` and daily rows correctly.
- does not persist raw IP address.
- rate-limit path works.

E2E/operational smoke:

- run a local self-hosted server with telemetry disabled and assert no outbound
  request is attempted.
- run with a local mock collector endpoint and assert one valid heartbeat is
  received without content fields.

## What Is Your Testing Plan (QA)?

### Goal

Prove that telemetry gives useful adoption signal without collecting sensitive
content or affecting Rudder runtime reliability.

### Prerequisites

- Local test database with seeded organizations, memberships, agents, issues,
  and heartbeat runs.
- Mock collector server or fetch mock.
- Env matrix for disabled/enabled/default policies.

### Test Scenarios / Cases

1. Disabled telemetry:
   - `RUDDER_TELEMETRY_DISABLED=1`.
   - Expected: no instance id creation required, no network call, status says
     disabled.
2. Enabled telemetry happy path:
   - mock collector returns 204.
   - Expected: payload matches schema, local state records success.
3. Collector unreachable:
   - mock timeout/network failure.
   - Expected: Rudder startup succeeds and scheduler records local failure only.
4. Sensitive data seed:
   - seed org/user/agent/issue/run records with emails, names, prompt-like text,
     repo-like paths, and secrets.
   - Expected: serialized heartbeat contains none of those strings.
5. Bucket edges:
   - counts around 0, 1, 2, 5, 6, 20, 21, 100, 101, 500.
   - Expected: buckets are stable and documented.
6. Collector rejection:
   - send invalid schema/extra fields.
   - Expected: 400/422, no storage mutation.

### Pass / Fail

To be filled during implementation. This proposal should not be marked complete
until tests above pass and a local mock collector receives a real heartbeat.

## Documentation Changes

If implemented, update:

- public docs for self-hosted deployment/configuration
- privacy/telemetry page listing exactly collected fields
- `.env.example` or deployment env reference
- Admin/About UI copy
- product logic registry only after explicit approval for a concrete
  `doc/product/**` contract delta

Potential product contract area:

- a new deployment/telemetry contract or a control-plane observability contract
  stating that self-hosted telemetry is anonymous, content-free, transparent, and
  disableable.

## Open Issues

1. **Default policy**: default-on anonymous telemetry gives much better signal,
   but should only ship with clear logs, docs, and Settings/About visibility.
   Default-off is safer for trust but will undercount self-hosted usage.
2. **True work-loop metric**: if issues do not have a durable done timestamp or
   close-out event, v1 should avoid claiming precise completed-loop counts and
   use `succeeded_issue_runs_7d` until the model supports exact measurement.
3. **Collector ownership**: decide whether the collector is part of Rudder Cloud,
   a small separate service, or an edge/serverless endpoint.
4. **IP log retention**: application code can avoid storing IPs, but hosting and
   proxy logs need explicit retention/redaction policy.
5. **Desktop behavior**: decide whether desktop is always default-off, setup
   opt-in, or follows server self-hosted policy.
