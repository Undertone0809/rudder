---
name: rudder-data-path-diagnostician-maintainer
description: >
  Diagnose Rudder pages or product surfaces that show missing, stale, sparse,
  or wrong data. Use when the user asks why a dev/prod/local Rudder screen has
  no Calendar events, no runs, no issues, wrong counts, empty dashboard data,
  broken chat output, or asks "这个数据从哪来", "为什么这里没数据", "prod z studio
  下的数据怎么没了", "是不是 UI/API/DB 的问题". Trace the evidence chain from UI
  query to API route, service aggregation, database rows, derived sources, org
  scoping, and runtime instance before proposing fixes or seed changes.
---

# Rudder Data Path Diagnostician Maintainer

Use this skill when the user's real problem is that a Rudder surface does not
show the data they expected.

The goal is to produce an evidence-backed data lineage and root cause, not to
guess from the screenshot. Most failures in this class are caused by one of:

- wrong runtime or organization
- empty source records
- filtering or date-window mismatch
- derived data that is not generated from the records the user expected
- API/service aggregation gap
- UI rendering or state merge bug
- stale seed/demo assumptions

## Use When

Use this skill for questions like:

- "为什么 Calendar 没数据"
- "这个 Dashboard 怎么是空的"
- "prod z studio 下这里怎么没有 run / issue / calendar"
- "这个 UI 的数据从哪里来"
- "看起来应该有数据，但页面没有显示"
- "这个数字和数据库/API 对不上"
- "是不是 seed 数据没有写进去"

This skill is useful across dev, prod-local Desktop, worktree previews, and
local production-style instances.

## Do Not Use When

Do not use this skill for:

- a single agent run transcript failure; use `debug-run-transcript-maintainer`
- creating demo or screenshot data from scratch; use `mock-data-maintainer`
- pure UI polish where the data is already known; use
  `rudder-ui-polish-maintainer`
- CI, release, npm, Desktop packaging, or Chrome automation infrastructure
- destructive cleanup of organizations or databases unless the user explicitly
  authorizes that separate operation

## Default Workflow

### 1. Confirm the symptom and target environment

Start by pinning down:

- surface: page, route, tab, card, chart, or screenshot region
- expected data: what the user believes should appear
- actual data: what is visible or returned
- runtime: dev, prod-local Desktop, worktree preview, or remote deployment
- organization: org id, URL key, display name, or selected org
- date window, filters, and selected project/agent when relevant

Verify the live target before trusting assumptions:

```bash
curl -sS <base-url>/api/health
curl -sS <base-url>/api/orgs
```

For prod-local or Desktop investigations, require evidence that the active
runtime is the expected local environment before inspecting or writing data.

### 2. Identify the UI data request

Find the component and data hook or API client that feeds the surface. Record:

- query key or effect dependency
- endpoint path and parameters
- selected org/project/agent/date filters
- fallback, loading, error, and empty-state behavior
- client-side merge or normalization logic

Do not stop at "the component renders an empty array." Trace where that array
comes from.

### 3. Inspect the API and service chain

Follow the endpoint into server code:

- route path and auth/org access checks
- request validators and default date windows
- service function and aggregation logic
- derived sources such as heartbeat runs, automation runs, activity, messenger
  context snapshots, calendar projections, cost rows, or external sync tables
- response shape and filtering rules

Compare route behavior to the UI expectation. Many bugs are not missing rows;
they are mismatched assumptions about which source is authoritative.

### 4. Read source data safely

Use read-only API calls or SQL queries first. Verify:

- records exist for the selected organization
- timestamps fall inside the UI date window
- statuses match the service filters
- linked ids are present and point to the expected issue, agent, project, run,
  automation, or conversation
- soft-deleted, archived, hidden, or permission-gated rows are not being
  mistaken for visible data

Keep every query organization-scoped. Do not write, reseed, or delete data
while diagnosing unless the user explicitly changes the task from diagnosis to
repair.

### 5. Classify the root cause

Use one primary classification:

- `wrong-target`: the browser or process is pointed at the wrong instance or org
- `source-empty`: the source table/API has no matching records
- `filter-window`: data exists but the selected date/status/project/agent
  window excludes it
- `derived-gap`: source records exist but the derived feed is not generated or
  linked
- `contract-gap`: API response lacks data the UI needs
- `render-gap`: API response is correct but UI state/rendering hides it
- `seed-gap`: demo or fixture data was expected but not seeded into this target
- `sync-gap`: external provider or import has not produced local records

If multiple causes contribute, identify the first broken boundary and the
downstream symptoms separately.

### 6. Recommend or implement the fix

By default, report the diagnosis and fix options. Implement only when the user
asked to fix it or the next safe code change is obvious.

Fix choices should match the cause:

- wrong target: point the browser/process at the right runtime and verify
- source empty or seed gap: use `mock-data-maintainer` or a scoped seed path
- filter-window: adjust UI defaults or make filters visible
- derived gap: fix service aggregation or generation logic
- contract gap: sync shared/server/UI contract and tests
- render gap: fix component state/rendering and verify visually
- sync gap: repair provider sync or report external prerequisite

For user-visible behavior changes, add or update E2E coverage when the repo
rules require it.

## Output Shape

Keep the final answer concrete:

```markdown
Root cause: <classification and one-sentence cause>

Evidence:
- UI requested ...
- API returned ...
- Source data shows ...
- Service logic does ...

Fix:
- ...

Validation:
- ...
```

When useful, include a short lineage:

```text
Calendar page -> GET /api/orgs/:orgId/calendar/events
  -> calendar_events rows
  -> heartbeat_runs projections
  -> projected heartbeat schedules
```

## Safety Rules

- Diagnosis is read-only by default.
- Verify runtime and organization before any write.
- Never use unscoped SQL against production-like data.
- Do not invent demo records to make a bug disappear.
- Do not conflate "no persisted rows" with "no product data" when the surface
  intentionally derives events from runs, schedules, or activity.
- If the user provides a screenshot, use it to locate the symptom, not as proof
  of the backend state.

## Handoff Rules

If code changed, follow normal Rudder validation, commit, and push rules. Stage
only files changed for this task and keep unrelated dirty worktree changes out
of the commit.

If no code changed, hand off the exact current state and next repair command or
file path. Do not claim the issue is fixed when only the data lineage was
explained.
