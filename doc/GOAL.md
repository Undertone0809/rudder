# Rudder

> Build your self-improving Agent Team.

Agents that think, build, play, and learn from real work.

Rudder turns goals, issues, agent runs, reviews, and feedback into a work loop for agent teams. It gives humans and agents a shared operating structure for assigning work, running agents, reviewing outputs, controlling spend, and preserving the lessons that should make the next run better.

## The Vision

Agent teams become useful when their work stops disappearing into one-off prompts. They need the same durable coordination surfaces that make human teams compound: goals, explicit ownership, shared context, review, feedback, operating memory, and budget discipline.

Rudder is the operating layer that makes those loops visible and repeatable. It is not the agent runtime and it is not a generic chat product. It is the place where real work becomes structured enough to assign, run, review, learn from, and improve.

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

- **Define goals** — every durable issue should answer why it exists.
- **Plan work** — agents connect long-term goals to short-term execution plans.
- **Assign issues** — work has one clear owner, acceptance criteria, and enough context to start.
- **Run agents** — heartbeats make execution visible instead of hidden.
- **Review outputs** — results, evidence, approvals, blockers, and taste judgments stay attached to the work.
- **Evaluate improvement** — feedback becomes learning proposals with evidence, scope, evals, approval, and rollback paths.
- **Control spend** — budgets, cost events, and hard stops keep autonomy legible.
- **Preserve lessons** — feedback, comments, run history, documents, skills, workflows, and decisions make future runs better.

## The Work Loop

Rudder is designed around the loop that makes agent teams improve:

```text
Goal -> Plan -> Issue -> Agent run -> Review -> Feedback -> Learning proposal -> Eval/approval -> Better future runs
```

The product should make that loop concrete without overclaiming automation. Rudder should help agents form plans, preserve the evidence behind their work, and create reviewable promotion paths for better context, skills, decisions, workflows, evals, and role instructions. It should align agents with the team's taste through real feedback and accepted work, not silently rewrite behavior or bury lessons inside chat transcripts.

## Architecture

Two layers:

### 1. Control Plane (this software)

The central nervous system. Manages:

- Agent registry and Organization Structure
- Issue assignment and status
- Budget and token spend tracking
- Organization knowledge and reusable operating context
- Goal hierarchy (organization -> team -> agent -> issue)
- Heartbeat monitoring — know when agents are alive, idle, or stuck

### 2. Execution Services (agent runtimes)

Agents run through local or external runtimes and report into the control plane. Agent runtimes connect Rudder to different execution environments:

- local coding CLIs and processes
- HTTP/webhook-based agents
- gateway-backed agent systems
- any runtime that can be called, can report progress, or can leave evidence through the API

The control plane coordinates work and preserves the record. Runtimes do the actual work.

## Core Principle

You should be able to look at Rudder and understand the agent team at a glance: what goal it is serving, which issues are moving, who owns the next step, what changed, what it cost, what needs review, and what the next run should learn from this one.
