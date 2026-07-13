---
title: Settings Onboarding And Portability
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids:
  - ORG.IDENTITY.001
  - ORG.SETTINGS.001
  - ORG.ONBOARDING.001
  - ORG.DESKTOP.RELEASE.NOTES.001
  - ORG.PORTABILITY.001
related_code:
  - packages/db/src/schema/organization_issue_prefix_aliases.ts
  - packages/db/src/schema/organizations.ts
  - packages/shared/src/organization-issue-key.ts
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-profile.ts
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
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/pages/InstanceGeneralSettings.tsx
  - ui/src/pages/InstanceSettings.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/pages/OrganizationExport.tsx
  - ui/src/pages/OrganizationImport.tsx
  - ui/src/pages/InviteLanding.tsx
  - ui/src/pages/NotFound.tsx
  - ui/src/components/DesktopReleaseNotesDialog.tsx
related_tests:
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-profile.test.ts
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
  - ui/src/pages/InstanceBrowserSettings.test.tsx
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

## ORG.IDENTITY.001

Why:

- Organization display names, stable navigation, issue references, and
  database ownership are different identity jobs. One mutable-looking prefix
  must not silently control all four.

Product model:

- `organization.id` is the immutable internal UUID and organization-scope key.
- `organization.urlKey` is the stable canonical organization route segment. It
  is allocated at creation, resolves case-insensitively, and does not change
  when the organization name or Issue Key changes.
- `organization.name` is editable display text.
- `organization.issuePrefix` is the operator-facing Issue Key used to form
  readable issue identifiers. New organization creation shows this value,
  derives a default that preserves letters and digits, and lets the operator
  edit it before submission.
- Across different organizations, canonical `urlKey` values, current Issue
  Keys, and historical Issue Keys share one case-insensitive route namespace.
  A value owned by one organization cannot be allocated to another organization
  in any of those roles.

Flow:

1. The operator enters an organization name.
2. UI derives and displays an editable Issue Key; for example, `R6` derives
   `R6` and previews `R6-1`.
3. Server validates the submitted key and rejects a current or historical
   conflict with an actionable error. It must not silently append characters.
4. Server allocates an independent stable `urlKey`; URL-key collisions may use
   a numeric URL suffix without changing the submitted Issue Key.
5. Organization navigation generates `/{urlKey}/...`. Current Issue Key and
   historical Issue Key routes remain accepted during compatibility migration.
6. An explicit settings change migrates the Issue Key and current issue
   identifiers transactionally while preserving the previous key as an alias.

Invariants:

- Renaming an organization must not change `urlKey` or Issue Key implicitly.
- Issue Key conflicts must be visible to the operator and require an explicit
  alternative; repeated automatic `A` suffixes are prohibited.
- URL-key allocation may add a numeric URL suffix when its preferred value is
  already owned as a URL key, current Issue Key, or historical Issue Key.
- Changing an Issue Key must not change organization UUID, issue UUIDs, or issue
  numbers, and must not break old organization or issue links.
- New canonical links use `urlKey`. Compatibility routes may resolve an active
  or historical Issue Key but must converge on the stable organization route.

Evidence:

- `packages/shared/src/organization-issue-key.test.ts` covers numeric default
  derivation and explicit key normalization.
- `server/src/__tests__/orgs-service.test.ts` covers conflict rejection,
  transactional migration, repeated migration, and historical issue lookup.
- `ui/src/lib/organization-routes.test.ts` covers stable route generation and
  historical organization-key resolution.
- `tests/e2e/organization-issue-key.spec.ts` covers creation, migration,
  stable navigation, and old-link compatibility on the rendered product path.

## ORG.SETTINGS.001

Why:

- Instance, operator, organization, notification, shortcut, runtime, and
  intelligence-profile settings shape how the work loop is entered and
  interpreted. They need a product contract so settings changes do not become
  hidden workflow changes.

Product model:

- Instance settings are deployment/local-shell scoped.
- Browser settings are instance-scoped behavioral settings shared by every
  organization in the current local Rudder instance. `enabled` defaults to
  `true`, and `openLinksIn` defaults to `built_in`; the alternative link
  destination is `default_browser`.
- Browser settings do not make Browser data organization-scoped. The Desktop
  Browser profile belongs to the current OS user plus canonical Rudder instance
  and intentionally shares signed-in website sessions across organizations.
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
4. Browser settings control the instance capability and default web-link
   destination. Import and clear actions execute through the trusted Desktop
   boundary and disclose that their effect is shared across organizations.
5. Appearance choices apply immediately by setting root DOM attributes and the
   resolved browser theme color, then persist to local storage so the next app
   boot can apply the same presentation before React finishes loading.
6. Affected workflows read settings through their own domain service; workflow
   behavior must not depend on presentation-only appearance values.

Invariants:

- Settings must not silently cross organization or user boundaries.
- Missing or legacy Browser fields must resolve to enabled plus built-in link
  routing. Invalid saved values must fall back to those defaults.
- Disabling Browser preserves its profile data and saved link preference;
  clearing Browser data preserves both settings. Their tab, lease, and data
  lifecycle is owned by `AGENT.BROWSER.001`.
- Browser import and clear must name the instance-wide, cross-organization
  session impact and require explicit confirmation before reading or deleting
  browser data.
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
- `server/src/__tests__/instance-settings-service.test.ts`,
  `server/src/__tests__/instance-settings-routes.test.ts`, and
  `ui/src/pages/InstanceBrowserSettings.test.tsx` cover Browser defaults,
  persistence, supported values, and visible instance-wide controls.
- `desktop/src/browser-ipc.test.ts` and `desktop/src/browser-profile.test.ts`
  cover trusted clear/disable handling and preservation of Browser settings.
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
- When onboarding creates a new organization and then creates that new
  organization's first agent with the Codex local runtime in the same onboarding
  flow, Rudder must derive the organization's Fast and Smart intelligence
  profiles from that Codex runtime, test each profile's runtime chain, and
  automatically enable only the profiles whose tests pass.
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
- Seeded guidance presents Chat and issues as parallel task workflows: Chat is
  conversation-driven, while issues add structured tracking. It must not teach
  that real or durable work requires conversion from Chat into an issue.
- Invite landing surfaces can show onboarding skill/text instruction links for
  external agents.

Flow:

1. Fresh user or invited actor enters onboarding/invite route.
2. Server exposes safe onboarding metadata and required setup state.
3. UI guides organization/agent/runtime setup.
4. When the selected local runtime requires a runtime environment check,
   onboarding tests that agent runtime before creating the first agent.
5. If the first agent is Codex local, server derives Fast and Smart
   organization intelligence profiles from the tested Codex runtime config,
   runs the same runtime-chain environment checks used by manual profile
   enablement, persists passing profiles as `configured` with verification
   evidence, and leaves failing profiles disabled/invalid with visible error
   state instead of silently enabling them.
6. Server seeds starter work when needed, including the `Getting Started`
   project, tutorial issues, next-step links, chat CTA links, Messenger grouping,
   and read-state markers required for the starter set.
7. User lands in the organization's Messenger home with starter work or clear
   next action.

Invariants:

- Onboarding should end in a real Rudder work surface, not a detached marketing
  page.
- Codex-created organization intelligence profiles must not be marked
  configured unless their runtime-chain environment test passes.
- A failed Fast or Smart intelligence-profile test must not block organization
  or agent creation; it must leave an inspectable non-configured profile state
  so the operator can repair credentials/model/runtime setup and enable it
  later.
- Automatic Fast/Smart enablement is limited to the new-organization onboarding
  flow's first Codex local agent. Existing organizations, later agents, and
  non-Codex runtimes may still create disabled derived profile drafts for manual
  configuration when the relevant service path requests defaults.
- Onboarding for a newly created organization must resolve to
  `/{urlKey}/messenger`.
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
- `server/src/__tests__/organization-intelligence-profiles.test.ts` covers
  derived Codex Fast/Smart defaults and automatic configured/invalid outcomes
  based on runtime-chain test results.
- `server/src/__tests__/organization-intelligence-profiles-routes.test.ts`
  covers the same runtime-chain gate used when an operator manually enables an
  organization intelligence profile.
- `server/src/__tests__/invite-onboarding-text.test.ts` covers invite/onboarding
  instruction text behavior.
- Known gap: release-smoke onboarding evidence still belongs to release/Desktop
  validation, not this product contract alone.

## ORG.DESKTOP.UPDATE.001

Why:

- Packaged Desktop updates should not make operators choose between losing
  active agent work and getting stuck on an obsolete build.
- Update progress should stay visible in the board shell so the operator can
  understand whether the app is downloading, waiting for active work, ready to
  apply, applying, complete, or failed.

Product model:

- In-app update install is available only from packaged Rudder Desktop builds.
- Desktop checks the selected release channel, downloads the matching portable
  Desktop asset, verifies checksums, and then waits for an explicit apply signal
  before replacing the installed app.
- If active runs exist when an update starts, Desktop can download the installer
  while keeping those runs alive.
- The update session preserves the active-run count across intermediate
  download/checksum progress events so the final ready state can keep the
  correct operator actions visible.

Flow:

1. The operator checks for an update or accepts the startup update prompt.
2. If no active runs are present, Desktop downloads and verifies the update,
   then shows a ready action to quit and update.
3. If active runs are present, Desktop asks whether to download now and update
   when idle, stop runs and update now, or cancel.
4. When the operator chooses to update when idle, Desktop downloads and verifies
   the update while keeping active work running. The ready status must show both
   the idle apply path and the force apply path.
5. Choosing the force apply path cancels active runs, quits Rudder, and applies
   the update immediately.
6. If a session expires or the child installer fails, Desktop reports a failed
   update state with retry and releases-page actions.

Invariants:

- Active runs must not be cancelled by the default deferred download path.
- A ready update that still has active runs must not collapse to a plain
  "Quit and update" action; it must expose the explicit force update action.
- Retrying or starting a second update while one is active reuses the existing
  update attempt instead of launching a competing installer.
- Failed update states must be operator-visible and should not silently close
  the board.
- A successful in-app update writes the post-update restart marker consumed by
  `ORG.DESKTOP.RELEASE.NOTES.001`.

Evidence:

- `desktop/src/desktop-update-flow.test.ts` covers update child diagnostics,
  deferred active-run updates, force apply, active update reuse, and preserving
  active-run count through final ready progress.
- `ui/src/components/DesktopUpdateStatusCard.test.tsx` covers the visible ready,
  force update, expired-session, and failure actions.
- `ui/src/components/DesktopUpdatePromptBridge.test.tsx` covers the renderer
  prompt copy and active-run choices shown before a deferred update starts.
- `desktop/src/desktop-quit-flow.test.ts` covers forced update quit handoff and
  active-run cancellation failure cases.

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
5. For a new-organization import, Rudder shows the fresh organization name and
   Issue Key independently. The operator can correct the Issue Key without
   changing the imported organization name.
6. Apply imports through domain services rather than raw DB writes.

Invariants:

- Portability must preserve organization boundaries and avoid leaking secrets.
- Importing into a new organization creates a fresh organization UUID,
  canonical `urlKey`, and Issue Key. Historical aliases from the source are not
  copied. A requested Issue Key that conflicts with any route identity owned by
  another organization is rejected for explicit correction.
- Import must be previewable before mutation.

Evidence:

- `server/src/__tests__/export-jobs.test.ts` covers export job behavior.
- `tests/e2e/organization-export-build-job.spec.ts` covers visible export job
  flow.
- `tests/e2e/profile-context-import.spec.ts` covers profile/context import
  behavior.
- Known gap: every new portable entity type needs explicit manifest/import
  coverage before it is considered safe for export/import.
