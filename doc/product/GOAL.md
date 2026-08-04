# Rudder

> Build your self-improving Agent Team.

Agents that think, build, play, and learn from real work.

Rudder turns goals, tasks, chats, issues, agent runs, reviews, and feedback into a work loop for agent teams. It gives humans and agents a shared operating structure for moving work forward, running agents, reviewing outputs, controlling spend, and preserving the lessons that should make the next run better.

## The Vision

Agent teams need durable, inspectable coordination surfaces that make human teams compound: goals, conversation, explicit ownership where needed, shared context, review, feedback, operating memory, and budget discipline.

Rudder makes those loops visible and repeatable. It is not the agent runtime and it is not a generic social chat product. It is the place where real work becomes inspectable enough to run, review, learn from, and improve, whether users choose Chat or issue structure.

The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## The Problem

Agent work breaks down when every run is treated as an isolated execution instead of part of an agent's growth. The problem is no longer only whether the work is assigned, logged, or reviewed. The harder questions are about planning, learning, and judgment:

- What long-term goal is this agent serving, and what short-term plan advances it now?
- Which context is actually eligible for this run, and which context is stale, one-off, or out of scope?
- Did the agent make the right tradeoffs, or did it only follow instructions literally?
- What did human review reveal about the team's standards, taste, workflow, and judgment?
- Should this feedback become memory, a skill update, a workflow change, a decision, an eval case, or no-op?
- Did the last improvement actually help future work, or did it add noise, cost, or regressions?
- What can the agent decide independently next time, and what still needs human approval?

A normal task board does not answer those questions for agent work. A transcript alone does not either. Without a governed learning loop, "agent memory" becomes a junk drawer of stale rules, and "self-improvement" becomes an unreviewed prompt change.

## What This Is

Rudder is the shared operating structure for a self-improving agent team. It is the place where humans and agents:

- **Define goals** — durable work in Chat or issues should answer why it exists.
- **Plan work** — agents connect long-term goals to short-term execution plans.
- **Move tasks forward** — users can work conversationally in Chat or use issues when explicit ownership, state, and acceptance criteria help.
- **Run agents** — heartbeats make execution visible instead of hidden.
- **Review outputs** — results, evidence, approvals, blockers, and taste judgments stay attached to the work.
- **Evaluate improvement** — feedback becomes learning proposals with evidence, scope, evals, approval, and rollback paths.
- **Control spend** — budgets, cost events, and hard stops keep autonomy legible.
- **Preserve lessons** — feedback, comments, run history, documents, skills, workflows, and decisions make future runs better.

## The Work Loop

Rudder is designed around the loop that makes agent teams improve:

```text
Goal -> Plan -> Chat or Issue -> Agent run -> Review -> Feedback -> Learning proposal -> Eval/approval -> Better future runs
```

The product should make that loop concrete without overclaiming automation. Rudder should help agents form plans, preserve the evidence behind their work, and create reviewable promotion paths for better context, skills, decisions, workflows, evals, and role instructions. It should align agents with the team's taste through real feedback and accepted work, not silently rewrite behavior or leave lessons unindexed inside transcripts.

## Responsibilities

### Rudder

The central nervous system. Manages:

- Agent registry and configuration
- Issue assignment and status
- Budget and token spend tracking
- Organization knowledge and reusable operating context
- Goal Contracts and context links across organizations, agents, chats, and
  issues, with legacy hierarchy fields retained only for compatibility reads
- Heartbeat monitoring — know when agents are alive, idle, or stuck

### Agent runtimes

Agents run through local or external runtimes and report into Rudder. Agent runtimes connect Rudder to different execution environments:

- local coding CLIs and processes
- HTTP/webhook-based agents
- gateway-backed agent systems
- any runtime that can be called, can report progress, or can leave evidence through the API

Rudder coordinates work and preserves the record. Runtimes do the actual work.

## Core Principle

You should be able to look at Rudder and understand the agent team at a glance: what goal it is serving, which chats or issues are moving tasks forward, who or what owns the next step, what changed, what it cost, what needs review, and what the next run should learn from this one.
