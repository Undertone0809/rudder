# Settings Overlay Isolation Fix

## What You're Actually Asking
You do not want a new global glassmorphism rule. You want one exception: desktop settings should feel like a frosted layer over the previous Rudder page. Standard dialogs should remain standard dialogs, and the settings entry path must remain reliable.

## Diagnosis
- Primary layer: interaction design
- Secondary layer: visual design
- Why: the implementation treated "settings is contextual" as if "all overlays should feel contextual", which leaks the settings material model into unrelated dialogs and creates inconsistent readability.

## Professional Translation
- Settings is a workspace-scoped overlay, not a new modal system for the app.
- Ordinary dialogs should not reveal live background content strongly enough to read through.
- Blur should be uniform at the backdrop layer, not compounded by multiple translucent content layers.
- The settings entry point must open deterministically from workspace routes without relying on fragile leakage into unrelated modal flows.

## Evaluation Criteria
- Clicking system settings from a workspace opens the settings modal every time.
- Only settings routes preserve the previous workspace as visible background.
- Standard dialogs render with an opaque content surface and do not read as the same glass treatment as settings.
- Background text behind a standard dialog is no longer partially legible.

## Implementation Plan
- Keep the route-backed settings overlay behavior and its targeted E2E coverage.
- Remove contextual glass treatment from the shared dialog primitive so ordinary dialogs stop inheriting the settings look.
- Tighten settings-only backdrop/material values so the background reads as uniformly blurred rather than patchy and text-selective.
- Re-run targeted settings E2E plus a visual smoke capture for both a settings overlay and a standard dialog.
