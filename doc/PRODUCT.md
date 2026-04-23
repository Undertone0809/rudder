# Rudder — Product Definition

## What It Is

Rudder is an orchestration and control platform for agent work, and the operating layer for agent teams. It organizes goals, tasks, knowledge, and workflows into an executable structure, enabling agents to work within clear boundaries, collaborate, and move work forward.

One Rudder instance can run multiple organizations. An **organization** is the first-order product object.

The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## Core Concepts

### Organization

An organization has:

- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
- **Employees** — every employee is an AI agent
- **Organization Structure** — who reports to whom
- **Revenue and expenses** — tracked at the organization level
- **Task hierarchy** — all work traces back to the organization goal

### Employees and Agents

Every employee is an agent. When you create an organization, you start by defining the CEO, then build out from there.

Each employee has:

- **Agent runtime type + config** — how this agent runs and what defines its identity and behavior. This is runtime-specific. Rudder does not prescribe the prompt or runtime format; the runtime does.
- **Role and reporting** — their title, who they report to, who reports to them
- **Capabilities description** — a short paragraph on what this agent does and when it is relevant

Example: a CEO agent reviews organization metrics, reprioritizes, and assigns strategic initiatives on each heartbeat. An engineer agent checks assigned work, picks the highest priority task, and works it.

### Agent Execution

There are two fundamental modes for running an agent heartbeat:

1. **Run a command** — Rudder starts a process and tracks it.
2. **Fire-and-forget a request** — Rudder wakes an externally running agent through an HTTP/webhook call.

Rudder provides useful built-ins, but does not require a single agent runtime.

### Task Management

Task management is hierarchical. At any moment, every piece of work must trace back to the organization’s top-level goal through a chain of parent tasks.

Tasks exist in service of parent tasks all the way up to the organization goal. That is how autonomous agents answer "why am I doing this?"

### Chat

Chat is a first-class intake and clarification surface in Rudder.

- It helps clarify requests before work starts.
- It can suggest routing, draft issue proposals, and propose lightweight approval-gated actions.
- It is not the long-running execution surface.
- Durable execution and tracking remain issue-centric.

Chat is now part of a broader board communication shell that will be surfaced as `Messenger`. The intent is to unify chat conversations with inbox-style attention streams without turning Rudder into a generic chat product.
The board entry point should be `Messenger`, with legacy `/chat` and `/inbox` routes treated as compatibility redirects during the transition.

## Principles

1. **Unopinionated about agent runtimes.** Rudder orchestrates agents; it does not dictate how they are built.
2. **Organization is the unit of operation.** Everything lives under an organization. One Rudder instance, many organizations.
3. **Runtime config defines the agent.** Every agent has an agent runtime type and configuration that controls its identity and behavior.
4. **All work traces to the goal.** If a task cannot be explained in terms of the organization goal, it should not exist.
5. **Control plane, not execution plane.** Rudder coordinates. Agents run wherever they run and phone home.

## User Flow (Dream Scenario)

1. Open Rudder and create a new organization
2. Define the organization goal
3. Create the CEO
   - choose an agent runtime
   - configure the runtime
   - review and approve the CEO’s proposed strategic breakdown
4. Define the CEO’s reports
5. Define their reports
6. Set budgets and define initial strategic work
7. Hit go — agents start heartbeats and the organization runs

## Guidelines

There are two runtime modes Rudder must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/DEPLOYMENT-MODES.md`.

## Further Detail

See [SPEC.md](./SPEC.md) for the full technical specification and [TASKS.md](./TASKS.md) for the task management data model.

---

Rudder’s core identity is a **control plane for autonomous AI organizations**, centered on **organizations, Organization Structure, goals, issues/comments, chat intake, heartbeats, budgets, approvals, and board governance**.

## What Rudder should do vs. not do

**Do**

- Stay **board-level and organization-level**. Users should manage goals, structure, budgets, approvals, and outputs.
- Make the first five minutes feel magical: install, answer a few questions, see a CEO do something real.
- Keep work anchored to **issues/comments/projects/goals**, even when the entry surface is conversational.
- Treat **agency / internal team / startup** as the same underlying abstraction with different templates and labels.
- Make outputs first-class: files, docs, reports, previews, links, screenshots.
- Provide **hooks into engineering workflows**: worktrees, preview servers, PR links, external review tools.
- Use **plugins** for edge cases beyond the built-in control plane, including richer chat or knowledge surfaces.

**Do not**

- Do not make the core product a general chat app. Chat is an intake surface, not the primary work system.
- Do not build a complete Jira/GitHub replacement. Rudder is organization orchestration, not PR tooling.
- Do not build enterprise-grade RBAC first. V1 should stay coarse and organization-scoped.
- Do not lead with raw bash logs and transcripts. Default view should be human-readable intent/progress, with raw detail beneath.
- Do not force users to understand provider/API-key plumbing unless absolutely necessary.

## Specific Design Goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to “my CEO completed a first task” in one sitting.

2. **Board-level abstraction always wins**
   The default UI should answer: what is the organization doing, who is doing it, why does it matter, what did it cost, and what needs my approval.

3. **Conversation stays attached to work objects**
   Chat should clarify, route, and propose work, but durable work should remain attached to issues, projects, goals, and approvals.

4. **Progressive disclosure**
   Top layer: human-readable summary. Middle layer: checklist/steps/artifacts. Bottom layer: raw logs/tool calls/transcript.

5. **Output-first**
   Work is not done until the user can see the result: file, document, preview link, screenshot, plan, or PR.

6. **Local-first, cloud-ready**
   The mental model should not change between local solo use and shared/private or public/cloud deployment.

7. **Safe autonomy**
   Auto mode is allowed; hidden token burn is not.

8. **Thin core, rich edges**
   Put optional knowledge and special-purpose surfaces into plugins/extensions rather than bloating the control plane.
