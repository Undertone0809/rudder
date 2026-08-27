---
title: Restore layered Desktop updates
date: 2026-08-27
kind: implementation
area: desktop
entities:
  - desktop-update
  - runtime-cache
status: in-progress
---

# Restore Layered Desktop Updates

## Intent

Restore the existing layered Desktop shell update path for manual and silent
automatic updates. Preparing the exact target runtime is best-effort only for
Desktop update children and has one 90-second budget. Failure falls back to the
full portable asset without weakening ordinary `rudder start` failures.

## Implementation

- Add a hidden Desktop-update-only runtime preparation mode with a shared
  monotonic deadline across npm, platform repair, PostgreSQL preparation, and
  lock waits.
- Select shell assets only when the exact runtime and shared PostgreSQL payload
  are ready. Clean only an incomplete target cache after a failed preparation.
- Preserve the selected asset kind through progress events, automatic update
  state, signed-policy authorization, and exact apply.
- Attempt shell staging automatically only when the signed policy authorizes
  both shell and full assets. A full-only policy stays on the full asset path.
- Expose runtime preparation as a visible update phase and document fallback.

## Acceptance

- Exact runtime preparation selects the shell asset; timeout and preparation
  failures select the full portable asset within the bounded update flow.
- Manual and automatic update paths preserve asset kind and reject tampered
  kind, name, checksum, or release digest identities.
- Legacy automatic candidates without an asset kind remain readable as full.
- Focused tests, product logic validation, repository checks, packaged Desktop
  verification, independent review, and black-box acceptance pass for one
  frozen candidate.

## Product Logic Alignment

This restores behavior already covered by `ORG.DESKTOP.UPDATE.001`. No semantic
change to `doc/product/**` is required or authorized.
