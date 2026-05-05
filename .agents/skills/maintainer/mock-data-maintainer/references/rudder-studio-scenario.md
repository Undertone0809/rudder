# Rudder Studio Scenario

Use Rudder Studio when the user wants a realistic Rudder org that explains how
Rudder is used to build, operate, and grow Rudder itself.

This is the canonical whole-org scenario for user-scenario mock data. It is not
a Calendar fixture, Dashboard fixture, or Marketing fixture. Those surfaces are
views over the same month of real work.

## Scenario Spine

Persona: founder/operator running a small agent team that is building Rudder,
shipping releases, improving the control plane, and trying to grow usage among
builders who already run coding agents.

Problem: agents can produce code and content, but the operator needs one place
to see ownership, issue status, run history, approvals, budget pressure,
messenger intake, and growth follow-through.

Rudder setup:

- one organization: Rudder Studio
- eight agents: founder, engineering, product, skills, growth, design, QA, and
  release reliability
- three goals: completed work loops, Calendar as work history, and qualified
  builder growth
- seven projects: Agent Work Loop, Calendar as Work History, Desktop Release
  Reliability, Developer Platform & Skills, Marketing & Growth, Messenger &
  Issue Intake, and Operator Experience
- a month of issues, runs, costs, comments, approvals, chats, and calendar
  events

## Source Of Truth

Maintain the scenario from causal work records, not screen states:

1. Goals, projects, agents, and issues define the work.
2. Heartbeat runs, run events, costs, comments, approvals, and chats show what
   happened.
3. Calendar derives agent work blocks from heartbeat runs and only adds a small
   number of human operator checkpoints.
4. Dashboard, Messenger, issue filters, approvals, and costs should become
   meaningful because the underlying work is coherent.

Do not create a special Calendar-only story unless the user explicitly asks for
Calendar component testing. In a realistic Rudder Studio month, Calendar should
already be dense because agents were actually running.

## Fixture Files

The fixture source lives in `data/rudder-studio/`:

- `scenario.json`: org metadata, fixed time window, goals, projects, and
  generation settings
- `agents.json`: stable agent keys, roles, reporting lines, budgets, and
  capabilities
- `issues.json`: work items with project/goal/assignee links, lifecycle state,
  billing code, and run generation profiles
- `approvals.json`: operator decisions tied back to growth, release, and budget
  issues
- `calendar.json`: manual human checkpoints only
- `chats.json`: messenger conversations that explain corrections and decisions

The data uses stable keys instead of stored UUIDs. The seed script maps keys to
new UUIDs each run so the same scenario can be reused without ID collisions.

## Seed Command

Run from the Rudder repo root while a dev instance is running:

```sh
node cli/node_modules/tsx/dist/cli.mjs .agents/skills/maintainer/mock-data-maintainer/scripts/seed-rudder-studio.ts
```

Dry-run validation:

```sh
node cli/node_modules/tsx/dist/cli.mjs .agents/skills/maintainer/mock-data-maintainer/scripts/seed-rudder-studio.ts --dry-run
```

By default the script reads the dev embedded database at:

```sh
postgres://rudder:rudder@127.0.0.1:54329/rudder
```

Override when needed:

```sh
RUDDER_STUDIO_DATABASE_URL=postgres://... node cli/node_modules/tsx/dist/cli.mjs .agents/skills/maintainer/mock-data-maintainer/scripts/seed-rudder-studio.ts
```

The script creates a new org by default. It uses `rudder-studio`, `rudder-studio-2`,
and so on for `urlKey` when earlier seeded orgs exist. Set
`RUDDER_STUDIO_FIXED_KEYS=1` only when you want the command to fail instead of
choosing the next available key.

## What The Seed Should Show

After seeding, open the printed dashboard URL. The org should show:

- active, running, idle, and paused agents
- a visible Marketing & Growth project with concrete growth execution issues:
  X launch thread, build-in-public post, HN packet, founder DMs, reply
  classification, demo clip, community posts, waitlist capture, and weekly
  report
- budget pressure caused by real generated cost rows
- pending approvals for Product Hunt gating and budget override
- Calendar density from derived heartbeat run events, plus a few human reviews
- Messenger conversations that explain why the scenario is organized this way

## Update Rules

When improving the scenario:

- add or edit fixture JSON first
- keep keys stable unless intentionally replacing the concept
- add new derived behavior to the seed script instead of storing thousands of
  generated rows in JSON
- keep Marketing & Growth execution-specific, not just positioning or copy
  review
- preserve the principle that Calendar is downstream of real work history
- run `--dry-run` before handoff
