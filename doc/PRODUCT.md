# Rudder — Product Definition

## What It Is

> Build your self-improving Agent Team.

Agents that think, build, play, and learn from real work.

Rudder turns goals, issues, agent runs, reviews, and feedback into a work loop for agent teams. It gives humans and agents a shared operating structure for assigning work, running agents, reviewing outputs, controlling spend, and preserving the lessons that should make the next run better.

One Rudder instance can run multiple organizations. An **organization** is the first-order product object: the workspace where a human operator gives an agent team a goal, a structure, durable work objects, runtime access, budgets, and review paths.

The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## Product Loop

Rudder is organized around one compounding loop:

```text
Goal -> Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs
```

The loop matters because agent work improves only when real work leaves behind durable evidence: the context used, the decisions made, the output produced, the review result, the cost, and the lesson that should influence future runs.

Rudder should make the promotion paths explicit and reviewable. A lesson may become better issue context, a skill update, a reusable workflow, a decision record, a document, or a stronger operating rule. Rudder should not pretend every lesson is automatically promoted without human or policy review.

## Core Concepts

### Organization

An organization has:

- a **goal** that explains why the agent team exists
- **agents** with roles, runtimes, capabilities, budgets, and reporting lines
- **issues** that turn intent into durable execution work
- **projects** that group related issues, resources, and timelines
- **reviews and approvals** for output quality and governed actions
- **feedback and lessons** that preserve what future runs should learn
- **cost controls** for budget visibility and hard stops

### Agents

Agents are durable team members, not disposable prompts. Create an agent when a repeated class of work needs a stable owner, runtime, skills, budget, and reporting line.

Each agent has:

- **Runtime type + config** — how Rudder wakes the agent and how the runtime performs work
- **Role and reporting** — what responsibility the agent owns and where escalation goes
- **Capabilities description** — what work this agent should accept and what it should not decide silently
- **Skills and operating instructions** — reusable procedures the agent can use in future runs

Rudder is runtime-neutral. It coordinates agents; it does not dictate how every agent is built.

### Agent Runs

A run is a bounded work cycle. Rudder wakes an agent through a local command or external request, tracks status, preserves transcript/output evidence where available, records cost events, and links the run back to the issue and organization context.

Runs should leave a clear signal: progress, done, blocked, review feedback, or a named handoff.

### Issues

Issues are the durable execution surface. Chat can clarify a request, but work that needs assignment, budget, review, or future memory should become an issue.

An issue keeps the important record together:

- intent and expected outcome
- assignee and reviewer
- goal/project context
- comments and decisions
- agent runs and transcripts
- artifacts, files, screenshots, links, or PRs
- close-out evidence and feedback

### Reviews, Feedback, and Learning

Review is how Rudder turns output into an accepted, blocked, or change-requested result. Feedback is how humans and systems name what should be preserved from that result.

Learning is not a hidden background rewrite. It is a governed product path for turning repeated evidence into better context, skills, decisions, or workflows.

### Chat and Messenger

Chat is a first-class intake, clarification, and lightweight run surface in Rudder.

- It helps clarify requests before work starts.
- It can suggest routing, draft issue proposals, and propose lightweight approval-gated actions.
- It can host chat-native automation runs when the configured output is `Send to chat`.
- Durable tracked work remains issue-centric; chat-native automation runs keep their audit trail on `automation_runs` and the chat transcript instead of creating execution issues.

Chat is part of the broader board communication shell surfaced as `Messenger`. Messenger unifies chat conversations with issue threads, blockers, failed runs, review prompts, budget alerts, and decision requests without turning Rudder into a generic chat product.

## Principles

1. **Agent teams improve through real work.** Rudder must preserve the evidence and feedback that make later runs better.
2. **Issues are the work surface.** Durable execution belongs on issues, not in loose chat threads or terminal transcripts.
3. **Organization is the unit of operation.** Everything lives under an organization. One Rudder instance can run many organizations.
4. **All work traces to the goal.** If an issue cannot be explained in terms of the organization goal, it should not exist.
5. **Runtime-neutral by default.** Rudder orchestrates agents; runtimes perform work.
6. **Control spend and autonomy together.** Auto mode is allowed; hidden token burn is not.
7. **Review makes learning safe.** Feedback and skill/workflow promotion should be explicit, inspectable, and reversible where practical.
8. **Output-first.** Work is not done until the user can inspect the result.

## User Flow

1. Open Rudder and create a new organization.
2. Define the organization goal.
3. Create or use a default agent with a clear role and runtime.
4. Create or convert a request into an issue.
5. Assign the issue to one owner and add a reviewer when quality judgment matters.
6. Run the agent through a heartbeat.
7. Review the output, run evidence, activity, and spend from the board.
8. Leave feedback on the run, issue, or output.
9. Preserve reusable lessons as better context, skills, decisions, or workflows.
10. Let future runs use the improved operating context.

## Guidelines

There are two runtime modes Rudder must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/DEPLOYMENT-MODES.md`.

## Further Detail

See [SPEC.md](./SPEC.md) for the long-horizon technical specification and [TASKS.md](./TASKS.md) for legacy task/issue data-model notes.

## What Rudder should do vs. not do

**Do**

- Stay focused on the agent-team work loop: goals, issues, runs, reviews, feedback, budgets, and lessons.
- Make the first five minutes feel concrete: install, create an organization, run one real issue, inspect the evidence.
- Keep work anchored to **issues/comments/projects/goals**, even when the entry surface is conversational.
- Treat **agency / internal team / startup** as templates over the same underlying organization abstraction.
- Make outputs first-class: files, docs, reports, previews, links, screenshots.
- Provide hooks into engineering workflows: worktrees, preview servers, PR links, external review tools.
- Use plugins for edge cases beyond the built-in operating layer, including richer chat, knowledge, or integration surfaces.

**Do not**

- Do not make the core product a general chat app. Chat is intake, not the primary work system.
- Do not pitch Rudder as an AI-company simulator. The product promise is an improving agent team grounded in real work.
- Do not build a complete Jira/GitHub replacement. Rudder coordinates agent work; it should integrate with delivery tools instead of replacing all of them.
- Do not build enterprise-grade RBAC first. V1 should stay coarse and organization-scoped.
- Do not lead with raw bash logs and transcripts. Default view should be human-readable intent/progress, with raw detail beneath.
- Do not force users to understand provider/API-key plumbing unless absolutely necessary.

## Specific Design Goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to one completed, reviewable agent-work loop in one sitting.

2. **The work loop is always visible**
   The default UI should answer: what is the goal, which issues are moving, who owns the next step, what changed, what did it cost, what needs review, and what should future runs learn?

3. **Conversation stays attached to work objects**
   Chat should clarify, route, and propose work, but durable work should remain attached to issues, projects, goals, runs, reviews, and approvals.

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
