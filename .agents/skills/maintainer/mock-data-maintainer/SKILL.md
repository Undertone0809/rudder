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

Prefer these scripts over rewriting the seed flow in a one-off answer.

## Default Workflow

1. Identify the data intent and target surface.
2. Pick or combine scenarios from the reference catalog.
3. Define the scenario spine:
   - who the user/persona is
   - what they are trying to do
   - what conflict, risk, or decision the data should reveal
   - what changed before and after the workflow
4. Define entities and relationships before writing rows.
5. Add time, status, priority, budget, ownership, and failure signals where they
   make the scenario clearer.
6. Choose the output form:
   - live seed command
   - TypeScript seed script
   - JSON fixture
   - CSV
   - SQL inserts
   - Markdown scenario brief
7. Include usage notes and reset notes.

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
- For screenshots, make data visually legible across pages. Avoid empty shells.
- For testing, include deterministic setup and reset strategy.
- For workflow explanation, include persona, motivation, conflict, decision
  point, and outcome.
- If the user asks for actual landing screenshots, use
  `landing-proof-shots-maintainer` after the mock data has been selected or
  seeded.

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
- perfect happy-path-only data
- overfitting to one component when the user needs a whole workflow
- mixing production-looking secrets into examples
- changing schema or app behavior just to make mock data easier

## Hand-Off

End with the concrete artifact or command the user can use immediately. If the
data is meant for local screenshots, include the exact route or local URL to
open after seeding. If the data is meant for tests, include the fixture entry
point and reset expectation.
