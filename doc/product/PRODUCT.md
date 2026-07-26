# Rudder — Product Definition

## What It Is

> Build your self-improving Agent Team.

Agents that think, build, play, and learn from real work.

Rudder turns goals, tasks, chats, issues, agent runs, reviews, and feedback into a work loop for agent teams. It gives humans and agents a shared operating structure for moving work forward, running agents, reviewing outputs, controlling spend, and preserving the lessons that should make the next run better.

One Rudder instance can run multiple organizations. An **organization** is the first-order product object: the workspace where a human operator gives an agent team a goal, inspectable Chat and issue work surfaces, runtime access, budgets, and review paths.

The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## Product Loop

Rudder is organized around one compounding loop:

```text
Goal -> Chat or Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs
```

The loop matters because agent work improves only when real work leaves behind durable evidence: the context used, the decisions made, the output produced, the review result, the cost, and the lesson that should influence future runs.

Rudder should make the promotion paths explicit and reviewable. A lesson may become better Chat or issue context, a skill update, a reusable workflow, a decision record, a document, or a stronger operating rule. Rudder should not pretend every lesson is automatically promoted without human or policy review.

## Core Concepts

### Organization

An organization has:

- a **goal** that explains why the agent team exists
- **agents** with roles, runtimes, capabilities, budgets, and permissions
- **chat and issues** that offer conversational and structured ways to move work forward
- **projects** that group related chats, issues, resources, and timelines
- **reviews and approvals** for output quality and governed actions
- **feedback and lessons** that preserve what future runs should learn
- **cost controls** for budget visibility and hard stops

### Agents

Agents are durable team members, not disposable prompts. Create an agent when a repeated class of work needs a stable owner, runtime, skills, and budget.

Each agent has:

- **Runtime type + config** — how Rudder wakes the agent and how the runtime performs work
- **Role and title** — what responsibility the agent owns and how it is presented to operators
- **Capabilities description** — what work this agent should accept and what it should not decide silently
- **Skills and operating instructions** — reusable procedures the agent can use in future runs

Rudder is runtime-neutral. It coordinates agents; it does not dictate how every agent is built.

### Agent Runs

A run is a bounded work cycle. Rudder wakes an agent through a local command or external request, tracks status, preserves transcript/output evidence where available, records cost events, and links the run back to its chat or issue context and organization.

Runs should leave a clear signal: progress, done, blocked, review feedback, or a named handoff.

### Issues

Issues are the structured execution surface. They are useful when work benefits from explicit status, ownership, priority, dependencies, or review state. They are not a prerequisite for real execution: users may move a task forward and complete it in Chat when a conversational workflow fits better.

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

Chat is Rudder's conversation-driven execution surface. Chat and issues are two ways to move tasks forward: Chat organizes work through an ongoing conversation, while issues organize work through explicit fields and lifecycle state.

- It can clarify, execute, refine, and complete tasks without requiring an issue conversion.
- It can suggest routing, draft issue proposals, and propose lightweight approval-gated actions.
- It can host chat-native automation runs when the configured output is `Send to chat`.
- Chat-native runs keep their audit trail on Agent Runs, automation runs where applicable, the chat transcript, and the conversation Work manifest instead of requiring a synthetic execution issue.
- Creating or linking an issue adds structured coordination when the operator wants it; it does not make the underlying task more real.

Chat is part of the broader board communication shell surfaced as `Messenger`. Messenger unifies chat conversations with issue threads, blockers, failed runs, review prompts, budget alerts, and decision requests without turning Rudder into a generic chat product.

## Principles

1. **Agent teams improve through real work.** Rudder must preserve the evidence and feedback that make later runs better.
2. **Chat and issues are work surfaces.** Users may choose conversation-driven or structure-driven execution. Both must preserve inspectable runs, outputs, and decisions appropriate to the surface.
3. **Organization is the unit of operation.** Everything lives under an organization. One Rudder instance can run many organizations.
4. **All work traces to the goal.** If a durable Chat task or issue cannot be explained in terms of the organization goal, it should not exist.
5. **Runtime-neutral by default.** Rudder orchestrates agents; runtimes perform work.
6. **Control spend and autonomy together.** Auto mode is allowed; hidden token burn is not.
7. **Review makes learning safe.** Feedback and skill/workflow promotion should be explicit, inspectable, and reversible where practical.
8. **Output-first.** Work is not done until the user can inspect the result.

## User Flow

1. Open Rudder and create a new organization.
2. Define the organization goal.
3. Create or use a default agent with a clear role and runtime.
4. Start the task in Chat or create an issue, depending on the preferred work style.
5. For structured coordination, assign the issue to one owner and add a reviewer when quality judgment matters.
6. Run the agent through a chat turn or heartbeat.
7. Review the output, run evidence, activity, and spend from the relevant work surface.
8. Leave feedback on the chat, run, issue, or output.
9. Preserve reusable lessons as better context, skills, decisions, or workflows.
10. Let future runs use the improved operating context.

## Guidelines

There are two runtime modes Rudder must support:

- `local_trusted` (default): single-user local trusted deployment with no login friction
- `authenticated`: login-required mode that supports both private-network and public deployment exposure policies

Canonical mode design and command expectations live in `doc/engineering/DEPLOYMENT-MODES.md`.

## Further Detail

See `doc/product/README.md` and the owning product domain contracts for current
behavior. Archived specs and legacy task notes live under `doc/archive/` for
historical context only.

## What Rudder should do vs. not do

**Do**

- Stay focused on the agent-team work loop: goals, tasks, chats, issues, runs, reviews, feedback, budgets, and lessons.
- Make the first five minutes feel concrete: install, create an organization, run one real task through Chat or an issue, and inspect the evidence.
- Keep work anchored to inspectable **chats/issues/runs/outputs/projects/goals** rather than detached prompts or terminal transcripts.
- Treat **agency / internal team / startup** as templates over the same underlying organization abstraction.
- Make outputs first-class: files, docs, reports, previews, links, screenshots.
- Provide hooks into engineering workflows: worktrees, preview servers, PR links, external review tools.
- Use plugins for edge cases beyond the built-in Rudder, including richer chat, knowledge, or integration surfaces.

**Do not**

- Do not make the core product a generic social chat app. Chat is a real task-execution surface grounded in agents, runs, outputs, organization context, and controls.
- Do not pitch Rudder as an AI-company simulator. The product promise is an improving agent team grounded in real work.
- Do not build a complete Jira/GitHub replacement. Rudder coordinates agent work; it should integrate with delivery tools instead of replacing all of them.
- Do not build enterprise-grade RBAC first. V1 should stay coarse and organization-scoped.
- Do not lead with raw bash logs and transcripts. Default view should be human-readable intent/progress, with raw detail beneath.
- Do not force users to understand provider/API-key plumbing unless absolutely necessary.

## Specific Design Goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to one completed, reviewable agent-work loop in one sitting.

2. **The work loop is always visible**
   The default UI should answer: what is the goal, which chats or issues are moving tasks forward, who or what owns the next step, what changed, what did it cost, what needs review, and what should future runs learn?

3. **Conversation is a work object**
   Chat may carry a task from request through execution and completion. Runs, outputs, decisions, projects, goals, reviews, and approvals should remain inspectably attached whether the user chooses Chat, an issue, or links both.

4. **Progressive disclosure**
   Top layer: human-readable summary. Middle layer: checklist/steps/artifacts. Bottom layer: raw logs/tool calls/transcript.

5. **Output-first**
   Work is not done until the user can see the result: file, document, preview link, screenshot, plan, or PR.

6. **Local-first, cloud-ready**
   The mental model should not change between local solo use and shared/private or public/cloud deployment.

7. **Safe autonomy**
   Auto mode is allowed; hidden token burn is not.

8. **Thin core, rich edges**
   Put optional knowledge and special-purpose surfaces into plugins/extensions rather than bloating Rudder.
