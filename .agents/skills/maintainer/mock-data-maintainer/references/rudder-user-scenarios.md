# Rudder User Scenarios

Use these when mock data should help users understand their own Rudder use
case. The data should feel like a small case study.

## Scenario Template

```markdown
## Persona

## Current Problem

## Rudder Setup

## Workflow

## Data To Show

## Outcome
```

## Founder Running Agent Team

Persona: founder/operator trying to ship a public beta with a small agent team.

Problem: work is spread across chat, GitHub, release notes, and local scripts.
The founder needs one control plane for goals, agent ownership, approvals, and
cost.

Data to show:

- one launch goal
- projects for launch, reliability, onboarding, and enterprise readiness
- agents with explicit roles and reporting lines
- issues assigned to agents
- approvals for risky public-facing changes
- cost events attached to issue work
- heartbeat runs summarizing progress

## Engineering Lead Governing Agent Work

Persona: engineering lead using agents but needing review gates.

Problem: agents can move fast, but release-sensitive changes need human review
and audit history.

Data to show:

- high-priority reliability issue
- agent run that produced a change summary
- approval requiring review before publish
- comment trail with decision context
- activity log for each mutation

## Ops Lead Watching Cost And Throughput

Persona: operations lead responsible for budget and delivery health.

Problem: multiple agents are running and costs need to map back to work.

Data to show:

- active, idle, paused, and running agents
- heartbeat runs with different statuses
- cost events grouped by agent, project, and issue
- budget policy with near-limit and exceeded states
- dashboard counts that reveal real work loops

## New Team Understanding Rudder

Persona: team evaluating whether Rudder fits their workflow.

Problem: they understand task boards, but not agent control planes.

Data to show:

- familiar projects/issues first
- then agent assignment and run history
- then approvals and budget controls
- finally chat-to-issue as the intake path

The data should show a progression from "task board" to "operating layer for
agent teams."
