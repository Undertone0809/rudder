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

Ground this in production-like Rudder work when the target product is Rudder
itself: Desktop packaging, local startup reliability, release notes, public
launch material, support coverage, and agent closeout review. Use sanitized
details and synthetic actors, but keep the causal work realistic.

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

## Rudder Studio: Rudder Operating Rudder

Persona: founder/operator using Rudder to develop, release, operate, and grow
Rudder itself.

Problem: the team needs to understand Rudder through real work, not isolated
component demos. Calendar, Dashboard, approvals, Messenger, and cost views
should all explain the same month of agent-team operation.

Data to show:

- product, release, skills, operator UX, messenger, and growth projects
- concrete Marketing & Growth execution issues such as X launch thread, HN
  packet, founder DMs, demo clip, community posts, reply classification,
  waitlist capture, and weekly report
- heartbeat runs and costs for each area so Calendar and Dashboard have real
  downstream signals
- approvals for launch gating, release language, rejected automation, and
  budget override
- chats where operator corrections turn into issues and fixture rules

Read `rudder-studio-scenario.md` for the durable fixture and seed script.

For screenshots, this scenario should make Dashboard, Calendar, Messenger,
approvals, and agent run detail look like different views over the same real
month of work. Do not create decorative calendar events, empty run pages, or
generic marketing-use-case rows just to fill space.

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
