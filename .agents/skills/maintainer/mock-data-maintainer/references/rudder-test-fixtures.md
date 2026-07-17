# Rudder Test Fixtures

Use these patterns when mock data is for local testing, E2E, or bug
reproduction.

## Fixture Principles

- Keep fixture setup organization-scoped.
- Use deterministic identifiers or stable lookup fields.
- Anchor timestamps to a fixed `now`.
- Include reset instructions.
- Cover one behavior clearly instead of creating a giant demo org for every
  test.

## Core Fixture Families

### Approval Flow

Entities:

- org
- board actor context
- one issue in `in_review`
- one approval linked to that issue
- activity entries for approval creation and decision

States to include:

- pending approval
- approved approval
- rejected approval with reason
- missing permission / agent trying to approve when only board should

### Budget Control

Entities:

- org with monthly budget
- agent with per-agent budget policy
- issue assigned to that agent
- cost events that approach and exceed budget
- activity entry for auto-pause

States to include:

- under budget
- near warning threshold
- hard stop exceeded
- agent paused after budget enforcement

### Heartbeat Runs

Entities:

- active heartbeat-enabled agent
- one assignable issue
- heartbeat run rows
- run events
- linked cost events

States to include:

- running
- succeeded
- failed
- canceled
- stale run with no recent heartbeat

### Chat To Issue

Entities:

- org with `manual_approval` chat issue creation mode
- chat conversation
- deterministic runtime stub
- issue proposal payload
- created issue after approval

States to include:

- proposal awaiting approval
- created issue state
- rejected proposal
- duplicate primary issue attempt

### Atomic Issue Checkout

Entities:

- one org
- two agent API keys
- one todo issue
- checkout attempts from both agents

States to include:

- first checkout succeeds
- second concurrent checkout returns conflict
- another organization cannot access the issue

## Output Guidance

For E2E tests, produce:

- setup helper name
- created entities
- stable selectors or lookup keys
- expected assertions
- cleanup/reset path

For service tests, produce:

- minimal rows
- API calls or direct DB inserts
- expected HTTP status codes
- activity log expectations for mutations
