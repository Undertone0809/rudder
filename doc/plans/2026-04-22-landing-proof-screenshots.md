---
title: Landing proof screenshots
date: 2026-04-22
kind: implementation
status: completed
area: ui
entities:
  - landing_page
  - proof_screenshots
  - messenger_chat
issue:
related_plans:
  - 2026-04-11-messenger-desktop-shell-overhaul.md
  - 2026-04-18-org-heartbeats-workspace.md
supersedes: []
related_code:
  - doc/PRODUCT.md
  - doc/DESIGN.md
  - ui/src/pages/Dashboard.tsx
  - ui/src/pages/Messenger.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/OrganizationHeartbeats.tsx
  - ui/src/pages/Costs.tsx
  - ui/src/pages/OrgChart.tsx
commit_refs:
  - docs: define landing proof shots
updated_at: 2026-04-22
---

# Landing Proof Screenshots

## Summary

Define a landing-page screenshot system that turns shipped Rudder surfaces into
clear proof shots instead of generic product screenshots. The goal is to show
one major product capability per image, keep all images inside one believable
demo organization narrative, and make the chat-to-create-issue flow a first-
class proof moment.

## Problem

The current screenshots are real product surfaces, but they do not yet function
as landing-page evidence:

- they read like development-state app captures instead of intentional proof
  shots
- several visible metrics are zeroed out, which weakens the sense of active
  operations
- the data story is inconsistent across surfaces
- chat currently proves that a conversation exists, but not yet that it can
  cleanly produce a durable issue

Without a shared spec, future landing or README work will keep drifting between
"looks nice" and "proves value."

## Scope

- in scope:
  - define one screenshot brief per major Rudder product function
  - choose a single canonical demo organization and data story
  - specify the chat-to-create-issue screenshot as a core proof shot
  - document capture rules, crop rules, and data-quality rules
  - connect the screenshot spec to the README / homepage draft workflow
- out of scope:
  - implementing a full public landing site in this repo
  - generating final screenshots in this change
  - seeding the app with all required mock data
  - rewriting top-level product positioning docs

## Implementation Plan

1. Write a formal screenshot strategy document under `doc/` that defines:
   - the canonical demo org
   - global screenshot quality rules
   - one detailed brief for each proof shot
2. Cover the main Rudder capabilities with dedicated images:
   - board-level dashboard
   - chat intake and issue creation
   - issue execution loop
   - approval and review control
   - heartbeat / agent operations
   - spend and budget control
   - org structure
3. Add concrete mock content for each image so future capture work can proceed
   without inventing data ad hoc.
4. Update the README / homepage draft so future marketing work explicitly points
   to the screenshot system rather than leaving screenshot selection implicit.

## Design Notes

- Landing screenshots should remain visibly product-real. They should be tighter
  and more intentional than day-to-day app captures, but they should not become
  fake concept art.
- Each screenshot must prove one claim. If a crop tries to show multiple
  unrelated ideas, it will read as noise on a landing page.
- The most upstream problem here is product framing, not polish. The same
  screen can read as weak or strong depending on whether the data story and crop
  make the product claim obvious.
- The chat shot must prove conversion from conversation into durable work, not
  just show a chat thread.

## Success Criteria

- Rudder has a durable internal spec for landing-page proof shots.
- The spec covers the main product functions with one screenshot each.
- The chat-to-create-issue flow is treated as a required screenshot, not an
  afterthought.
- Future marketing or README work can reuse one coherent mock-data story across
  all screenshots.

## Validation

- editorial review against `doc/PRODUCT.md` and `doc/DESIGN.md`
- confirm all proposed screenshots map to shipped Rudder surfaces
- verify the README / homepage draft references the new screenshot system

## Open Issues

- Whether the final landing should use only desktop-shell shots or mix desktop
  and cleaner browser crops is still open.
- Whether a separate "artifacts / outputs" screenshot is needed beyond the
  issue loop depends on the eventual landing layout.
