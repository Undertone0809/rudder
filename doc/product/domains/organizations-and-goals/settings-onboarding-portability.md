---
title: Settings Onboarding And Portability
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids:
  - ORG.IDENTITY.001
  - ORG.SETTINGS.001
  - ORG.ONBOARDING.001
  - ORG.DESKTOP.UPDATE.001
  - ORG.DESKTOP.UPDATE.ROLLBACK.001
  - ORG.DESKTOP.RELEASE.NOTES.001
  - ORG.PORTABILITY.001
related_code:
  - cli/src/commands/start.ts
  - cli/src/desktop-update-recovery.ts
  - packages/db/src/schema/organization_issue_prefix_aliases.ts
  - packages/db/src/schema/organizations.ts
  - packages/shared/src/organization-issue-key.ts
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-profile.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/desktop-update-flow.ts
  - desktop/src/desktop-update-recovery.ts
  - desktop/src/main.ts
  - desktop/src/post-update-reload.ts
  - desktop/src/release-notes.ts
  - desktop/src/update-check.ts
  - server/src/index.ts
  - server/src/desktop-update-maintenance.ts
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
  - ui/src/components/PageTabBar.tsx
  - ui/src/components/SettingsSidebar.tsx
  - ui/src/components/settings/SettingsPageSkeleton.tsx
  - ui/src/components/settings/SettingsScaffold.tsx
  - ui/src/context/ThemeContext.tsx
  - ui/src/pages/InstanceAboutSettings.tsx
  - ui/src/pages/InstanceAppearanceSettings.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/pages/InstanceGeneralSettings.tsx
  - ui/src/pages/InstanceNotificationsSettings.tsx
  - ui/src/pages/InstanceProfileSettings.tsx
  - ui/src/pages/InstanceSettings.tsx
  - ui/src/pages/InstanceShortcutsSettings.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/pages/OrganizationExport.tsx
  - ui/src/pages/OrganizationImport.tsx
  - ui/src/components/ImagePreviewDialog.tsx
  - ui/src/components/InspectableImage.tsx
  - ui/src/context/ImagePreviewContext.tsx
  - ui/src/pages/PluginManager.tsx
  - ui/src/pages/PluginSettings.tsx
  - ui/src/pages/InviteLanding.tsx
  - ui/src/pages/NotFound.tsx
  - ui/src/components/DesktopReleaseNotesDialog.tsx
  - ui/src/components/DesktopUpdatePromptBridge.tsx
  - ui/src/components/DesktopUpdateStatusCard.tsx
related_tests:
  - cli/src/__tests__/desktop-update-recovery.test.ts
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-profile.test.ts
  - desktop/src/desktop-quit-flow.test.ts
  - desktop/src/desktop-update-flow.test.ts
  - desktop/src/desktop-update-recovery.test.ts
  - desktop/src/release-notes.test.ts
  - desktop/src/post-update-reload.test.ts
  - desktop/src/update-check.test.ts
  - server/src/__tests__/instance-settings-service.test.ts
  - server/src/__tests__/desktop-update-maintenance.test.ts
  - server/src/__tests__/instance-settings-routes.test.ts
  - server/src/__tests__/operator-profile-service.test.ts
  - server/src/__tests__/organization-intelligence-profiles.test.ts
  - server/src/__tests__/organization-intelligence-profiles-routes.test.ts
  - server/src/__tests__/export-jobs.test.ts
  - ui/src/components/OnboardingWizard.runtime-config.test.tsx
  - ui/src/components/ImagePreviewDialog.test.tsx
  - ui/src/context/ImagePreviewContext.test.tsx
  - ui/src/components/SettingsSidebar.browser.test.tsx
  - ui/src/components/settings/SettingsScaffold.test.tsx
  - ui/src/context/ThemeContext.test.tsx
  - ui/src/hooks/useOrganizationPageMemory.test.ts
  - ui/src/lib/organization-routes.test.ts
  - ui/src/pages/InstanceAboutSettings.test.tsx
  - ui/src/pages/InstanceAppearanceSettings.test.tsx
  - ui/src/pages/InstanceBrowserSettings.test.tsx
  - ui/src/pages/InstanceGeneralSettings.test.tsx
  - ui/src/pages/InstanceNotificationsSettings.test.tsx
  - ui/src/pages/InstanceProfileSettings.test.tsx
  - ui/src/pages/InstanceSettings.test.tsx
  - ui/src/pages/InstanceShortcutsSettings.test.tsx
  - ui/src/components/DesktopReleaseNotesDialog.test.tsx
  - ui/src/components/DesktopUpdatePromptBridge.test.tsx
  - ui/src/components/DesktopUpdateStatusCard.test.tsx
  - tests/e2e/desktop-update-prompt.spec.ts
  - tests/e2e/onboarding.spec.ts
  - tests/e2e/settings-appearance.spec.ts
  - tests/e2e/settings-layout.spec.ts
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
- Settings uses one scope-first, route-backed information architecture across
  the contextual overlay and full-page fallback. Destinations are grouped as
  Personal, Desktop app, Runtime, Integrations, and Your organizations so the
  owner and effect of a setting remain legible before the operator opens it.
- The Settings shell owns grouped navigation, access and deployment gating,
  active-destination state, responsive composition, and close/return behavior.
  Each destination page owns its settings state, validation, persistence,
  domain actions, and success or failure feedback.
- The shell exposes only destinations authorized for the current operator and
  supported by the deployment. Instance administration destinations require
  instance-admin access, Browser is available only in `local_trusted`, and
  organization destinations remain organization-scoped.
- Appearance exposes four independent controls:
  - color mode: `light`, `system`, `dark`
  - design style: `default`, `mira`, `luma`
  - base color: `neutral`, `stone`, `zinc`, `mauve`, `olive`, `mist`, `taupe`
  - theme color: `neutral`, `amber`, `blue`, `cyan`, `emerald`, `fuchsia`,
    `green`, `indigo`, `lime`, `orange`, `pink`

Flow:

1. Operator opens Settings from shell or organization routes.
2. The shell resolves the current route, operator access, and deployment
   capabilities, builds the scope-first navigation, and visibly identifies the
   active destination.
3. A contextual overlay preserves the prior work surface while making that
   background inert and unavailable to assistive technology. Focus enters the
   Settings dialog, cycles within it, and returns to the opening control when
   Settings closes. The full-page fallback exposes the same authorized routes
   and destination ownership.
4. On narrow viewports, opening Settings navigation presents it as an
   independent modal layer, moves focus into that layer, and makes destination
   content non-interactive until navigation is dismissed. Selecting a
   destination closes the layer; dismissing it returns focus to its trigger.
5. UI loads current instance/operator/org configuration for the selected page.
6. Service-backed pages save through the owning settings service and invalidate
   relevant UI caches.
7. Browser settings control the instance capability and default web-link
   destination. Import and clear actions execute through the trusted Desktop
   boundary and disclose that their effect is shared across organizations.
8. Appearance choices apply immediately by setting root DOM attributes and the
   resolved browser theme color, then persist to local storage so the next app
   boot can apply the same presentation before React finishes loading.
9. Affected workflows read settings through their own domain service; workflow
   behavior must not depend on presentation-only appearance values.

Invariants:

- Settings must not silently cross organization or user boundaries.
- Settings navigation must keep personal, instance/Desktop, runtime,
  integration, and organization scopes visibly distinct. Viewing another
  organization's settings must not implicitly switch the operator's active
  organization.
- Contextual overlay and full-page shells must preserve stable routes and expose
  the same authorized destinations. Responsive composition must not hide a
  capability, change its persistence owner, or alter its save/action semantics.
- A contextual Settings overlay must behave as a modal dialog: background work
  surfaces are inert and hidden from assistive technology, keyboard focus cannot
  escape the dialog, and closing restores focus to the opener when it remains
  available.
- The active destination must remain identifiable after route changes,
  including nested plugin and organization destinations.
- On narrow viewports, Settings navigation and destination content must not be
  interactive at the same time. Escape dismisses an open navigation layer
  before it can close the surrounding Settings surface, and focus returns to
  the navigation trigger.
- Visual regrouping must preserve scope disclosures and existing confirmation
  gates. Destructive or cross-scope actions must remain explicitly labeled and
  distinguishable from routine settings changes.
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
- `ui/src/components/settings/SettingsScaffold.test.tsx` covers the semantic
  page, header, group, item, field, action, and choice slots shared by Settings
  destinations.
- `ui/src/components/PageTabBar.test.tsx` and
  `ui/src/components/JsonSchemaForm.test.tsx` cover mobile tab semantics and
  nested plugin-configuration layout containment.
- `ui/src/components/SettingsSidebar.browser.test.tsx` covers instance-admin and
  deployment gating for Settings destinations.
- `tests/e2e/settings-sidebar.spec.ts` covers route-backed Settings navigation,
  scope groupings, and contextual overlay return behavior.
- `tests/e2e/settings-layout.spec.ts` covers representative Settings pages,
  active destinations, mobile navigation focus and dismissal, Escape ordering,
  and horizontal-overflow protection.
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
  Desktop asset, verifies checksums, and automatically applies the accepted
  update when no running Agent Run would be interrupted.
- Desktop update safety is instance-wide. A running blocker may belong to an
  organization other than the one currently visible in the board.
- Only Agent Runs whose current status is `running` require an interruptive
  Stop Runs decision. Queued work is recovered after restart, and terminal
  records with pending close-out effects are not presented as executing runs.
- The update session refreshes current blockers instead of treating the count
  captured when the download started as current truth.

Flow:

1. The operator checks for an update or accepts the startup update prompt.
2. If no running blockers are present across the instance, Desktop downloads,
   verifies, quits, applies, and relaunches without requiring a second Update
   button.
3. If running blockers are present, Desktop names the affected organization and
   agent and asks whether to update automatically when work finishes, stop the
   named runs and update now, or cancel.
4. When the operator chooses to update when idle, Desktop downloads and verifies
   the update while keeping current running work alive. At ready time it
   refreshes blockers, shows their current identity while waiting, and applies
   automatically as soon as none remain.
5. A run that starts during download is discovered before apply and safely
   delays replacement. The update-quit handoff performs a final running-run
   check to close the Electron-to-installer race window. If that final check
   finds a blocker, Desktop refreshes its organization and agent identity and
   restores the force-stop action for the same accepted update session.
6. Choosing the force apply path cancels current running blockers, quits Rudder,
   and applies the update immediately.
7. If blocker inspection fails while an accepted update is waiting, Desktop
   remains fail-closed, exposes the inspection error, and retries until current
   running work can be confirmed. An expired session or failed child installer
   reports a failed update state with retry and releases-page actions.

Invariants:

- Running blockers must not be cancelled by the default deferred download path.
- The original Update choice, or explicit Update When Idle choice, is sufficient
  intent to apply automatically after safety checks pass.
- Current blocker identity must come from a fresh instance-wide query at the
  decision boundary; an initial count must not keep stale controls visible.
- If the local runtime is unavailable or blocker inspection fails, zero blockers
  is not established: Desktop hides unconfirmed blocker identity and force-stop
  controls until a fresh query succeeds.
- A waiting update with running blockers must expose their organization and
  agent identity plus an explicit force update action.
- Queued and terminal-effects-pending records must not be described as running
  blockers or cancelled solely to permit an update.
- Retrying or starting a second update while one is active reuses the existing
  update attempt instead of launching a competing installer.
- Failed update states must be operator-visible and should not silently close
  the board.
- A transient blocker-inspection failure must never be treated as proof that it
  is safe to replace Desktop, and must not discard an otherwise valid accepted
  update session. This also applies after the CLI final race guard has started
  waiting.
- A successful in-app update writes the post-update restart marker consumed by
  `ORG.DESKTOP.RELEASE.NOTES.001`.
- Installer launch handoff is not update success. A packaged macOS update is
  accepted only after `ORG.DESKTOP.UPDATE.ROLLBACK.001` records the exact
  Desktop/runtime candidate as ready and commits the update transaction.

Evidence:

- `desktop/src/desktop-update-flow.test.ts` covers update child diagnostics,
  live blocker refresh, automatic safe apply, force apply, and active update
  reuse.
- `ui/src/components/DesktopUpdateStatusCard.test.tsx` covers visible blocker
  identity, automatic waiting, force update, and failure actions.
- `ui/src/components/DesktopUpdatePromptBridge.test.tsx` covers the renderer
  prompt copy and running-blocker choices shown before a deferred update starts.
- `desktop/src/desktop-quit-flow.test.ts` covers forced update quit handoff and
  running-blocker cancellation failure cases.
- `tests/e2e/desktop-update-prompt.spec.ts` covers cross-organization blocker
  identity and readable update actions in desktop and narrow viewports.

## ORG.DESKTOP.UPDATE.ROLLBACK.001

## Contract Summary

Rudder treats a packaged Desktop update as a recoverable transaction with one
candidate and one local last-known-good installation. The recovery unit is the
verified Desktop bundle, exact server runtime, PostgreSQL payload, update
channel and architecture, plus a compatible embedded-database state.

The current automatic rollback scope is packaged macOS Desktop using the local
`prod_local/default` instance and embedded PostgreSQL. GitHub Releases is the
current fallback release catalog, and every downloaded fallback package passes
the release checksum gate before replacement.

## Intent / User Job

An existing operator whose accepted update cannot start should return to the
last working Rudder version without reconstructing the installation or risking
their local data. A fresh operator should receive one explicit, confirmed path
to a verified previous package when doing so is safe.

## Why / Design Reasoning

- A Desktop update that replaces a working installation but cannot start must
  not strand an operator without Rudder or require them to reconstruct the
  previous installation manually.
- A binary downgrade is not a safe recovery by itself because the new version
  may have changed the embedded database before startup failed.

## Actors / Objects / State

- Actors: Desktop operator, installed Desktop main process and supervising CLI
  recovery helper.
- Objects: candidate bundle/runtime, last-known-good bundle/runtime, embedded
  PostgreSQL checkpoint, update journal, quarantine and rollback incident.
- States: prepared, backup ready, candidate installed, candidate ready,
  committed, cancelled, rollback pending, rolled back and rollback failed.

## Entry Points / Inputs

- Accepted packaged Desktop update after instance-wide active-run gates pass.
- Candidate startup failure or readiness timeout before commit.
- First packaged launch failure without initialized embedded instance data.
- Operator feedback and confirmed fallback-install actions.

## Product Logic Flow

- The first recovery-capable release is an arming release. Automatic recovery
  is guaranteed only when the version being replaced already contains the
  recovery protocol and can supervise its successor.
- The current automatic rollback scope is packaged macOS Desktop using the
  local `prod_local/default` instance and embedded PostgreSQL. External
  PostgreSQL and other platforms remain outside automatic rollback until their
  data and launcher guarantees are implemented and verified.
- GitHub Releases is the current fallback release catalog. Every downloaded
  fallback package still passes the release checksum gate before replacement.

### Existing-User Flow

1. After the operator accepts an update and active-run gates pass, the helper
   creates a physical embedded-PostgreSQL checkpoint and records an atomic
   `prepared` transaction with update ID, from/to versions, install paths,
   previous install metadata and checkpoint.
2. With the existing runtime fully stopped, the helper moves the current
   Desktop bundle into a transaction-owned backup. Only after that physical
   snapshot is complete does it persist `backup_ready` and install the
   candidate. For cross-volume moves, `backup_ready` is persisted after copy
   completion and before source deletion, so an interrupted delete restores
   from the complete backup instead of cancelling onto a partial App. If
   the helper exits while still `prepared`, recovery cancels the update when
   the original App remains present, or restores only when the physical backup
   and checkpoint are both complete.
3. Candidate startup runs in probation. Queue recovery, heartbeat/automation
   schedulers, Feishu long connections and automatic backup work remain
   inactive. The candidate loads the real application renderer in a hidden
   window, verifies that the Desktop target and exact Desktop-owned server
   runtime match the selected profile/instance, and waits for a preload IPC
   signal emitted only after the React application mounts.
4. The candidate writes `candidate_ready`. Candidate failure and helper commit
   contend on one exclusive decision lock; commit re-reads the journal and
   failure sidecar while holding that lock and rejects any non-ready or failed
   candidate. The helper then promotes the candidate to last-known-good and
   removes the temporary bundle/checkpoint. Only after commit does Desktop
   activate background work and show the application window.
5. An explicit startup failure or readiness timeout moves the transaction to
   `rollback_pending`. The helper quits the candidate, restores the database
   checkpoint and previous bundle/metadata with same-volume staging and rename
   swaps, launches the restored version and quarantines the failed target. If
   the helper exits after backup, candidate installation/readiness, or between
   restore steps, the next packaged launch finds the uncommitted journal,
   validates the physical App backup and checkpoint `PG_VERSION`, and resumes
   the idempotent rollback before starting Rudder. Missing or incomplete
   snapshots fail closed before the current App is asked to quit.
6. Once the restored version is healthy, it shows a one-time notice:
   `Rudder 已恢复到 vX`. The detail explains that vY failed to start, the
   previous version was reopened, data was preserved, vY is paused, and the
   operator may continue until a later fixed version is available.
7. The notice offers continue, editable Email support, editable public GitHub
   Issue and diagnostic-copy actions. Both feedback drafts contain the same
   bounded failure ID, stage, category, versions and system context.

### Fresh-Install Flow

1. If a packaged first launch fails and the default embedded PostgreSQL data
   directory has not been initialized, Desktop queries the release catalog for
   the nearest eligible previous release below the failed version.
2. Desktop explains the exact recommended version and requires explicit
   confirmation before downloading or replacing the failed package.
3. The CLI downloads and checksum-verifies that release, installs it into the
   current Desktop install root and requires the same candidate readiness
   handshake before accepting it.
4. If initialized instance data exists, Rudder does not present an automatic
   downgrade as safe. Retry and feedback remain available until a compatible
   data recovery path exists.

## Decision Table

| Situation | Expected result | Must not happen |
| --- | --- | --- |
| Candidate reaches exact runtime and hidden-renderer readiness | Commit once, activate background work, then show the app | Treat child exit or process spawn as update success |
| Candidate throws or times out before commit | Restore checkpoint and bundle, launch last-known-good, quarantine target | Expose the half-started candidate for normal work |
| Helper exits while `prepared` and the original App is still present | Cancel the update, release maintenance, remove the checkpoint and reopen the unchanged App | Enter destructive rollback from journal path strings alone |
| Restored version becomes healthy | Show the one-time recovery notice and feedback actions | Reinstall the quarantined target on the next check |
| Fresh install has no initialized embedded DB | Offer one exact previous release and require confirmation | Silently downgrade or walk recursively through releases |
| External DB, missing checkpoint, corrupt backup or second rollback attempt | Stop automatic recovery before quitting the current App and expose bounded diagnostics | Guess that a binary-only downgrade is safe |
| Another process owns the local runtime | Block recovery-capable update until Desktop owns and can stop the instance | Copy a live PostgreSQL data directory |
| A runtime starts while checkpoint/recovery maintenance is active | Allow only the candidate carrying the transaction update ID | Let an ordinary CLI/Desktop runtime mutate the instance during recovery |
| Rollback helper exits between app, database or metadata restore steps | Resume the pending journal on next packaged launch | Start either app version against a partially restored instance |

## Actor-Visible Input

- Existing-user automatic rollback requires no second confirmation after the
  operator accepted the update and all safety gates passed.
- The restored-version notice offers continue, Email support, public GitHub
  Issue and diagnostic copy.
- Fresh fallback names the exact previous version and requires confirmation
  before download and replacement.

## Operator-Visible Output

- Candidate probation remains behind the startup window; the half-started board
  is not available for ordinary work.
- Successful rollback opens the healthy restored board and then shows
  `Rudder 已恢复到 vX` with the failed version, preserved-data statement,
  quarantine status and continue-until-fixed guidance.
- Blocked or failed recovery exposes bounded failure diagnostics instead of
  claiming that a binary-only downgrade is safe.

## Persisted Evidence

- The atomic transaction under `RUDDER_HOME/desktop-updates/transactions/`
  records update identity, versions, phase, install paths, database checkpoint,
  failure metadata, rollback result and one-time notice state.
- Quarantine records the failed target locally so update checks do not offer it
  again; a later release remains eligible.
- Temporary bundle and database checkpoints remain transaction-owned and are
  removed only after commit or safe pre-replacement cancellation.
- The instance maintenance lock identifies the one update transaction allowed
  to start its Desktop-owned candidate runtime. Missing, invalid or mismatched
  update identity fails closed until commit or successful rollback removes it.
  Maintenance admission and ordinary runtime startup coordinate through the
  same per-instance runtime start-lock boundary.
  Commit, successful rollback and safe pre-replacement cancellation are the
  only paths that release maintenance. A failed preparation compensation keeps
  the resumable journal, App backup, database checkpoint and lock together.

## Canonical Scenarios

1. Candidate success: hidden renderer and exact runtime become ready, helper
   commits, background work activates, and the application becomes visible.
2. Existing-user failure: candidate throws, helper restores database and bundle,
   old version opens, and the one-time feedback notice appears.
3. Fresh safe fallback: no embedded DB is initialized, operator confirms the
   named prior release, and the checksummed package completes the same readiness
   handshake.
4. Unsafe downgrade: external or initialized incompatible data prevents an
   automatic downgrade and keeps retry/feedback available.

## Invariants / Non-Goals

- Each update transaction may automatically roll back at most once. Rudder
  never recursively searches older versions.
- The failed target stays quarantined on this computer. A newer release remains
  eligible and supersedes the paused target.
- The previous bundle, checkpoint and install metadata must stay available
  until the candidate commits. Cache pruning protects the current and previous
  checksummed assets and exact runtime versions during the transaction.
- Automatic rollback requires a stopped, verified embedded-PostgreSQL
  checkpoint: a live `postmaster.pid` is rejected, and an instance maintenance
  lock prevents another runtime from starting while checkpoint or restore work
  is in flight. Updates using external PostgreSQL fail closed before the
  current installation is replaced.
- Desktop must own the managed local runtime before a recovery-capable update.
  Attached CLI/browser runtimes must be stopped and reopened under Desktop
  ownership so the PostgreSQL checkpoint cannot be copied live.
- Email and GitHub actions open editable drafts only. GitHub is identified as
  public. No feedback action sends automatically, uploads local files or adds
  raw logs, secrets, prompts, private paths or database contents.
- Recovery dialogs owned only by the failed candidate are insufficient. The
  supervising helper remains outside the candidate lifecycle and owns commit
  or restore.
- Recovery actions remain single-flight and each transaction may attempt
  automatic rollback only once.
- App and database restoration use immutable snapshots, same-volume staging
  and atomic rename swaps. Recoverable `prepared`, `backup_ready`,
  `candidate_installed`, `candidate_ready`, `rollback_pending` and
  `rollback_failed` journals are resumable; a retry preserves the first
  `attemptedAt` value. `prepared` is never treated as proof of a backup: the
  scanner and helper inspect the physical App and checkpoint before choosing
  cancellation or rollback.

## Drift Boundaries

- This contract does not yet promise recovery from OS rejection before the
  packaged executable or recovery helper can run.
- Windows, Linux, external PostgreSQL and recursive multi-version fallback are
  outside the current automatic rollback scope.
- General crash recovery after a committed candidate is not update rollback.
- A fresh install with initialized instance data does not receive automatic
  downgrade until a release-compatibility or data-restore contract exists.

## Traceability

- `cli/src/__tests__/desktop-update-recovery.test.ts` covers atomic journals,
  readiness/failure observation, physical snapshot inspection, checkpoint
  restore and quarantine.
- `desktop/src/desktop-update-recovery.test.ts` covers owned-path validation,
  exact-version and React-mount readiness, decision-lock failure handling,
  helper commit waiting, physical recovery scanning, safe `prepared`
  cancellation and one-time notice copy.
- `server/src/__tests__/desktop-update-maintenance.test.ts` covers the
  fail-closed instance lock and exact candidate update-ID admission.
- `desktop/src/desktop-support-mail.test.ts` covers rollback Email/Issue drafts,
  bounded diagnostics and percent encoding without literal `+` spaces.
- `desktop/src/update-check.test.ts` covers nearest eligible previous-release
  selection rather than semver decrement guessing.
- `desktop/scripts/smoke.mjs --scenario=update-recovery` covers real Electron
  candidate readiness, helper commit gating, restored application startup and
  one-time rollback notice handoff in development and packaged modes. Packaged
  mode also invokes the real `_desktop-update-recover` helper against temporary
  app/database/metadata fixtures and verifies rollback, pre-backup
  cancellation, incomplete-snapshot failure, quarantine and lock release.

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
- Standalone image files in export and import package previews use the shared
  application image overlay with explicit close, copy, and download actions.

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
- Inspecting a package image must preserve the current package selection and
  must not navigate to a Browser target or new window.

Evidence:

- `server/src/__tests__/export-jobs.test.ts` covers export job behavior.
- `tests/e2e/organization-export-build-job.spec.ts` covers visible export job
  flow.
- `tests/e2e/profile-context-import.spec.ts` covers profile/context import
  behavior.
- Shared image preview component tests cover the package preview's reusable
  close and image-action behavior.
- Known gap: every new portable entity type needs explicit manifest/import
  coverage before it is considered safe for export/import.
