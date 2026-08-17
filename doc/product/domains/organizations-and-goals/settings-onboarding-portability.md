---
title: Settings Onboarding And Portability
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids:
  - ORG.IDENTITY.001
  - ORG.SETTINGS.001
  - ORG.ONBOARDING.001
  - ORG.LOCAL.ACCOUNT.UPGRADE.001
  - ORG.DESKTOP.UPDATE.001
  - ORG.DESKTOP.RELEASE.NOTES.001
  - ORG.PORTABILITY.001
related_code:
  - packages/db/src/schema/organization_issue_prefix_aliases.ts
  - packages/db/src/schema/organizations.ts
  - packages/shared/src/organization-issue-key.ts
  - desktop/src/browser-ipc.ts
  - desktop/src/browser-profile.ts
  - desktop/src/desktop-quit-flow.ts
  - desktop/src/desktop-update-flow.ts
  - desktop/src/identity-local-session.ts
  - desktop/src/main.ts
  - desktop/src/post-update-reload.ts
  - desktop/src/release-notes.ts
  - packages/db/src/schema/instance_settings.ts
  - packages/db/src/schema/operator_profiles.ts
  - packages/db/src/schema/organization_intelligence_profiles.ts
  - server/src/routes/instance-settings.ts
  - server/src/routes/onboarding.ts
  - server/src/services/instance-settings.ts
  - server/src/services/legacy-operator-state.ts
  - server/src/services/local-account-auth.ts
  - server/src/services/orgs.ts
  - server/src/services/operator-profile.ts
  - server/src/services/organization-intelligence-profiles.ts
  - server/src/services/knowledge-portability/organization-portability.export.ts
  - server/src/services/knowledge-portability/organization-portability.import.ts
  - server/src/services/export-jobs.ts
  - ui/index.html
  - ui/src/App.tsx
  - ui/src/lib/organization-routes.ts
  - ui/src/lib/organization-page-memory.ts
  - ui/src/lib/messenger-preferences.ts
  - ui/src/hooks/useOrganizationPageMemory.ts
  - ui/src/components/Layout.tsx
  - ui/src/components/MobileBottomNav.tsx
  - ui/src/components/OnboardingWizard.tsx
  - ui/src/components/IssuesList.tsx
  - ui/src/components/PageTabBar.tsx
  - ui/src/components/SettingsSidebar.tsx
  - ui/src/components/settings/SettingsPageSkeleton.tsx
  - ui/src/components/settings/SettingsScaffold.tsx
  - ui/src/context/ThemeContext.tsx
  - ui/src/components/transcript/RunTranscriptView.blocks.tsx
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/pages/InstanceAboutSettings.tsx
  - ui/src/pages/InstanceAppearanceSettings.tsx
  - ui/src/pages/InstanceBrowserSettings.tsx
  - ui/src/pages/InstanceGeneralSettings.tsx
  - ui/src/pages/InstanceNotificationsSettings.tsx
  - ui/src/pages/InstanceAccountSettings.tsx
  - ui/src/pages/InstanceProfileSettings.tsx
  - ui/src/pages/InstanceSettings.tsx
  - ui/src/pages/InstanceShortcutsSettings.tsx
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/pages/OrganizationExport.tsx
  - ui/src/pages/OrganizationImport.tsx
  - ui/src/components/ImagePreviewDialog.tsx
  - ui/src/components/InspectableImage.tsx
  - ui/src/context/ImagePreviewContext.tsx
  - ui/src/pages/InviteLanding.tsx
  - ui/src/pages/NotFound.tsx
  - ui/src/components/DesktopReleaseNotesDialog.tsx
  - ui/src/components/DesktopUpdatePromptBridge.tsx
  - ui/src/components/DesktopUpdateStatusCard.tsx
related_tests:
  - desktop/src/browser-ipc.test.ts
  - desktop/src/browser-profile.test.ts
  - desktop/src/desktop-quit-flow.test.ts
  - desktop/src/desktop-update-flow.test.ts
  - desktop/src/identity-local-session.test.ts
  - desktop/src/release-notes.test.ts
  - desktop/src/post-update-reload.test.ts
  - server/src/__tests__/instance-settings-service.test.ts
  - server/src/__tests__/instance-settings-routes.test.ts
  - server/src/__tests__/local-account-auth.test.ts
  - server/src/__tests__/operator-profile-service.test.ts
  - server/src/__tests__/orgs-service.test.ts
  - server/src/__tests__/organization-intelligence-profiles.test.ts
  - server/src/__tests__/organization-intelligence-profiles-routes.test.ts
  - server/src/__tests__/export-jobs.test.ts
  - ui/src/components/OnboardingWizard.runtime-config.test.tsx
  - ui/src/components/IssuesList.test.tsx
  - ui/src/components/ImagePreviewDialog.test.tsx
  - ui/src/context/ImagePreviewContext.test.tsx
  - ui/src/components/SettingsSidebar.browser.test.tsx
  - ui/src/components/settings/SettingsScaffold.test.tsx
  - ui/src/context/ThemeContext.test.tsx
  - ui/src/components/transcript/RunTranscriptView.test.tsx
  - ui/src/components/transcript/RunTranscriptView.failure-indicators.test.tsx
  - ui/src/hooks/useOrganizationPageMemory.test.ts
  - ui/src/lib/organization-routes.test.ts
  - ui/src/pages/InstanceAboutSettings.test.tsx
  - ui/src/pages/InstanceAppearanceSettings.test.tsx
  - ui/src/pages/InstanceBrowserSettings.test.tsx
  - ui/src/pages/InstanceGeneralSettings.test.tsx
  - ui/src/pages/InstanceNotificationsSettings.test.tsx
  - ui/src/pages/InstanceAccountSettings.test.tsx
  - ui/src/pages/InstanceProfileSettings.test.tsx
  - ui/src/pages/InstanceSettings.test.tsx
  - ui/src/pages/InstanceShortcutsSettings.test.tsx
  - ui/src/components/DesktopReleaseNotesDialog.test.tsx
  - ui/src/components/DesktopUpdatePromptBridge.test.tsx
  - ui/src/components/DesktopUpdateStatusCard.test.tsx
  - tests/e2e/desktop-update-prompt.spec.ts
  - tests/e2e/local-account-upgrade.spec.ts
  - tests/e2e/onboarding.spec.ts
  - tests/e2e/organization-issue-key.spec.ts
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
- `organization.issuePrefix` is the Issue Key used to form readable issue
  identifiers. It is a system-maintained implementation detail: the server
  derives and allocates it from the organization name, while onboarding and
  organization settings do not expose it as operator configuration.
- Across different organizations, canonical `urlKey` values, current Issue
  Keys, and historical Issue Keys share one case-insensitive route namespace.
  A value owned by one organization cannot be allocated to another organization
  in any of those roles.

Flow:

1. The operator enters an organization name during onboarding.
2. Server derives an Issue Key that preserves letters and digits. If an
   automatically derived key conflicts, the server appends a numeric suffix
   without interrupting onboarding or exposing the key decision to the user.
3. An Issue Key submitted explicitly through compatibility API or portability
   flows is validated and rejects a current or historical conflict with an
   actionable error. Explicit key changes must not silently append characters.
4. Server allocates an independent stable `urlKey`; URL-key collisions may use
   a numeric URL suffix without changing the submitted Issue Key.
5. Organization navigation generates `/{urlKey}/...`. Current Issue Key and
   historical Issue Key routes remain accepted during compatibility migration.
6. An explicit compatibility API or portability change migrates the Issue Key
   and current issue identifiers transactionally while preserving the previous
   key as an alias.

Invariants:

- Renaming an organization must not change `urlKey` or Issue Key implicitly.
- Conflicts for an explicitly submitted Issue Key must be visible to the
  operator and require an explicit alternative; silent suffixing is prohibited
  for explicit key changes.
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
- Organization General settings expose the organization display name and
  appearance controls. They do not expose the system-maintained Issue Key or
  the optional organization description as operator configuration.
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
- Personal settings use `Profile & account` as the canonical destination at
  `/instance/settings/profile`. It combines operator profile editing with
  Rudder Account security, provider, session, and device controls. The legacy
  `/instance/settings/account` route remains a compatibility entry point and
  redirects to the canonical Profile & account destination while preserving
  query, hash, and navigation state.
- The Settings shell owns grouped navigation, access and deployment gating,
  active-destination state, responsive composition, and close/return behavior.
  Each destination page owns its settings state, validation, persistence,
  domain actions, and success or failure feedback.
- The shell exposes only destinations authorized for the current operator and
  supported by the deployment. Instance administration destinations require
  instance-admin access, Browser is available only in `local_trusted`, and
  organization destinations remain organization-scoped.
- Appearance exposes five independent controls:
  - color mode: `light`, `system`, `dark`
  - design style: `default`, `mira`, `luma`
  - base color: `neutral`, `stone`, `zinc`, `mauve`, `olive`, `mist`, `taupe`
  - theme color: `neutral`, `amber`, `blue`, `cyan`, `emerald`, `fuchsia`,
    `green`, `indigo`, `lime`, `orange`, `pink`
  - tool call failure indicators: boolean, presented as Show failure indicators
- The default presentation for a browser or local shell without valid saved
  preferences is color mode `system`, design style `luma`, base color
  `neutral`, theme color `emerald`, and tool call failure indicators off.
- Appearance presentation names do not replace their stable values. Design
  style `luma` is presented as Rudder, `default` as Classic, and `mira` as
  Compact. Theme color `emerald` is presented as Rudder.

Flow:

1. Operator opens Settings from shell or organization routes.
2. The shell resolves the current route, operator access, and deployment
   capabilities, builds the scope-first navigation, and visibly identifies the
   active destination.
3. Profile & account opens the canonical profile route and renders both
   operator profile and Rudder Account sections. A legacy account route is
   normalized to that same destination before the page renders.
4. A contextual overlay preserves the prior work surface while making that
   background inert and unavailable to assistive technology. Focus enters the
   Settings dialog, cycles within it, and returns to the opening control when
   Settings closes. The full-page fallback exposes the same authorized routes
   and destination ownership.
5. On narrow viewports, opening Settings navigation presents it as an
   independent modal layer, moves focus into that layer, and makes destination
   content non-interactive until navigation is dismissed. Selecting a
   destination closes the layer; dismissing it returns focus to its trigger.
6. UI loads current instance/operator/org configuration for the selected page.
7. Service-backed pages save through the owning settings service and invalidate
   relevant UI caches.
8. Browser settings control the instance capability and default web-link
   destination. Import and clear actions execute through the trusted Desktop
   boundary and disclose that their effect is shared across organizations.
9. Appearance choices apply immediately and persist to local storage. Color,
   style, and theme choices set root DOM attributes and the resolved browser
   theme color before React finishes loading. Tool call failure indicators
   update mounted transcripts immediately and are restored for later views.
10. Affected workflows read settings through their own domain service; workflow
   behavior must not depend on presentation-only appearance values.

Invariants:

- Settings must not silently cross organization or user boundaries.
- Settings navigation must keep personal, instance/Desktop, runtime,
  integration, and organization scopes visibly distinct. Viewing another
  organization's settings must not implicitly switch the operator's active
  organization.
- `Profile & account` is the single canonical Personal destination. The legacy
  account route must converge on `/instance/settings/profile` without dropping
  query, hash, or navigation state.
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
  design style, base color, theme color, or tool call failure indicator setting
  must not change any durable work object, organization setting, runtime config,
  agent instruction, transcript result, or review outcome.
- When tool call failure indicators are off, failed tool calls use the same
  neutral presentation as ordinary tool calls and omit failure-specific labels,
  red styling, and automatic error expansion. Their input, response, and stored
  failure status remain inspectable. Turning indicators on restores the
  failure-specific presentation without changing the underlying transcript.
- Stored appearance values outside the supported option sets must fall back to
  the default presentation instead of leaving the app in an undefined style.
- Valid stored appearance values must remain selected across upgrades and must
  not be overwritten when the default presentation changes.
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
- `ui/src/components/transcript/RunTranscriptView.test.tsx` covers neutral
  default rendering and the opt-in failure presentation for tool calls.
- `ui/src/pages/InstanceAppearanceSettings.test.tsx` covers the visible
  Appearance settings choices.
- `server/src/__tests__/instance-settings-service.test.ts`,
  `server/src/__tests__/instance-settings-routes.test.ts`, and
  `ui/src/pages/InstanceBrowserSettings.test.tsx` cover Browser defaults,
  persistence, supported values, and visible instance-wide controls.
- `desktop/src/browser-ipc.test.ts` and `desktop/src/browser-profile.test.ts`
  cover trusted clear/disable handling and preservation of Browser settings.
- `tests/e2e/settings-appearance.spec.ts` covers the user-visible Appearance
  workflow, including persistence for expanded base and theme color options
  plus default-off and opt-in failed tool call presentation.
- `tests/e2e/organization-issue-key.spec.ts` covers the absence of Issue Key and
  description controls from organization settings while preserving
  compatibility API migration and historical-link behavior.
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
- `InstanceProfileSettings` composes the account sections owned by
  `InstanceAccountSettings`; the Settings E2E proves the merged destination and
  legacy account-route redirect.
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
- New-organization onboarding asks only for the organization display name. It
  does not ask the user to choose an Issue Key or define a mission/goal; the
  server allocates internal organization identity, while goals remain available
  from the normal work surfaces when the user is ready to add them.
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
- A new full seed creates a `Getting Started` project with one completed Welcome
  reference plus two high-priority Todo guide issues: run one real task, then
  review the result and close the loop. The experienced-user seed creates only
  the Welcome reference. No advanced tutorial backlog is seeded.
- The seeded completion standard is a real task followed by an inspectable
  result or progress update and a recorded human decision: accept, request a
  specific revision, or create a clear follow-up.
- Guide completion is manual. The guide issue statuses do not automatically
  synchronize with the status of the real Chat or Issue where work happened.
- Seeded issue descriptions use existing organization routes for a prefilled
  Chat with the first agent and Getting Started project, a project-filtered
  Issues page, the next guide issue, and Messenger.
- Seeded guidance presents Chat and issues as parallel task workflows: Chat is
  conversation-driven, while issues add structured tracking. It must not teach
  that real or durable work requires conversion from Chat into an issue.
- Invite landing surfaces can show onboarding skill/text instruction links for
  external agents.

Flow:

1. Fresh user or invited actor enters onboarding/invite route.
2. Server exposes safe onboarding metadata and required setup state.
3. UI collects the organization name, then guides agent/runtime setup without
   exposing Issue Key or mission/goal fields.
4. When the selected local runtime requires a runtime environment check,
   onboarding tests that agent runtime before creating the first agent.
5. If the first agent is Codex local, server derives Fast and Smart
   organization intelligence profiles from the tested Codex runtime config,
   runs the same runtime-chain environment checks used by manual profile
   enablement, persists passing profiles as `configured` with verification
   evidence, and leaves failing profiles disabled/invalid with visible error
   state instead of silently enabling them.
6. Server seeds starter work when needed, including the `Getting Started`
   project, Welcome plus two guide issues for a full seed, existing-route CTAs,
   Messenger grouping, and read-state markers required for the starter set.
7. User lands in the organization's Messenger home with starter work or clear
   next action.

Invariants:

- Onboarding should end in a real Rudder work surface, not a detached marketing
  page.
- Onboarding organization creation must submit only the display name and must
  not require users to understand Issue Keys or define a mission/goal.
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
- Onboarding seed must be idempotent for a new, empty, or v2 `Getting Started`
  project: repeated seed calls reuse matching starter issue IDs, expanding a
  Welcome-only seed adds only the two action guides, and later Welcome-only
  calls delete nothing.
- The original twelve seeded titles form a legacy-title set. If any legacy
  title exists in an active `Getting Started` project, reseeding must return its
  current project and issues with HTTP 200 before mutating project metadata,
  issue content or fields, issue ordering, Messenger grouping, follows, or read
  state.
- A non-empty pre-existing `Getting Started` project containing neither a
  legacy title nor a v2 title is frozen by the same rule. Existing-organization
  agent onboarding must not mutate or seed that project.
- Any `Getting Started` project containing a hidden issue is also frozen so a
  reseed cannot recreate, reveal, or otherwise rewrite intentionally hidden
  legacy, unrelated, or v2 content.
- Manual completion of either v2 action guide must persist across reloads and
  must not be inferred from or overwritten by the real work item's state.
- Auth/deployment mode constraints remain respected.

Evidence:

- `tests/e2e/onboarding.spec.ts` covers the onboarding UI path, including
  the name-only organization payload, absence of Issue Key and mission/goal
  fields, post-onboarding Messenger landing, and root startup redirect to
  Messenger.
- `tests/e2e/onboarding.spec.ts` covers the three-issue Getting Started seed,
  guide statuses and priorities, Chat and Issues route context, manual guide
  completion, Messenger order/read state, v2 idempotency, and immutable legacy
  or unrelated pre-existing projects.
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

## ORG.LOCAL.ACCOUNT.UPGRADE.001

### Contract Summary

Claiming an existing trusted local Rudder installation into a Rudder Account
must preserve the operator's scoped work state across the identity change from
the legacy `local-board` principal to the account user UUID. Recovery runs for
online and offline Desktop sessions, is safe to repeat, and retains the legacy
source records so an automatic version rollback can still read them.

### Intent / User Job

- An operator can install a new Desktop or Canary version, sign in or resume
  offline, and continue from the same Messenger attention state, groups, Saved
  Views, ordering, issue state, and profile instead of receiving a seemingly
  fresh account.
- A repaired installation can run the same claim again without duplicating
  state or undoing newer account-era changes.
- If the new build rolls back, the older build can still use the legacy state
  that existed before the account claim.

### Why / Design Reasoning

- Operator-scoped records use the authenticated user id. Changing the local
  principal without an explicit compatibility boundary makes durable data
  appear deleted even though it remains in the same database.
- Recomputing unread state from content is not recovery: it can turn years of
  acknowledged messages into `99+` attention and cannot reconstruct manual
  groups, Saved View placement, or device-local ordering.
- Moving or deleting the legacy rows would make rollback unsafe. A
  copy-and-reconcile migration is therefore preferred over destructive
  ownership transfer.
- Account-era edits may already exist when a Canary is repaired. Recovery must
  merge monotonically or choose the newest authoritative state instead of
  blindly replacing the target namespace.

### Actors / Objects / State

- The Desktop shell establishes either an online server-exchange session or a
  valid offline-grant session, then invokes the authenticated local-installation
  claim.
- The legacy principal is `local-board`; older browser-only preference keys may
  also use `anonymous`. The target principal is the authenticated account user
  UUID bound to the installation.
- Server-owned recovery includes active organization membership scope,
  Messenger custom groups and entries, Saved Views and mutation receipts,
  Messenger and Chat read/pin state, issue read state and follows, and the
  operator profile.
- Device-local recovery includes project order, Messenger project-group order,
  Agent/Kind thread-group order, default thread order, and hidden-issue
  watermarks stored under a user-specific local preference key.
- `installation.legacy_operator_state_copied` activity records are durable
  receipts for organization-scoped server recovery.

### Entry Points / Inputs

- First account claim for an installation that still has active
  `local-board` organization memberships.
- A repeated claim for an already-bound installation, including a repair after
  a partially compatible Canary already changed membership ownership.
- Desktop online session establishment and Desktop offline-grant session
  establishment.
- First rendered Messenger preference read under the authenticated account user
  UUID.

### Product Logic Flow

1. Desktop authenticates the local account session online or offline and then
   calls the local installation claim before treating identity setup as
   complete.
2. The server verifies that the installation binding and authenticated external
   identity resolve to the same local account user. A different account cannot
   claim or repair the installation.
3. In one claim transaction, Rudder scopes recovery to organizations where the
   legacy or target user has an active membership. First claim transfers the
   active organization and instance role boundary to the account user; an
   already-claimed installation still runs reconciliation.
4. Rudder copies missing legacy groups, entries, Saved Views, mutation receipts,
   follows, read state, pin state, and profile fields into the target namespace.
   Stable deterministic ids and conflict-aware mapping make the operation
   repeatable.
5. Read progress takes the greatest known read timestamp. A pin/unpin conflict
   takes the value with the newest update timestamp. Existing target Saved View
   identity and actual target placement win over a stale legacy receipt.
   Existing non-empty target profile fields and preference keys are preserved.
6. The browser preference layer copies each supported, valid legacy
   `local-board` or `anonymous` key only when the account-specific destination
   key is absent. Invalid JSON is ignored and unavailable storage does not
   invalidate successful server recovery.
7. Rudder retains all legacy source rows and keys. Repeating the claim
   reconciles any missing compatible state and emits at most one recovery
   receipt per installation, organization, and target user.
8. Messenger renders from the recovered target namespace, so acknowledged work,
   custom grouping, Saved View placement, and manual order survive reload.

### Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| First claim | Active legacy organization belongs to `local-board` and installation is unclaimed | Bind the account and copy scoped operator state transactionally | Present a clean Messenger or delete legacy state | Auth service tests and upgrade E2E |
| Already claimed repair | Installation already belongs to the same account but legacy state remains | Reconcile the same compatibility copy again, idempotently | Return early before repair or duplicate groups/Saved Views | Auth service tests |
| Read-state conflict | Legacy and target both have read markers | Keep the greatest read progress | Reset to an older marker and create false unread debt | Auth service tests and upgrade E2E |
| Pin-state conflict | Legacy and target pin values differ | Keep the value from the newest state update | Re-pin something the account later unpinned | Auth service tests |
| Saved View identity conflict | Target already has the same mutation, instance, or resource | Reuse target identity and record its actual placement | Duplicate the Saved View or restore a stale legacy group receipt | Auth service tests |
| Local preference conflict | Valid target key already exists | Preserve target value | Overwrite account-era ordering with legacy order | Messenger preference tests |
| Invalid or unavailable local storage | Legacy value is invalid JSON or storage rejects access | Skip that device-local key; retain server recovery | Crash Messenger or discard server-owned state | Messenger preference tests |
| Different account | Installation binding or external identity does not match | Reject the claim without changing ownership or operator state | Copy one operator's state into another account | Auth service tests |
| Automatic rollback | A newer claim completed and an older build starts | Legacy source rows and keys remain available | Require a destructive reverse migration | Auth service and preference tests |

### Actor-Visible Input

- The operator supplies normal online sign-in or an already-issued offline
  credential; there is no separate manual data-migration workflow.
- Messenger continues to expose the same organization and normal thread/group
  controls after the account session is established.

### Operator-Visible Output

- The Messenger badge reflects genuinely unread work rather than every
  historical message.
- Existing Custom Groups, grouped members, Saved Views, loose/group placement,
  pin state, ordering, hidden issue watermarks, follows, and operator profile
  remain available after update and reload.
- A claim failure is surfaced as an identity/setup failure. Rudder must not
  silently continue into a new-looking empty state and imply that recovery
  succeeded.

### Persisted Evidence

- Target-user rows preserve recovered operator state in their owning tables.
- The original `local-board` rows and legacy local preference keys remain
  intact for downgrade compatibility.
- One `installation.legacy_operator_state_copied` activity receipt per scoped
  organization records the installation, target actor, prior principal, and
  copy-preserving compatibility mode.

### Canonical Scenarios

1. Upgrade a long-lived local Messenger:
   - Trigger: Claim an already-used installation with 105 historical Chat
     messages acknowledged and one genuinely unread Chat.
   - Expected state/action: Copy the legacy read marker and directory state to
     the account user.
   - Visible output: Messenger shows one unread item, the original group, and
     its Saved View before and after reload.
   - Evidence: `tests/e2e/local-account-upgrade.spec.ts`.
2. Repair an already-claimed Canary:
   - Trigger: Reopen an installation whose membership was already moved but
     whose legacy operator rows were not copied.
   - Expected state/action: The repeated claim reconciles missing state and
     leaves a single receipt and stable target records.
   - Visible output: Restored Messenger state without duplicate groups or
     Saved Views.
   - Evidence: `server/src/__tests__/local-account-auth.test.ts`.
3. Preserve newer account edits:
   - Trigger: Target read/pin/profile/Saved View or local ordering state
     conflicts with legacy state.
   - Expected state/action: Use monotonic read progress, newest pin state,
     target placement, and existing target preference values.
   - Visible output: Recovery does not undo the operator's newer organization.
   - Evidence: auth service and Messenger preference tests.
4. Resume offline:
   - Trigger: Desktop creates a valid local session from an offline grant.
   - Expected state/action: Desktop still invokes the same local claim before
     completing session setup.
   - Visible output: Offline startup uses the recovered account namespace.
   - Evidence: `desktop/src/identity-local-session.test.ts`.

### Invariants / Non-Goals

- Recovery is scoped to active memberships for the legacy or target user and
  must never cross organization or account boundaries.
- First claim and already-claimed repair use the same reconciliation behavior.
  Online and offline Desktop session paths both invoke it.
- Recovery must be idempotent, source-preserving, and conflict-aware.
- Read progress cannot move backward. A newer unpin must not be overwritten by
  an older legacy pin.
- Existing target Saved View identity and actual target placement must not be
  replaced by a stale legacy mutation receipt.
- Valid account-specific local preferences must not be overwritten. Invalid
  legacy preference payloads must not be copied.
- This contract does not promise cross-device synchronization for
  local-storage ordering or hidden-watermark preferences; it preserves them on
  the upgraded local profile.
- This contract does not authorize one Rudder Account to adopt another
  account's installation or data.

### Drift Boundaries

- Changing the local principal namespace, claim ordering, recovered table set,
  conflict rules, rollback retention, online/offline parity, activity receipt,
  or device-local preference set requires updating this contract.
- Deterministic-id hashing, batching, internal helper boundaries, and exact
  response shapes may change without a contract update when the visible and
  persisted compatibility behavior remains equivalent.

### Traceability

Related code:

- `desktop/src/identity-local-session.ts`
- `server/src/services/local-account-auth.ts`
- `server/src/services/legacy-operator-state.ts`
- `ui/src/lib/messenger-preferences.ts`

Related tests:

- `desktop/src/identity-local-session.test.ts`
- `server/src/__tests__/local-account-auth.test.ts`
- `ui/src/lib/messenger-preferences.test.ts`
- `tests/e2e/local-account-upgrade.spec.ts`
- `tests/e2e/messenger-contract.spec.ts`

Related contracts:

- `MESSENGER.ATTENTION.001`
- `MESSENGER.CUSTOM.GROUPS.001`
- `MESSENGER.SAVED.VIEWS.001`

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

- Organization export/import moves the supported agent-team configuration and
  work records between instances without becoming an unsafe database dump.

Product model:

- Export builds a portable file bundle plus `.rudder.yaml` manifest.
- The current portable entity set is organization settings, agents, projects
  and their workspace definitions, issues (including Automation definitions),
  and skills.
- Goals, Library files, organization resources, and project resource
  attachments are not currently portable. Imported issues are not linked to a
  source Goal.
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
