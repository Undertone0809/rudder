# Rename Automations to Automations

## Summary

- Perform a full hard rename from `automation(s)` to `automation(s)` across product language, routes, API contracts, shared types, database schema, portability format, docs, and tests.
- Do not keep compatibility aliases for old UI routes, API paths, activity event names, entity types, issue origin kinds, or portability keys.
- Create a forward-only schema migration that removes the old automation structures and replaces them with automation-named structures. Historical data preservation is explicitly out of scope for this change.

## Key Changes

- Rename domain contracts from `Automation*` to `Automation*`, including constants, validators, API clients, services, routes, pages, helper utilities, and test fixtures.
- Rename database tables and related indexes/constraints to `automations`, `automation_triggers`, and `automation_runs`.
- Rename issue origin kind from `routine_execution` to `automation_execution`, including the issue uniqueness index and all service logic that reads or writes automation-linked issues.
- Rename activity log actions and entity types from `routine.*` / `routine_*` to `automation.*` / `automation_*`.
- Rename portability contracts from `issue.routine` and `.rudder.yaml routines:` to `issue.automation` and `.rudder.yaml automations:`.
- Rename UI and docs from `Routine/Routines` to `Automation/Automations`, and switch board routes from `/routines` to `/automations`.

## Public Contract Changes

- UI routes:
  - `/automations`
  - `/automations/:automationId`
- API routes:
  - `GET/POST /api/orgs/:orgId/automations`
  - `GET/PATCH /api/automations/:id`
  - `GET /api/automations/:id/runs`
  - `POST /api/automations/:id/triggers`
  - `POST /api/automations/:id/run`
  - `PATCH/DELETE/POST rotate-secret /api/automation-triggers/:id...`
  - `POST /api/automation-triggers/public/:publicId/fire`
- Shared contract names:
  - `Automation`, `AutomationDetail`, `AutomationTrigger`, `AutomationRun`
  - `AUTOMATION_*` constants
  - `automation_execution` issue origin kind
  - `issue.automation` portability payload

## Test Plan

- Update backend unit and e2e coverage to use automation paths, automation activity names, and `automation_execution`.
- Update portability and CLI tests to emit and consume `automations:` and `issue.automation`.
- Update frontend tests and verify navigation, detail views, and issue source links all use `/automations`.
- Run:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`

## Assumptions

- Singular product term is `Automation`; plural is `Automations`.
- No compatibility redirects or aliases are required.
- No existing data needs to be preserved during the schema rename.
