---
title: Stabilize organization settings interactions
date: 2026-08-12
kind: fix-plan
status: in_progress
area: ui
entities:
  - organization_settings
  - organization_intelligence
  - settings_tabs
issue:
related_plans: []
supersedes: []
related_code:
  - ui/src/pages/OrganizationSettings.tsx
  - ui/src/components/settings/OrganizationIntelligenceProfilesSettings.tsx
  - ui/src/components/ui/tabs.tsx
  - tests/e2e/settings-sidebar.spec.ts
commit_refs: []
updated_at: 2026-08-12
---

# Stabilize Organization Settings Interactions

## Summary

Make organization appearance editing direct, prevent Settings tab transitions from
briefly blanking the page, and reduce idle-state noise in Intelligence settings.
This implements the requested UI fix under `ORG.SETTINGS.001` without editing the
guarded Product Logic Registry.

## State Inventory

- General: editing the organization remains the primary decision. Clicking the
  avatar opens the native file chooser; cancelling leaves the current logo intact;
  choosing a valid image uploads and applies it immediately; pending upload disables
  another selection; upload failure stays visible inline. There is no separate
  choose-file, filename, help-copy, or remove-logo action.
- Chat: selecting the tab updates `?view=chat` once and presents the panel without a
  fade-from-transparent interval. Browser Back and the Settings Close behavior keep
  their existing route semantics.
- Intelligence: Fast and Smart explanations are deferred to hover/focus tooltips.
  Empty runtime-test callouts are omitted, while the Test action, runtime context,
  and actual test results remain available.

## Implementation

- Derive the active Settings view directly from the URL and remove duplicate tab
  navigation handlers.
- Add an opt-out to the shared tab-panel motion API and use it only on Organization
  Settings panels.
- Turn the organization avatar into the upload trigger and simplify appearance copy.
- Move Intelligence profile descriptions into accessible tooltips and hide empty
  test-result placeholders.

## Verification

- Add focused component coverage for tooltip and empty-result behavior.
- Add E2E coverage for the direct avatar flow, stable Chat transition, and
  Intelligence tooltips.
- Inspect the rendered workflow and capture final screenshots before handoff.

## Non-goals

- Fresh-user onboarding and connecting an existing organization.
- A site-wide virtualization or rendering rewrite.
- Semantic edits to `doc/product/**` without explicit authorization.
