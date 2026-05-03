# Scenario Index

Use this catalog to pick the smallest scenario that fully serves the user's
need. Prefer a coherent scenario spine over unrelated rows.

## Rudder Scenarios

### Landing Demo Org

Use for local screenshots, landing proof shots, README or deck images, and
product demos that need the app to look alive.

Read `rudder-landing-demo-org.md`.

### Test Fixtures

Use for E2E tests, API and service tests, bug reproduction, edge-state
coverage, and deterministic local dev data.

Read `rudder-test-fixtures.md`.

### User Scenario Explanation

Use for explaining Rudder to a user through concrete examples, showing how a
founder or engineering lead uses agent teams, and turning abstract features
into a scenario narrative.

Read `rudder-user-scenarios.md`.

## Generic Scenarios

### SaaS Dashboard

Use for billing, activation, retention, usage, support, reliability, and
executive dashboard mock data. Read `generic-saas-dashboard.md`.

### CRM / Sales

Use for accounts, contacts, opportunities, pipeline stages, support tickets,
renewals, and customer-success views. Read `generic-crm-sales.md`.

### Edge States

Use alongside any scenario when the user needs empty, loading, error,
permission, conflict, budget, or partial-success states. Read `edge-states.md`.

## Selection Rules

- If the user says "screenshot", "demo", "landing", or "looks real", optimize
  for visual density and story coherence.
- If the user says "test", "E2E", "fixture", "repro", or "edge case",
  optimize for determinism and coverage.
- If the user says "help users understand", "user scenario", "customer
  story", or "explain this workflow", optimize for persona, conflict, and
  before/after state.
- If the user asks for a file format, produce that format directly and keep a
  short scenario note above it.
