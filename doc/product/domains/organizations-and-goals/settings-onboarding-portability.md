---
title: Settings Onboarding And Portability
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids:
  - ORG.SETTINGS.001
  - ORG.ONBOARDING.001
  - ORG.DESKTOP.RELEASE.NOTES.001
  - ORG.PORTABILITY.001
related_code:
  - desktop/src/main.ts
  - desktop/src/post-update-reload.ts
  - desktop/src/release-notes.ts
  - packages/db/src/schema/instance_settings.ts
  - packages/db/src/schema/operator_profiles.ts
  - packages/db/src/schema/organization_intelligence_profiles.ts
  - server/src/routes/instance-settings.ts
  - server/src/routes/onboarding.ts
  - server/src/services/instance-settings.ts
  - server/src/services/operator-profile.ts
  - server/src/services/organization-intelligence-profiles.ts
  - server/src/services/knowledge-portability/organization-portability.export.ts
  - server/src/services/knowledge-portability/organization-portability.import.ts
  - server/src/services/export-jobs.ts
  - ui/index.html
  - ui/src/App.tsx
  - ui/src/lib/organization-routes.ts
  - ui/src/lib/organization-page-memory.ts
  - ui/src/hooks/useOrganizationPageMemory.ts
  - ui/src/components/Layout.tsx
  - ui/src/components/MobileBottomNav.tsx
  - ui/src/components/OnboardingWizard.tsx
  - ui/src/context/ThemeContext.tsx
  - ui/src/pages/InstanceAppearanceSettings.tsx
  - ui/src/pages/InstanceGeneralSettings.tsx
  - ui/src/pages/InstanceSettings.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/pages/OrganizationExport.tsx
  - ui/src/pages/OrganizationImport.tsx
  - ui/src/pages/InviteLanding.tsx
  - ui/src/pages/NotFound.tsx
  - ui/src/components/DesktopReleaseNotesDialog.tsx
related_tests:
  - desktop/src/release-notes.test.ts
  - desktop/src/post-update-reload.test.ts
  - server/src/__tests__/instance-settings-service.test.ts
  - server/src/__tests__/instance-settings-routes.test.ts
  - server/src/__tests__/operator-profile-service.test.ts
  - server/src/__tests__/organization-intelligence-profiles.test.ts
  - server/src/__tests__/organization-intelligence-profiles-routes.test.ts
  - server/src/__tests__/export-jobs.test.ts
  - ui/src/components/OnboardingWizard.runtime-config.test.tsx
  - ui/src/context/ThemeContext.test.tsx
  - ui/src/hooks/useOrganizationPageMemory.test.ts
  - ui/src/lib/organization-routes.test.ts
  - ui/src/pages/InstanceAppearanceSettings.test.tsx
  - ui/src/pages/InstanceGeneralSettings.test.tsx
  - ui/src/components/DesktopReleaseNotesDialog.test.tsx
  - tests/e2e/onboarding.spec.ts
  - tests/e2e/settings-appearance.spec.ts
  - tests/e2e/settings-sidebar.spec.ts
  - tests/e2e/organization-export-build-job.spec.ts
  - tests/e2e/profile-context-import.spec.ts
edit_policy: user_confirmed_only
---

# Settings Onboarding And Portability

## ORG.SETTINGS.001

Why:

- Instance, operator, organization, notification, shortcut, runtime, and
  intelligence-profile settings shape how the work loop is entered and
  interpreted. They need a product contract so settings changes do not become
  hidden workflow changes.

Product model:

- Instance settings are deployment/local-shell scoped.
- Operator profile settings are user-scoped.
- Organization settings and intelligence profiles are organization-scoped.
- Appearance settings are presentation-only local shell/browser preferences.
  They do not mutate organization records, agent behavior, runtime behavior, or
  shared operator profile state.
- Settings surfaces may be route-backed overlays, but persistence belongs to the
  corresponding service/table unless the setting is explicitly presentation-only
  local UI state.
- Appearance exposes four independent controls:
  - color mode: `light`, `system`, `dark`
  - design style: `default`, `mira`, `luma`
  - base color: `neutral`, `stone`, `zinc`, `mauve`, `olive`, `mist`, `taupe`
  - theme color: `neutral`, `amber`, `blue`, `cyan`, `emerald`, `fuchsia`,
    `green`, `indigo`, `lime`, `orange`, `pink`

Flow:

1. Operator opens Settings from shell or organization routes.
2. UI loads current instance/operator/org configuration.
3. Service-backed pages save through the owning settings service and invalidate
   relevant UI caches.
4. Appearance choices apply immediately by setting root DOM attributes and the
   resolved browser theme color, then persist to local storage so the next app
   boot can apply the same presentation before React finishes loading.
5. Affected workflows read settings through their own domain service; workflow
   behavior must not depend on presentation-only appearance values.

Invariants:

- Settings must not silently cross organization or user boundaries.
- Route-backed settings overlays must preserve the previous work surface when
  the shell uses contextual settings.
- Appearance state must remain reversible and local: selecting a color mode,
  design style, base color, or theme color must not change any durable work
  object, organization setting, runtime config, agent instruction, or review
  outcome.
- Stored appearance values outside the supported option sets must fall back to
  the default presentation instead of leaving the app in an undefined style.
- The app shell must apply persisted appearance values early enough to avoid a
  first-paint mismatch between the saved local preference and the hydrated UI.

Evidence:

- `server/src/__tests__/instance-settings-service.test.ts`,
  `server/src/__tests__/instance-settings-routes.test.ts`, and
  `server/src/__tests__/operator-profile-service.test.ts` cover settings
  persistence and profile behavior.
- `ui/src/context/ThemeContext.test.tsx` covers supported appearance values,
  DOM attributes, local storage persistence, and Desktop shell appearance
  bridging.
- `ui/src/pages/InstanceAppearanceSettings.test.tsx` covers the visible
  Appearance settings choices.
- `tests/e2e/settings-appearance.spec.ts` covers the user-visible Appearance
  workflow, including persistence for expanded base and theme color options.
- `tests/e2e/settings-sidebar.spec.ts` covers visible settings navigation.
- Known gap: each new settings subpage should add focused coverage when it
  changes a user-visible workflow.

## ORG.ONBOARDING.001

Why:

- Onboarding is the first work-loop path. It must get a user from fresh install
  to a usable organization/agent setup without making runtime/provider plumbing
  the product's first impression.

Product model:

- Onboarding can create or select organization, seed starter context, expose
  invite/onboarding instructions, and guide runtime configuration.
- Getting Started onboarding seed creates starter project/issues and mirrors
  those issue threads into the operator's Messenger directory as a grouped,
  already-read starter set.
- Messenger is the organization home and default landing surface for root app
  startup, first organization entry, and newly created onboarding organizations.
  Dashboard remains an explicit observability page, not the organization home.
- The full tutorial seed creates a `Getting Started` project with one welcome
  issue and eleven numbered tutorial issues. The experienced-user seed may
  create only the welcome issue.
- Seeded tutorial issues carry grouped status/priority intent: the welcome issue
  starts done, core-loop issues start todo, and later recommended/advanced
  issues start backlog.
- Seeded issue descriptions may include next-issue links and chat CTA links that
  prefill a prompt, selected project, and first available agent.
- Invite landing surfaces can show onboarding skill/text instruction links for
  external agents.

Flow:

1. Fresh user or invited actor enters onboarding/invite route.
2. Server exposes safe onboarding metadata and required setup state.
3. UI guides organization/agent/runtime setup.
4. Server seeds starter work when needed, including the `Getting Started`
   project, tutorial issues, next-step links, chat CTA links, Messenger grouping,
   and read-state markers required for the starter set.
5. User lands in the organization's Messenger home with starter work or clear
   next action.

Invariants:

- Onboarding should end in a real Rudder work surface, not a detached marketing
  page.
- Onboarding for a newly created organization must resolve to
  `/{issuePrefix}/messenger`.
- Root app startup and organization-index entry must resolve to the selected or
  first available organization's Messenger route.
- "Home", "workspace", and "back to workspace" fallbacks should use the
  organization home route, currently `/messenger`, rather than Dashboard.
- Dashboard must remain route-accessible as an explicit analysis/observability
  surface, but it must not be treated as the default landing or home surface.
- Seeded Getting Started issues are starter content, not new operator
  attention. They should appear under a `Getting Started` Messenger custom
  group for the operator and should not create unread Messenger or sidebar
  badge debt at first landing.
- Getting Started issue links must stay organization-route-aware so next-step
  links and chat CTAs open inside the newly created organization, not a global
  or stale organization route.
- Onboarding seed must be idempotent for an existing active `Getting Started`
  project: repeated seed calls reuse matching starter issues instead of creating
  duplicates.
- Auth/deployment mode constraints remain respected.

Evidence:

- `tests/e2e/onboarding.spec.ts` covers the onboarding UI path, including
  post-onboarding Messenger landing and root startup redirect to Messenger.
- `tests/e2e/onboarding.spec.ts` covers Getting Started project creation,
  tutorial issue grouping/statuses, next-issue links, chat CTA prefill with
  project/agent context, Messenger custom group membership, and cleared unread
  sidebar state for seeded starter issues.
- `ui/src/lib/organization-routes.test.ts`,
  `ui/src/hooks/useOrganizationPageMemory.test.ts`,
  `ui/src/components/OnboardingWizard.runtime-config.test.tsx`, and
  `ui/src/pages/InstanceGeneralSettings.test.tsx` cover organization home route,
  page-memory fallback, onboarding completion, and settings return behavior.
- `server/src/__tests__/invite-onboarding-text.test.ts` covers invite/onboarding
  instruction text behavior.
- Known gap: release-smoke onboarding evidence still belongs to release/Desktop
  validation, not this product contract alone.

## ORG.DESKTOP.RELEASE.NOTES.001

Why:

- Desktop release notes should make installed updates legible without adding
  friction to a fresh user's first work-loop path.
- A new user should not see a "what changed" dialog before they have any prior
  version context.

Product model:

- Desktop keeps release-note display state in the Electron `userData` profile.
- The state records the current app version as a baseline for fresh installs and
  the last version whose notes were acknowledged.
- The Desktop post-update restart marker is the signal that a launch follows an
  in-app update, even when no previous release-note display state exists.

Flow:

1. On Desktop startup, the renderer asks the Desktop shell for release notes.
2. If no release-note state exists and the launch is not tied to a consumed
   post-update marker, Desktop records the current version baseline and returns
   no notes.
3. If the launch follows an in-app update and release notes exist for the target
   version, Desktop returns those notes for a one-time dialog.
4. If prior state records an older known version and the current version has not
   been acknowledged, Desktop returns release notes for the current version.
5. Closing the dialog records the current version as both known and shown.

Invariants:

- Fresh installs must not show the release-notes dialog on first launch.
- The first launch after an app update should show release notes at most once
  for the installed version.
- Old state files that only contain `lastShownVersion` remain valid for upgrade
  detection.
- Missing or unavailable release-note markdown must not block app use.

Evidence:

- `desktop/src/release-notes.test.ts` covers fresh-install baseline behavior,
  post-update launch behavior, update detection, and legacy state
  compatibility.
- `ui/src/components/DesktopReleaseNotesDialog.test.tsx` covers the visible
  dialog and acknowledgement path.
- `desktop/src/post-update-reload.test.ts` covers the update marker consumed on
  post-update restart.

## ORG.PORTABILITY.001

Why:

- Organization export/import is how agent-team knowledge, issues, automations,
  skills, resources, and files can move between instances without becoming an
  unsafe database dump.

Product model:

- Export builds a portable file bundle plus `.rudder.yaml` manifest.
- Import previews dependencies, collisions, secrets/env requirements, and
  selected entities before applying.
- Export jobs preserve progress and result artifacts.

Flow:

1. Operator starts export or import.
2. Export job builds files/manifest/readme with selected entities.
3. Import preview parses source package and shows dependency tree.
4. Operator selects entities and collision/secret strategy.
5. Apply imports through domain services rather than raw DB writes.

Invariants:

- Portability must preserve organization boundaries and avoid leaking secrets.
- Import must be previewable before mutation.

Evidence:

- `server/src/__tests__/export-jobs.test.ts` covers export job behavior.
- `tests/e2e/organization-export-build-job.spec.ts` covers visible export job
  flow.
- `tests/e2e/profile-context-import.spec.ts` covers profile/context import
  behavior.
- Known gap: every new portable entity type needs explicit manifest/import
  coverage before it is considered safe for export/import.
