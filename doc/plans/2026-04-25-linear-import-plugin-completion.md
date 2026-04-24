---
title: Linear import plugin completion
date: 2026-04-25
kind: implementation
status: completed
area: ui
entities:
  - plugin_linear
  - plugin_settings_page
  - linear_issue_link
issue:
related_plans:
  - 2026-03-13-plugin-kitchen-sink-example.md
supersedes: []
related_code:
  - packages/plugins/examples/plugin-linear
  - packages/plugins/sdk
  - ui/src/plugins/slots.tsx
commit_refs:
  - "feat: add linear import plugin"
updated_at: 2026-04-25
---

# Linear Import Plugin Completion

## Goal

Finish the first-party `@rudder/plugin-linear` package as an import-first
Rudder connector. The plugin should import Linear issues into Rudder as
executable work and maintain a one-to-one plugin-owned link back to the source
Linear issue.

## Scope

- Add `packages/plugins/examples/plugin-linear/` as a real first-party local
  plugin package.
- Provide a plugin page at the `linear` route for filtering, selecting, and
  importing Linear issues.
- Provide a custom settings page for the Linear secret reference and
  organization/team/state mappings.
- Provide an issue detail tab for linked Linear issue details.
- Keep v1 import-first only: no dashboard widget, project tab, agent tools,
  webhooks, background sync, comment sync, status pushback, or manual relink.

## Implementation Notes

- Use existing plugin SDK capabilities only.
- Store links through plugin-owned `linear_issue_link` records scoped to Rudder
  issues, plus issue-scoped plugin state for fast detail lookup.
- Keep duplicate imports blocked by default.
- Keep `import all matching` bounded to 100 Linear issues per action.
- Avoid browser-unsafe worker constants in the plugin UI bundle so the custom
  settings page actually loads in Rudder.

## Validation

- `pnpm --filter @rudder/plugin-linear typecheck` passed.
- `pnpm --filter @rudder/plugin-linear test` passed.
- `pnpm --filter @rudder/plugin-linear build` passed.
- `RUDDER_E2E_RUN_ID=linear-plugin-import npx playwright test tests/e2e/linear-plugin-import.spec.ts --config tests/e2e/playwright.config.ts --reporter=line --timeout=120000` passed.
- `pnpm -r typecheck` was attempted and failed in an unrelated dirty CLI
  test file: `cli/src/__tests__/company-import-export-e2e.test.ts`.
- `pnpm test:run` was attempted and failed in the same unrelated CLI
  import/export E2E area.
- `pnpm build` was attempted after the final Linear changes and failed in
  unrelated dirty UI work under `ui/src/pages/AutomationDetail.tsx`.
