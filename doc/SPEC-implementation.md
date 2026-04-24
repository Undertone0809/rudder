# Rudder V1 Implementation Spec

Status: Implementation contract for first release (V1)
Date: 2026-03-26
Audience: Product, engineering, and agent-integration authors
Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code

## 1. Document Role

`SPEC.md` remains the long-horizon product spec.
This document is the concrete, build-ready V1 contract.
When there is a conflict, `SPEC-implementation.md` controls V1 behavior.

## 2. V1 Outcomes

Rudder V1 must provide a full control-plane loop for autonomous agents:

1. A human board creates an organization and defines goals.
2. The board creates and manages agents in an org tree.
3. Agents receive and execute tasks via heartbeat invocations.
4. All work is tracked through tasks, comments, and chat conversations with audit visibility.
5. Token/cost usage is reported and budget limits can stop work.
6. The board can intervene anywhere (pause agents/tasks, override decisions).

Success means one operator can run a small AI-native organization end-to-end with clear visibility and control.
The V1 north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## 3. Explicit V1 Product Decisions

These decisions close open questions from `SPEC.md` for V1.

| Topic | V1 Decision |
|---|---|
| Tenancy | Single-tenant deployment, multi-organization data model |
| Organization model | Organization is first-order; all business entities are organization-scoped |
| Board | Single human board operator per deployment |
| Org graph | Strict tree (`reports_to` nullable root); no multi-manager reporting |
| Visibility | Full visibility to board and all agents in same organization |
| Communication | Issues remain the execution surface; Messenger is the board communication shell that unifies chat conversations and inbox-style attention streams |
| Task ownership | Single assignee; atomic checkout required for `in_progress` transition |
| Recovery | No automatic reassignment; work recovery stays explicit/auditable; visible same-agent recovery retry is allowed |
| Issue close-out | Successful issue-backed runs must leave a close-out signal or Rudder may queue bounded same-agent passive follow-up |
| Agent adapters | Built-in `process` and `http` adapters |
| Auth | Mode-dependent human auth (`local_trusted` implicit board in current code; authenticated mode uses sessions), API keys for agents |
| Budget period | Monthly UTC calendar window |
| Budget enforcement | Soft alerts + hard limit auto-pause |
| Deployment modes | Canonical model is `local_trusted` + `authenticated` with `private/public` exposure policy (see `doc/DEPLOYMENT-MODES.md`) |

## 4. Current Baseline (Repo Snapshot)

As of 2026-02-17, the repo already includes:

- Node + TypeScript backend with REST CRUD for `agents`, `projects`, `goals`, `issues`, `activity`
- React UI pages for dashboard/agents/projects/goals/issues lists
- PostgreSQL schema via Drizzle with embedded PostgreSQL fallback when `DATABASE_URL` is unset

V1 implementation extends this baseline into an organization-centric, governance-aware control plane.

## 5. V1 Scope

## 5.1 In Scope

- Organization lifecycle (create/list/get/update/archive)
- Goal hierarchy linked to organization mission
- Agent lifecycle with org structure and agent runtime configuration
- Task lifecycle with parent/child hierarchy and comments
- Chat lifecycle with conversation, message, context-link, attachment, and convert-to-issue flows
- Atomic task checkout and explicit task status transitions
- Board approvals for hires and CEO strategy proposal
- Heartbeat invocation, status tracking, and cancellation
- Cost event ingestion and rollups (agent/task/project/organization)
- Budget settings and hard-stop enforcement
- Board web UI for dashboard, Organization Structure, chat, tasks, agents, approvals, costs
- Agent-facing API contract (task read/write, heartbeat report, cost report)
- Auditable activity log for all mutating actions

## 5.2 Out of Scope (V1)

- Plugin framework and third-party extension SDK
- Revenue/expense accounting beyond model/token costs
- Knowledge base subsystem
- Public marketplace (ClipHub)
- Multi-board governance or role-based human permission granularity
- Automatic self-healing orchestration (auto-reassign/retry planners)

## 6. Architecture

## 6.1 Runtime Components

- `server/`: REST API, auth, orchestration services
- `ui/`: Board operator interface
- `packages/db/`: Drizzle schema, migrations, DB clients (Postgres)
- `packages/shared/`: Shared API types, validators, constants

## 6.2 Data Stores

- Primary: PostgreSQL
- Local default: embedded PostgreSQL at `~/.rudder/instances/default/db`
- Optional local prod-like: Docker Postgres
- Optional hosted: Supabase/Postgres-compatible
- File/object storage:
  - local default: `~/.rudder/instances/default/data/storage` (`local_disk`)
  - cloud: S3-compatible object storage (`s3`)

## 6.3 Background Processing

A lightweight scheduler/worker in the server process handles:

- heartbeat trigger checks
- stuck run detection
- budget threshold checks

Separate queue infrastructure is not required for V1.

## 7. Canonical Data Model (V1)

All core tables include `id`, `created_at`, `updated_at` unless noted.

## 7.0 Auth Tables

Human auth tables (`users`, `sessions`, and provider-specific auth artifacts) are managed by the selected auth library. This spec treats them as required dependencies and references `users.id` where user attribution is needed.

## 7.1 `organizations`

- `id` uuid pk
- `name` text not null
- `description` text null
- `status` enum: `active | paused | archived`

Invariant: every business record belongs to exactly one organization.

## 7.2 `agents`

- `id` uuid pk
- `org_id` uuid fk `organizations.id` not null
- `name` text not null
- `role` text not null
- `title` text null
- `status` enum: `active | paused | idle | running | error | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` text null
- `adapter_type` enum: `process | http`
- `adapter_config` jsonb not null
- `context_mode` enum: `thin | fat` default `thin`
- `budget_monthly_cents` int not null default 0
- `spent_monthly_cents` int not null default 0
- `last_heartbeat_at` timestamptz null

Invariants:

- agent and manager must be in same organization
- no cycles in reporting tree
- `terminated` agents cannot be resumed

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` not null
- `org_id` uuid fk `organizations.id` not null
- `name` text not null
- `key_hash` text not null
- `last_used_at` timestamptz null
- `revoked_at` timestamptz null

Invariant: plaintext key shown once at creation; only hash stored.

## 7.4 `goals`

- `id` uuid pk
- `org_id` uuid fk not null
- `title` text not null
- `description` text null
- `level` enum: `organization | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` enum: `planned | active | achieved | cancelled`

Invariant: at least one root `organization` level goal per organization.

## 7.5 `projects`

- `id` uuid pk
- `org_id` uuid fk not null
- `goal_id` uuid fk `goals.id` null
- `name` text not null
- `description` text null
- `status` enum: `backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` date null

## 7.6 `issues` (core task entity)

- `id` uuid pk
- `org_id` uuid fk not null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` text not null
- `description` text null
- `status` enum: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` enum: `critical | high | medium | low`
- `assignee_agent_id` uuid fk `agents.id` null
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- `request_depth` int not null default 0
- `billing_code` text null
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `cancelled_at` timestamptz null

Invariants:

- single assignee only
- task must trace to organization goal chain via `goal_id`, `parent_id`, or project-goal linkage
- `in_progress` requires assignee
- terminal states: `done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `org_id` uuid fk not null
- `issue_id` uuid fk `issues.id` not null
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` text not null

## 7.8 `heartbeat_runs`

- `id` uuid pk
- `org_id` uuid fk not null
- `agent_id` uuid fk not null
- `invocation_source` enum: `scheduler | manual | callback`
- `status` enum: `queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `external_run_id` text null
- `context_snapshot` jsonb null

## 7.9 `cost_events`

- `id` uuid pk
- `org_id` uuid fk not null
- `agent_id` uuid fk `agents.id` not null
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` text null
- `provider` text not null
- `model` text not null
- `input_tokens` int not null default 0
- `output_tokens` int not null default 0
- `cost_cents` int not null
- `occurred_at` timestamptz not null

Invariant: each event must attach to agent and organization; rollups are aggregation, never manually edited.

## 7.10 `approvals`

- `id` uuid pk
- `org_id` uuid fk not null
- `type` enum: `hire_agent | approve_ceo_strategy`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` enum: `pending | approved | rejected | cancelled`
- `payload` jsonb not null
- `decision_note` text null
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` timestamptz null

## 7.11 `activity_log`

- `id` uuid pk
- `org_id` uuid fk not null
- `actor_type` enum: `agent | user | system`
- `actor_id` uuid/text not null
- `action` text not null
- `entity_type` text not null
- `entity_id` uuid/text not null
- `details` jsonb null
- `created_at` timestamptz not null default now()

## 7.12 `organization_secrets` + `organization_secret_versions`

- Secret values are not stored inline in `agents.adapter_config.env`.
- Agent env entries should use secret refs for sensitive values.
- `organization_secrets` tracks identity/provider metadata per organization.
- `organization_secret_versions` stores encrypted/reference material per version.
- Default provider in local deployments: `local_encrypted`.

Operational policy:

- Config read APIs redact sensitive plain values.
- Activity and approval payloads must not persist raw sensitive values.
- Config revisions may include redacted placeholders; such revisions are non-restorable for redacted fields.

## 7.13 Required Indexes

- `agents(org_id, status)`
- `agents(org_id, reports_to)`
- `issues(org_id, status)`
- `issues(org_id, assignee_agent_id, status)`
- `issues(org_id, parent_id)`
- `issues(org_id, project_id)`
- `cost_events(org_id, occurred_at)`
- `cost_events(org_id, agent_id, occurred_at)`
- `heartbeat_runs(org_id, agent_id, started_at desc)`
- `approvals(org_id, status, type)`
- `activity_log(org_id, created_at desc)`
- `assets(org_id, created_at desc)`
- `assets(org_id, object_key)` unique
- `issue_attachments(org_id, issue_id)`
- `organization_secrets(org_id, name)` unique
- `organization_secret_versions(secret_id, version)` unique

## 7.14 `assets` + `issue_attachments`

- `assets` stores provider-backed object metadata (not inline bytes):
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `provider` enum/text (`local_disk | s3`)
  - `object_key` text not null
  - `content_type` text not null
  - `byte_size` int not null
  - `sha256` text not null
  - `original_filename` text null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
- `issue_attachments` links assets to issues/comments:
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `asset_id` uuid fk not null
  - `issue_comment_id` uuid fk null

## 7.15 `documents` + `document_revisions` + `issue_documents`

- `documents` stores editable text-first documents:
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `title` text null
  - `format` text not null (`markdown`)
  - `latest_body` text not null
  - `latest_revision_id` uuid null
  - `latest_revision_number` int not null
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/text fk null
  - `updated_by_agent_id` uuid fk null
  - `updated_by_user_id` uuid/text fk null
- `document_revisions` stores append-only history:
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `document_id` uuid fk not null
  - `revision_number` int not null
  - `body` text not null
  - `change_summary` text null
- `issue_documents` links documents to issues with a stable workflow key:
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `issue_id` uuid fk not null
  - `document_id` uuid fk not null
  - `key` text not null (`plan`, `design`, `notes`, etc.)

## 7.16 `chat_conversations` + `chat_messages` + `chat_context_links` + `chat_attachments`

- `chat_conversations`
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `status` enum: `active | resolved | archived`
  - `title` text not null
  - `summary` text null
  - `preferred_agent_id` uuid fk `agents.id` null
  - `routed_agent_id` uuid fk `agents.id` null
  - `primary_issue_id` uuid fk `issues.id` null
  - `issue_creation_mode` enum: `manual_approval | auto_create`
  - `operation_mode` enum: `discuss_only | allow_light_ops`
  - `created_by_user_id` uuid fk `users.id` null
  - `last_message_at` timestamptz null
  - `resolved_at` timestamptz null
- `chat_messages`
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `conversation_id` uuid fk not null
  - `role` enum: `user | assistant | system`
  - `kind` enum: `message | issue_proposal | operation_proposal | routing_suggestion | system_event`
  - `body` text not null
  - `structured_payload` jsonb null
  - `approval_id` uuid fk `approvals.id` null
- `chat_context_links`
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `conversation_id` uuid fk not null
  - `entity_type` enum: `issue | project | agent`
  - `entity_id` uuid/text not null
  - `metadata` jsonb null
- `chat_attachments`
  - `id` uuid pk
  - `org_id` uuid fk not null
  - `conversation_id` uuid fk not null
  - `message_id` uuid fk not null
  - `asset_id` uuid fk not null

Invariants:

- a conversation belongs to exactly one organization
- a conversation may have zero or one primary issue
- a conversation may reference many issues, projects, and agents
- chat is an intake surface; durable execution still flows through issues

## 8. State Machines

## 8.1 Agent Status

Allowed transitions:

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused` (requires cancel flow)
- `paused -> idle`
- `* -> terminated` (board only, irreversible)

## 8.2 Issue Status

Allowed transitions:

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- terminal: `done`, `cancelled`

Side effects:

- entering `in_progress` sets `started_at` if null
- entering `done` sets `completed_at`
- entering `cancelled` sets `cancelled_at`

Issue-backed run close-out:

- a successful run on a `todo` or `in_progress` issue is expected to leave one closure signal before exit
- closure signals are a run-attributed issue comment, moving the issue out of `todo` / `in_progress`, reassignment, or an existing deferred issue wake
- if no closure signal exists and near-term timer heartbeat continuity is not credible, Rudder queues a same-agent `issue_passive_followup` wake after a short cooldown
- passive follow-up is bounded to two attempts; after that Rudder emits `issue.closure_needs_operator_review` without mutating the issue workflow status

## 8.3 Approval Status

- `pending -> approved | rejected | cancelled`
- terminal after decision

## 9. Auth and Permissions

## 9.1 Board Auth

- Session-based auth for human operator
- Board has full read/write across all organizations in deployment
- Every board mutation writes to `activity_log`

## 9.2 Agent Auth

- Bearer API key mapped to one agent and organization
- Agent key scope:
  - read org/task/organization context for own organization
  - read/write own assigned tasks and comments
  - create tasks/comments for delegation
  - report heartbeat status
  - report cost events
- Agent cannot:
  - bypass approval gates
  - modify organization-wide budgets directly
  - mutate auth/keys

## 9.3 Permission Matrix (V1)

| Action | Board | Agent |
|---|---|---|
| Create organization | yes | no |
| Hire/create agent | yes (direct) | request via approval |
| Pause/resume agent | yes | no |
| Create/update task | yes | yes |
| Force reassign task | yes | limited |
| Approve strategy/hire requests | yes | no |
| Report cost | yes | yes |
| Set organization budget | yes | no |
| Set subordinate budget | yes | yes (manager subtree only) |

## 10. API Contract (REST)

All endpoints are under `/api` and return JSON.

## 10.1 Organizations

- `GET /orgs`
- `POST /orgs`
- `GET /orgs/:orgId`
- `PATCH /orgs/:orgId`
- `PATCH /orgs/:orgId/branding`
- `POST /orgs/:orgId/archive`

## 10.2 Goals

- `GET /orgs/:orgId/goals`
- `POST /orgs/:orgId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId` (soft delete optional, hard delete board-only)

## 10.3 Agents

- `GET /orgs/:orgId/agents`
- `POST /orgs/:orgId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys` (create API key)
- `POST /agents/:agentId/heartbeat/invoke`
- `issue_passive_followup` is an internal same-agent wake reason created by issue close-out governance, not a public reassignment surface

## 10.4 Tasks (Issues)

- `GET /orgs/:orgId/issues`
- `POST /orgs/:orgId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `GET /issues/:issueId/documents`
- `GET /issues/:issueId/documents/:key`
- `PUT /issues/:issueId/documents/:key`
- `GET /issues/:issueId/documents/:key/revisions`
- `DELETE /issues/:issueId/documents/:key`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /orgs/:orgId/issues/:issueId/attachments` (multipart upload)
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 Atomic Checkout Contract

`POST /issues/:issueId/checkout` request:

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

Server behavior:

1. single SQL update with `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)`
2. if updated row count is 0, return `409` with current owner/status
3. successful checkout sets `assignee_agent_id`, `status = in_progress`, and `started_at`

## 10.5 Projects

- `GET /orgs/:orgId/projects`
- `POST /orgs/:orgId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 Approvals

- `GET /orgs/:orgId/approvals?status=pending`
- `POST /orgs/:orgId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 Cost and Budgets

- `POST /orgs/:orgId/cost-events`
- `GET /orgs/:orgId/costs/summary`
- `GET /orgs/:orgId/costs/by-agent`
- `GET /orgs/:orgId/costs/by-project`
- `PATCH /orgs/:orgId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 Activity and Dashboard

- `GET /orgs/:orgId/activity`
- `GET /orgs/:orgId/dashboard`

Dashboard payload must include:

- active/running/paused/error agent counts
- open/in-progress/blocked/done issue counts
- month-to-date spend and budget utilization
- pending approvals count

## 10.9 Chat

- `GET /orgs/:orgId/chats`
- `POST /orgs/:orgId/chats`
- `GET /chats/:id`
- `PATCH /chats/:id`
- `GET /chats/:id/messages`
- `POST /chats/:id/messages`
- `POST /orgs/:orgId/chats/:chatId/attachments`
- `POST /chats/:id/context-links`
- `POST /chats/:id/convert-to-issue`
- `POST /chats/:id/resolve`

Chat behavior requirements:

- Chat is organization-scoped
- Chat is rendered inside the broader `Messenger` board communication shell alongside inbox-style attention streams
- the built-in assistant asks clarifying questions before proposing work when requirements are incomplete
- a conversation can exist without any issue
- a conversation can convert into at most one primary issue
- chat-driven issue creation and lightweight operations reuse the approval system
- board users can optionally store a personal chat profile with `nickname` and `more_about_you`
- the built-in assistant may use that per-user profile as prompt context only when at least one profile field is non-empty

## 10.10 Error Semantics

- `400` validation error
- `401` unauthenticated
- `403` unauthorized
- `404` not found
- `409` state conflict (checkout conflict, invalid transition)
- `422` semantic rule violation
- `500` server error

## 11. Heartbeat and Agent Runtime Contract

## 11.1 Agent Runtime Interface

```ts
interface AgentRuntime {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

## 11.2 Process Runtime

Config shape:

```json
{
  "command": "string",
  "args": ["string"],
  "cwd": "string",
  "env": {"KEY": "VALUE"},
  "timeoutSec": 900,
  "graceSec": 15
}
```

Behavior:

- spawn child process
- stream stdout/stderr to run logs
- mark run status on exit code/timeout
- cancel sends SIGTERM then SIGKILL after grace

## 11.3 HTTP Runtime

Config shape:

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

Behavior:

- invoke by outbound HTTP request
- 2xx means accepted
- non-2xx marks failed invocation
- optional callback endpoint allows asynchronous completion updates

## 11.4 Context Delivery

- `thin`: send IDs and pointers only; agent fetches context via API
- `fat`: include current assignments, goal summary, budget snapshot, and recent comments

## 11.5 Scheduler Rules

Per-agent schedule fields in `adapter_config`:

- `enabled` boolean
- `intervalSec` integer (minimum 30)
- `maxConcurrentRuns` fixed at `1` for V1

Scheduler must skip invocation when:

- agent is paused/terminated
- an existing run is active
- hard budget limit has been hit

## 12. Governance and Approval Flows

## 12.1 Hiring

1. Agent or board creates `approval(type=hire_agent, status=pending, payload=agent draft)`.
2. Board approves or rejects.
3. On approval, server creates agent row and initial API key (optional).
4. Decision is logged in `activity_log`.

Board can bypass request flow and create agents directly via UI; direct create is still logged as a governance action.

## 12.2 CEO Strategy Approval

1. CEO posts strategy proposal as `approval(type=approve_ceo_strategy)`.
2. Board reviews payload (plan text, initial structure, high-level tasks).
3. Approval unlocks execution state for CEO-created delegated work.

Before first strategy approval, CEO may only draft tasks, not transition them to active execution states.

## 12.3 Board Override

Board can at any time:

- pause/resume/terminate any agent
- reassign or cancel any task
- edit budgets and limits
- approve/reject/cancel pending approvals

## 13. Cost and Budget System

## 13.1 Budget Layers

- organization monthly budget
- agent monthly budget
- optional project budget (if configured)

## 13.2 Enforcement Rules

- soft alert default threshold: 80%
- hard limit: at 100%, trigger:
  - set agent status to `paused`
  - block new checkout/invocation for that agent
  - emit high-priority activity event

Board may override by raising budget or explicitly resuming agent.

## 13.3 Cost Event Ingestion

`POST /orgs/:orgId/cost-events` body:

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

Validation:

- non-negative token counts
- `costCents >= 0`
- organization ownership checks for all linked entities

## 13.4 Rollups

Read-time aggregate queries are acceptable for V1.
Materialized rollups can be added later if query latency exceeds targets.

## 14. UI Requirements (Board App)

V1 UI routes:

- `/` dashboard
- `/orgs` organization list/create
- `/messenger` unified board communication shell
- `/messenger/chat/:conversationId` chat thread inside Messenger
- `/messenger/issues` issue aggregate thread
- `/messenger/approvals` approval aggregate thread
- `/messenger/approvals/:approvalId` approval modal state inside Messenger
- `/messenger/system/:threadKind` system aggregate threads
- `/chat` legacy chat entry surface
- `/inbox` legacy attention surface
- `/orgs/:id/org` Organization Structure and agent status
- `/orgs/:id/tasks` task list/kanban
- `/orgs/:id/agents/:agentId` agent detail
- `/orgs/:id/costs` cost and budget dashboard
- `/orgs/:id/activity` audit/event stream

Required UX behaviors:

- global organization selector
- Chat is available as a top-level board surface
- System Settings include a user-level Profile page with `Your nickname` and `More about you`
- quick actions: pause/resume agent, create task, approve/reject request
- conflict toasts on atomic checkout failure
- no silent background failures; every failed run visible in UI

## 15. Operational Requirements

## 15.1 Environment

- Node 20+
- `DATABASE_URL` optional
- if unset, auto-use PGlite and push schema

## 15.2 Migrations

- Drizzle migrations are source of truth
- no destructive migration in-place for V1 upgrade path
- provide migration script from existing minimal tables to organization-scoped schema

## 15.3 Logging and Audit

- structured logs (JSON in production)
- request ID per API call
- every mutation writes `activity_log`

## 15.4 Reliability Targets

- API p95 latency under 250 ms for standard CRUD at 1k tasks/organization
- heartbeat invoke acknowledgement under 2 s for process adapter
- no lost approval decisions (transactional writes)

## 16. Security Requirements

- store only hashed agent API keys
- redact secrets in logs (`adapter_config`, auth headers, env vars)
- CSRF protection for board session endpoints
- rate limit auth and key-management endpoints
- strict organization boundary checks on every entity fetch/mutation

## 17. Testing Strategy

## 17.1 Unit Tests

- state transition guards (agent, issue, approval)
- budget enforcement rules
- adapter invocation/cancel semantics

## 17.2 Integration Tests

- atomic checkout conflict behavior
- approval-to-agent creation flow
- cost ingestion and rollup correctness
- pause while run is active (graceful cancel then force kill)

## 17.3 End-to-End Tests

- board creates organization -> hires CEO -> approves strategy -> CEO receives work
- agent reports cost -> budget threshold reached -> auto-pause occurs
- task delegation across teams with request depth increment

## 17.4 Regression Suite Minimum

A release candidate is blocked unless these pass:

1. auth boundary tests
2. checkout race test
3. hard budget stop test
4. agent pause/resume test
5. dashboard summary consistency test

## 18. Delivery Plan

## Milestone 1: Organization Core and Auth

- add `organizations` and organization scoping to existing entities
- add board session auth and agent API keys
- migrate existing API routes to organization-aware paths

## Milestone 2: Task and Governance Semantics

- implement atomic checkout endpoint
- implement issue comments and lifecycle guards
- implement approvals table and hire/strategy workflows

## Milestone 3: Heartbeat and Agent Runtime

- implement adapter interface
- ship `process` adapter with cancel semantics
- ship `http` adapter with timeout/error handling
- persist heartbeat runs and statuses

## Milestone 4: Cost and Budget Controls

- implement cost events ingestion
- implement monthly rollups and dashboards
- enforce hard limit auto-pause

## Milestone 5: Board UI Completion

- add organization selector and Organization Structure view
- add approvals and cost pages

## Milestone 6: Hardening and Release

- full integration/e2e suite
- seed/demo organization templates for local testing
- release checklist and docs update

## 19. Acceptance Criteria (Release Gate)

V1 is complete only when all criteria are true:

1. A board user can create multiple organizations and switch between them.
2. An organization can run at least one active heartbeat-enabled agent.
3. Task checkout is conflict-safe with `409` on concurrent claims.
4. Agents can update tasks/comments and report costs with API keys only.
5. Board can approve/reject hire and CEO strategy requests in UI.
6. Budget hard limit auto-pauses an agent and prevents new invocations.
7. Dashboard shows accurate counts/spend from live DB data.
8. Every mutation is auditable in activity log.
9. App runs with embedded PostgreSQL by default and with external Postgres via `DATABASE_URL`.
10. Chat can clarify requests, create at most one primary issue per conversation, and preserve audit-visible proposal history.

## 20. Post-V1 Backlog (Explicitly Deferred)

- plugin architecture
- richer workflow-state customization per team
- milestones/labels/dependency graph depth beyond V1 minimum
- realtime transport optimization (SSE/WebSockets)
- public template marketplace integration (ClipHub)

## 21. Organization Portability Package (V1 Addendum)

V1 supports organization import/export using a portable package contract:

- markdown-first package rooted at `ORGANIZATION.md`
- implicit folder discovery by convention
- `.rudder.yaml` sidecar for Rudder-specific fidelity
- canonical base package uses schema `agentorganizations/v1`
- common conventions:
  - `agents/<slug>/AGENTS.md`
  - `teams/<slug>/TEAM.md`
  - `projects/<slug>/PROJECT.md`
  - `projects/<slug>/tasks/<slug>/TASK.md`
  - `tasks/<slug>/TASK.md`
  - `skills/<slug>/SKILL.md`

Export/import behavior in V1:

- export emits a clean vendor-neutral markdown package plus `.rudder.yaml`
- projects and starter tasks are opt-in export content rather than default package content
- recurring `TASK.md` entries use `recurring: true` in the base package and Rudder automation fidelity in `.rudder.yaml`
- Rudder imports recurring task packages as automations instead of downgrading them to one-time issues
- export strips environment-specific paths (`cwd`, local instruction file paths, inline prompt duplication) while preserving portable project repo/workspace metadata such as `repoUrl`, refs, and workspace-policy references keyed in `.rudder.yaml`
- export never includes secret values; env inputs are reported as portable declarations instead
- import supports target modes:
  - create a new organization
  - import into an existing organization
- import recreates exported project workspaces and remaps portable workspace keys back to target-local workspace ids
- import forces imported agent timer heartbeats off so packages never start scheduled runs implicitly
- import supports collision strategies: `rename`, `skip`, `replace`
- import supports preview (dry-run) before apply
- GitHub imports warn on unpinned refs instead of blocking

## 22. Skill Reference Grammar

Skill references shown to users are scope-aware and stable:

- organization scope: `org/<orgUrlKey>/<skillSlug>`
- agent-context scope: `org/<orgUrlKey>/<agentUrlKey>/<skillSlug>`
- bundled Rudder skills: `rudder/<skillSlug>`

Rules:

- `organization.urlKey` is the stable public organization segment and does not change when the organization name changes
- only Rudder-owned bundled skill directories are exposed through the bundled surface; community presets seed into the organization library as optional organization skills instead
- existing internal skill keys remain valid as compatibility input, but the UI should render the readable public form
- markdown link text uses the readable public reference, while the link target still points at the real `SKILL.md` path
- search and selection should work from installed organization skills only; agent snapshot internals are not part of the picker surface
