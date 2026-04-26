# Agent Runtime Guide

Status: User-facing guide  
Last updated: 2026-02-17  
Audience: Operators setting up and running agents in Rudder

## 1. What this system does

Agents in Rudder do not run continuously.  
They run in **heartbeats**: short execution windows triggered by a wakeup.

Each heartbeat:

1. Starts the configured agent adapter (for example, Claude CLI or Codex CLI)
2. Gives it the current prompt/context
3. Lets it work until it exits, times out, or is cancelled
4. Stores results (status, token usage, errors, logs)
5. Updates the UI live

## 2. When an agent wakes up

An agent can be woken up in four ways:

- `timer`: scheduled interval (for example every 5 minutes)
- `assignment`: when work is assigned/checked out to that agent
- `on_demand`: manual wakeup (button/API)
- `automation`: system-triggered wakeup for future automations

If an agent is already running, new wakeups are merged (coalesced) instead of launching duplicate runs.

## 3. What to configure per agent

## 3.1 Adapter choice

Common choices:

- `claude_local`: runs your local `claude` CLI
- `codex_local`: runs your local `codex` CLI
- `process`: generic shell command adapter
- `http`: calls an external HTTP endpoint

For `claude_local` and `codex_local`, Rudder assumes the CLI is already installed and authenticated on the host machine.

## 3.2 Runtime behavior

In agent runtime settings, configure heartbeat policy:

- `enabled`: allow scheduled heartbeats
- `intervalSec`: timer interval (0 = disabled)
- `wakeOnAssignment`: wake when assigned work
- `wakeOnOnDemand`: allow ping-style on-demand wakeups
- `wakeOnAutomation`: allow system automation wakeups

## 3.3 Working directory and execution limits

For local adapters, set:

- `cwd` (working directory)
- `timeoutSec` (max runtime per heartbeat)
- `graceSec` (time before force-kill after timeout/cancel)
- optional env vars and extra CLI args

## 3.4 Prompt templates

You can set:

- `promptTemplate`: used for every run (first run and resumed sessions)

Templates support variables like `{{agent.id}}`, `{{agent.name}}`, and run context values.

## 4. Instruction And Context Loading Strategy

Rudder treats **stable instructions** and **dynamic run context** as different
layers. Do not put every useful fact into the always-loaded instruction surface.
The default strategy is:

1. Stable agent instructions define identity and standing behavior.
2. Enabled skills add reusable operating procedures.
3. The run scene adds only invariant rules for that scene.
4. Wake-source context adds the current task, comment, recovery, or chat state.
5. Project resource attachments add project-specific working references.
6. Organization resources stay queryable through the control plane and are not
   loaded into every run by default.

### 4.1 Stable Agent Instructions

Stable instructions come from the agent runtime configuration and managed
instruction bundle:

- `instructionsFilePath` / managed `AGENTS.md` for local coding runtimes
- adapter-owned config such as model, CLI args, sandbox flags, and prompt
  templates
- enabled Rudder organization/private/bundled skills resolved for that agent

These instructions should be long-lived and mostly cache-friendly. They should
describe who the agent is, what operating rules it follows, and which control
plane workflow to use. They should not duplicate issue descriptions, current
comments, one-off project notes, or the full organization resource catalog.

### 4.2 Scene Prompts

Each run has a scene:

- `heartbeat`: normal agent work loop
- `chat`: Messenger/Copilot conversation loop

Scene prompts hold invariant rules for that surface. For example, chat includes
reply-envelope and same-language rules, while heartbeat includes work-loop
coordination rules. Conditional behavior is injected only when active. Examples:

- plan mode guidance only when `planMode` is true
- operator profile only when profile fields are non-empty
- recovery instructions only for recovery runs
- selected-project metadata only when the conversation has a project context

### 4.3 Wake-Source Context

Heartbeat prompts are selected by wake source. Rudder injects enough immediate
context for the first turn to be useful without forcing the agent to rediscover
the trigger:

- assignment wakes include issue title, id, status, priority, and description
- mention/comment wakes include the relevant issue and wake comment
- recovery wakes include the original run id, failure summary, trigger, and
  recovery mode
- passive close-out wakes include the previous/origin run and the close-out
  reason

Agents should still fetch compact execution context through the CLI/API when
they need the current thread, ancestors, or fresh comments.

### 4.4 Resource Loading

Organization resources and project resources are intentionally different:

- **Organization Resources** are the reusable org-wide catalog. They can describe
  repos, folders, URLs, docs, and connector objects. They are available through
  the Resources API/UI, but they are not injected into every agent run or chat
  prompt by default.
- **Project Resources** are attachments from a project to org resources, with a
  project-specific role and note. When a heartbeat or chat run resolves a
  `projectId`, Rudder loads only that project's attached resources into
  `context.rudderWorkspace.resourcesPrompt`,
  `context.rudderWorkspace.orgResourcesPrompt` (legacy alias),
  `context.rudderResourcesPrompt`, and `context.rudderProjectResources`.

This keeps default context narrow. A project-linked run gets the resources the
board explicitly attached to that project. If the agent needs broader org-wide
background, it should query the org resource catalog itself instead of relying
on automatic prompt injection.

Runs with no project context receive no resource prompt by default.

### 4.5 Prompt Assembly Order

The effective prompt/context is assembled in this order:

1. adapter/runtime bootstrap and native instruction loading
2. enabled skills for the selected agent/runtime
3. scene-level invariant prompt sections
4. conditional scene sections such as plan mode or operator profile
5. selected project metadata, if any
6. project-attached resources, if any
7. wake-source task/comment/recovery context

The exact final prompt varies by adapter because local CLIs have different
native instruction and resume mechanisms. The policy above is the product
contract: broad org knowledge is discoverable, project-attached knowledge is
default context, and high-churn task state stays in wake/context sections rather
than stable instructions.

## 5. Session resume behavior

Rudder stores resumable session state per `(agent, taskKey, agentRuntimeType)`.
`taskKey` is derived from wakeup context (`taskKey`, `taskId`, or `issueId`).

- A heartbeat for the same task key reuses the previous session for that task.
- Different task keys for the same agent keep separate session state.
- If restore fails, adapters should retry once with a fresh session and continue.
- You can reset all sessions for an agent or reset one task session by task key.

Use session reset when:

- you significantly changed prompt strategy
- the agent is stuck in a bad loop
- you want a clean restart

## 6. Logs, status, and run history

For each heartbeat run you get:

- run status (`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- error text and stderr/stdout excerpts
- token usage/cost when available from the adapter
- full logs (stored outside core run rows, optimized for large output)

In local/dev setups, full logs are stored on disk under the configured run-log path.

## 7. Live updates in the UI

Rudder pushes runtime/activity updates to the browser in real time.

You should see live changes for:

- agent status
- heartbeat run status
- task/activity updates caused by agent work
- dashboard/cost/activity panels as relevant

If the connection drops, the UI reconnects automatically.

## 8. Common operating patterns

## 8.1 Simple autonomous loop

1. Enable timer wakeups (for example every 300s)
2. Keep assignment wakeups on
3. Use a focused prompt template
4. Watch run logs and adjust prompt/config over time

## 8.2 Event-driven loop (less constant polling)

1. Disable timer or set a long interval
2. Keep wake-on-assignment enabled
3. Use on-demand wakeups for manual nudges

## 8.3 Safety-first loop

1. Short timeout
2. Conservative prompt
3. Monitor errors + cancel quickly when needed
4. Reset sessions when drift appears

## 9. Troubleshooting

If runs fail repeatedly:

1. Check adapter command availability (`claude`/`codex` installed and logged in).
2. Verify `cwd` exists and is accessible.
3. Inspect run error + stderr excerpt, then full log.
4. Confirm timeout is not too low.
5. Reset session and retry.
6. Pause agent if it is causing repeated bad updates.

Typical failure causes:

- CLI not installed/authenticated
- bad working directory
- malformed adapter args/env
- prompt too broad or missing constraints
- process timeout

## 10. Security and risk notes

Local CLI adapters run unsandboxed on the host machine.

That means:

- prompt instructions matter
- configured credentials/env vars are sensitive
- working directory permissions matter

Start with least privilege where possible, and avoid exposing secrets in broad reusable prompts unless intentionally required.

## 11. Minimal setup checklist

1. Choose adapter (`claude_local` or `codex_local`).
2. Set `cwd` to the target workspace.
3. Keep the prompt template focused on stable identity and operating rules.
4. Attach project resources for project-specific repos, docs, and references.
5. Configure heartbeat policy (timer and/or assignment wakeups).
6. Trigger a manual wakeup.
7. Confirm run succeeds and session/token usage is recorded.
8. Watch live updates and iterate prompt/config.
