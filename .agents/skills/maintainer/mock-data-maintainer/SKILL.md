---
name: mock-data-maintainer
description: |
  Create realistic, coherent mock/demo/seed data for Rudder development,
  local testing, local screenshots, product demos, and user-scenario
  explanation. Use this whenever the user asks for mock data, demo data,
  seed data, fake-but-realistic records, test fixtures, screenshot data,
  synthetic app states, CSV/JSON/SQL/TypeScript seed outputs, or data that
  helps users understand a workflow. For Rudder landing screenshots and demo
  orgs, reuse this skill's landing demo org dataset and coordinate with
  landing-proof-shots-maintainer for capture.
---

# Mock Data Maintainer

Use this skill to create mock data that is useful, coherent, and easy to reuse.
The goal is not random fake records. The goal is scenario data that supports
testing, screenshots, demos, and clear user understanding.

## First Decision

Classify the request into one primary intent before generating data:

1. testing data: local dev, E2E, bug reproduction, contract checks, edge states
2. screenshot/demo data: local screenshots, landing proof shots, README, decks
3. user-scenario data: explain a workflow, persona, problem, or product value
4. static artifact data: CSV, JSON, SQL, Markdown table, or TypeScript fixture

If the prompt implies multiple intents, produce one shared scenario spine and
then adapt outputs for each intent. For example, one Rudder launch-week org can
serve local screenshots, workflow explanation, and E2E fixture design.

## Reference Selection

Read only the references needed for the request:

- `references/scenario-index.md`: scenario catalog and selection rules
- `references/quality-bar.md`: realism, determinism, privacy, and output rules
- `references/rudder-studio-scenario.md`: canonical month-long "Rudder uses
  Rudder to build and grow Rudder" org, with reusable JSON fixtures and seed
  script
- `references/rudder-landing-demo-org.md`: canonical screenshot-ready Rudder org
- `references/rudder-test-fixtures.md`: Rudder testing and edge-state fixtures
- `references/rudder-user-scenarios.md`: Rudder user stories and scenario spines
- `references/generic-saas-dashboard.md`: SaaS metrics, billing, and ops data
- `references/generic-crm-sales.md`: CRM, pipeline, account, and support data
- `references/edge-states.md`: empty, error, boundary, permission, and conflict states

## Bundled Scripts

Use bundled scripts when the user needs live Rudder data instead of static
records:

- `scripts/capture-landing-proof-shots.ts`: boots an isolated Rudder instance,
  seeds the canonical landing demo org, and optionally captures proof-shot
  screenshots. Use `LANDING_SHOTS_SKIP_CAPTURE=1 LANDING_SHOTS_HOLD_OPEN=1`
  for seed-only local screenshot prep.
- `scripts/seed-rudder-studio.ts`: seeds the reusable Rudder Studio org into a
  running local dev instance. Use it when the user wants a realistic month-long
  Rudder org, "using Rudder to build Rudder", natural Calendar work history,
  or durable user-scenario data.

Prefer these scripts over rewriting the seed flow in a one-off answer.

## Default Workflow

1. Identify the data intent and target surface.
2. Pick or combine scenarios from the reference catalog.
3. Define the scenario spine:
   - who the user/persona is
   - what they are trying to do
   - what conflict, risk, or decision the data should reveal
   - what changed before and after the workflow
4. Ground Rudder scenarios in production-like operator work. Prefer a coherent
   mix of synthetic records plus sanitized real scenario patterns from Rudder
   development, release, support, growth, and agent-ops work over generic SaaS
   examples.
5. Define entities and relationships before writing rows.
6. Add time, status, priority, budget, ownership, and failure signals where they
   make the scenario clearer.
7. Choose the output form:
   - live seed command
   - TypeScript seed script
   - JSON fixture
   - CSV
   - SQL inserts
   - Markdown scenario brief
8. Include usage notes and reset notes.

## Output Shape

For non-trivial requests, structure the answer like this:

```markdown
## Scenario
- Intent:
- User story:
- Target surface:
- Data shape:

## Entities
- ...

## States Covered
- ...

## Output
...

## Usage
...
```

For code or fixture outputs, include deterministic IDs when useful. For
screenshot/demo data, prefer readable names and dense but believable state over
opaque generated IDs.

## Rudder-Specific Rules

- Keep organization boundaries explicit. Every Rudder entity that belongs to an
  organization should have a clear org owner.
- Keep entities relationally coherent: org -> goals -> projects -> issues ->
  agents, approvals, chats, heartbeat runs, costs, and activity.
- For whole-product user scenarios, prefer a causal scenario spine over
  component-specific fixtures. Start from real work records, then let Calendar,
  Dashboard, Messenger, approvals, and cost views reflect those records.
- When the user wants "Rudder Studio", "using Rudder to build Rudder", a
  month-long realistic org, or Calendar data that should emerge from real agent
  work, use `references/rudder-studio-scenario.md` and the Rudder Studio
  fixture files instead of inventing a new one-off org.
- For screenshots, make data visually legible across pages. Avoid empty shells.
- For product screenshots, seed the underlying run/output evidence too: dashboards,
  agent detail pages, Calendar, Messenger, and charts should be downstream of
  coherent issues, heartbeat runs, run logs, comments, approvals, costs, and
  calendar events instead of isolated component fixtures.
- For screenshot and demo requests, prefer Desktop-shell capture when the
  product claim is about the installed app, local operator workflow, or
  production-like Rudder use. Browser capture is acceptable for narrow web UI
  checks, but the final dataset should still work inside the Desktop shell.
- Dashboard, Calendar, and agent run screenshots must include non-empty
  transcript/output evidence. If a seeded page would show empty transcript,
  empty run output, or decorative calendar-only blocks, treat the seed as
  incomplete.
- Capture flows must validate the specific screenshot surface before claiming
  success. Use selectors and content assertions for the meaningful records on
  each page, and fail or report blocked if the page is empty, stale, or showing
  the wrong scenario.
- For testing, include deterministic setup and reset strategy.
- For workflow explanation, include persona, motivation, conflict, decision
  point, and outcome.
- For live `prod_local` or Desktop demo org seeds, target selection is part of
  the data task. Verify the active runtime and database before writing; stale
  config defaults are not enough.
- Whole-org demo seeds should prefer API creation for the organization, then
  scoped database insertion for richer downstream evidence if the API surface is
  incomplete.
- If the user asks for actual landing screenshots, use
  `landing-proof-shots-maintainer` after the mock data has been selected or
  seeded.

## Live Rudder Instance Seed Rules

When seeding data into a running Rudder instance, verify the target before any
write.

1. Confirm the live API target with `/api/health`.
   - For prod Desktop or local production data, require `localEnv=prod_local`
     and `instanceId=default`.
   - For dev data, require `localEnv=dev` and `instanceId=dev`.
2. Do not trust stale config files alone. Prefer live runtime descriptors,
   `/api/health`, and active process or database connections.
3. If API creation is available, use it for top-level organization creation so
   normal service-side defaults, memberships, labels, activity, and policies are
   applied.
4. Use direct database writes only for seed entities that do not have complete
   public API coverage, and keep them scoped to the verified organization id.
5. If a temporary probe write is needed, name it clearly, record its id, delete
   it immediately, and verify deletion before continuing.
6. For destructive reseed, require explicit user authority or create a pending
   approval record that makes the destructive operation visible in the seeded
   organization.
7. Never modify repo source files just to seed live data unless the user
   explicitly asks for a reusable seed script or fixture.

Required readback for whole-organization Rudder demo seeds:

- organization appears in `/api/orgs`
- expected agents exist
- expected goals, projects, and issues exist
- pending approvals exist when requested
- chat conversation exists when requested
- activity log contains representative events
- heartbeat runs and cost summary exist when requested
- primary UI route returns 200
- report organization id, URL key, counts, and verification evidence

## Quality Bar

Good mock data has:

- a coherent story across all records
- enough density to make UI states meaningful
- edge states where testing needs them
- deterministic values where automation needs them
- plausible names, statuses, timestamps, and amounts
- no real personal data, real customer secrets, or copied private records

Avoid:

- lorem ipsum rows without relationships
- generic use-case copy that could describe any SaaS or task board
- perfect happy-path-only data
- overfitting to one component when the user needs a whole workflow
- mixing production-looking secrets into examples
- changing schema or app behavior just to make mock data easier

## Hand-Off

End with the concrete artifact or command the user can use immediately. If the
data is meant for local screenshots, include the exact route or local URL to
open after seeding. If the data is meant for tests, include the fixture entry
point and reset expectation.

## Regression Checks

Use these checks when updating this skill or screenshot/demo fixtures:

### Case: Use-case-led Rudder screenshot data

Input: user asks for Rudder screenshots or demo data that should feel like real
operator work.

Expected behavior: choose Landing Demo Org or Rudder Studio, ground the
scenario in sanitized Rudder-shaped work, seed issues/runs/logs/costs/approvals
before deriving Dashboard, Calendar, Messenger, and agent-detail views.

Must not: return generic SaaS use cases, isolated component rows, or empty page
fixtures.

### Case: Desktop-shell product evidence

Input: user needs screenshots proving the installed local Rudder experience.

Expected behavior: prefer Desktop-shell capture or coordinate with the
screenshot skill that can capture Desktop shell; browser screenshots are only
supporting evidence for narrow route checks.

Must not: present browser-only proof as sufficient for a Desktop product claim.

### Case: Prod Desktop demo org seed

Input: user asks to create a new organization in prod using a source document as
initialization data.

Expected behavior: verify `/api/health` reports `localEnv=prod_local` and
`instanceId=default`; create the organization through the API when possible;
seed scoped relational data for agents, goals, projects, issues, approvals,
chats, activity, runs, costs, and calendar evidence as requested; validate API
readback and the primary UI route; report the organization id, URL key, counts,
and verification evidence.

Must not: write to the dev database, rely only on stale config ports, leave
temporary probe records behind, or claim success from database counts without
API readback.

### Case: Existing demo org collision

Input: user asks to reseed an organization that may already exist.

Expected behavior: detect existing organizations by name, URL key, and issue
prefix; classify the operation as additive or destructive; require explicit
authority or create a pending approval record before replacing existing seeded
records; keep all changes scoped to the verified target organization.

Must not: silently duplicate organizations, overwrite existing data without a
visible approval or explicit instruction, or use a matching issue prefix in the
wrong runtime.

### Case: Static fixture only

Input: user asks for a JSON, SQL, CSV, or Markdown fixture and says not to write
to local Rudder.

Expected behavior: produce the requested static artifact and include usage or
reset notes when relevant.

Must not: call the Rudder API, connect to a database, create probe records, or
mutate prod or dev state.

### Case: Screenshot capture validation

Input: a capture script or manual flow saves Dashboard, Calendar, chat,
approval, or agent run screenshots.

Expected behavior: assert page selectors plus scenario-specific text and
non-empty transcript/output evidence before declaring success.

Must not: silently save screenshots when the page loaded but the scenario data,
run output, transcript, or Calendar work history is missing.
