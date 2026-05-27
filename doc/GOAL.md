# Rudder

> Build your self-improving Agent Team.

Agents that think, build, play, and learn from real work.

Rudder turns goals, issues, agent runs, reviews, and feedback into a work loop for agent teams. It gives humans and agents a shared operating structure for assigning work, running agents, reviewing outputs, controlling spend, and preserving the lessons that should make the next run better.

## The Vision

Agent teams become useful when their work stops disappearing into one-off prompts. They need the same durable coordination surfaces that make human teams compound: goals, explicit ownership, shared context, review, feedback, operating memory, and budget discipline.

Rudder is the operating layer that makes those loops visible and repeatable. It is not the agent runtime and it is not a generic chat product. It is the place where real work becomes structured enough to assign, run, review, learn from, and improve.

The current north-star metric is the weekly count of real agent-work loops completed end-to-end through Rudder.

## The Problem

Agent work breaks down when it lives in a single long prompt or an isolated terminal session. The hard questions are operational:

- Who owns this work?
- Why does it matter?
- What context did the agent use?
- What changed?
- Who reviewed the result?
- What did it cost?
- What should the team remember before the next run?

A normal task board does not answer those questions for agent work. A transcript alone does not either.

## What This Is

Rudder is the shared operating structure for a self-improving agent team. It is the place where humans and agents:

- **Define goals** — every durable issue should answer why it exists.
- **Assign issues** — work has one clear owner and enough context to start.
- **Run agents** — heartbeats make execution visible instead of hidden.
- **Review outputs** — results, evidence, approvals, and blockers stay attached to the work.
- **Control spend** — budgets, cost events, and hard stops keep autonomy legible.
- **Preserve lessons** — feedback, comments, run history, documents, and skills make future runs better.

## The Work Loop

Rudder is designed around the loop that makes agent teams improve:

```text
Goal -> Issue -> Agent run -> Review -> Feedback -> Learning -> Better future runs
```

The product should make that loop concrete without overclaiming automation. Rudder should preserve the evidence and create reviewable promotion paths for better context, skills, decisions, and workflows. It should not silently rewrite agent behavior or bury lessons inside chat transcripts.

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
