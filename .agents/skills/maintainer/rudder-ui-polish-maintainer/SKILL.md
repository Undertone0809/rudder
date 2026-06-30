---
name: rudder-ui-polish-maintainer
description: "Use when implementing screenshot-driven or narrow Rudder UI polish: density, alignment, spacing, labels, cards, menus, hover states, empty states, onboarding steps, redundant pages, compact workflows, screenshots, or small visible interaction fixes."
---

# Rudder UI Polish Maintainer

## Overview

Turn concrete Rudder UI feedback into a scoped, implemented, visually verified, and committed change.

## When to Use

Use this skill when:

- the user points at a Rudder screen or screenshot and asks for polish
- density, spacing, alignment, labels, badges, icons, menus, hover, empty states, onboarding, or small workflow UI is wrong
- the user asks for a screenshot after a local UI change
- the likely answer is CSS/layout/data layering for a visible surface

Do not use this skill when:

- pure advice with no implementation request; use build-advisor
- high-stakes proposal plus reviewer gates; use advisor-review-loop-maintainer
- missing-data root cause; use data-path diagnostician
- broad redesign not anchored to a visible Rudder surface

## Core Pattern

```text
intent -> evidence packet -> smallest UI change -> contract alignment -> browser/screenshot proof -> scoped commit
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Screenshot supplied | Match the visible issue and viewport |
| User says “先说说” | Clarify direction before edits |
| Visible function changes | Update E2E/contract as needed |
| Layout-sensitive change | Verify rendered result |

## Implementation

1. Resolve whether the user wants discussion or implementation.
2. Build a small evidence packet from screenshot, route, component, and product contract.
3. Make the smallest coherent UI change consistent with Rudder design rules.
4. Keep routes/nav/API contracts aligned for visible behavior.
5. Validate in browser or screenshot and run focused tests.
6. Commit only this task.

Reference files are part of this skill contract. Before substantive execution or final judgment, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

Use `evals/` when the route needs that detail; keep the entrypoint thin.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Turning polish into a redesign | Stay scoped to the noticed problem. |
| Relying on typecheck for layout | Inspect rendered UI. |
| Ignoring product contracts for visible workflow changes | Sync behavior and tests. |
| Staging unrelated dirty files | Commit only UI task files. |
