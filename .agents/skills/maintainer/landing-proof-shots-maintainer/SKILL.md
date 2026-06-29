---
name: landing-proof-shots-maintainer
description: "Use when maintaining Rudder landing-page/demo screenshot workflows: seeding screenshot-ready demo orgs, capturing polished full-page app screenshots, producing screenshot manifests, or handing a seeded environment to the user for self-capture."
---

# Landing Proof Shots Maintainer

## Overview

Create or maintain screenshot-ready Rudder demo states and whole-app captures for landing pages, docs, and decks.

## When to Use

Use this skill when:

- the user wants polished app screenshots for marketing, docs, or demos
- the user wants a seeded demo org for self-capture
- screenshots need realistic Rudder workflow data
- the request mentions landing shots, demo screenshots, or full-page app captures

Do not use this skill when:

- ad hoc debugging screenshots where realism does not matter
- mock data generation without screenshot workflow; use mock-data-maintainer
- browser-window photos or cropped partial captures when full app proof is required

## Core Pattern

```text
surface list -> landing demo seed -> environment proof -> full-page capture -> manifest -> handoff
```

## Quick Reference

| Situation | Action |
| --- | --- |
| Capture mode | Seed and take screenshots |
| Seed-only mode | Seed and hand off URL plus ledger |
| Need realistic data | Coordinate with mock-data-maintainer |
| Capture looks browser-like | Use app-style full-page capture |

## Implementation

1. Choose capture mode or seed-only mode.
2. Define screenshot surfaces and required states.
3. Seed an isolated demo org with landing-quality data.
4. Verify health and route readiness before capture.
5. Capture full-page app screenshots and generate a manifest.
6. Hand off paths, URLs, seed ledger, and cleanup notes.

Reference files are part of this skill contract. Before executing high-risk actions or final judgments, load `references/runbook.md` for the detailed legacy workflow, examples, validation cases, and command-level guidance.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Using a tiny fallback dataset | Use the landing-quality dataset. |
| Capturing a browser window instead of app surface | Capture the whole app page. |
| Skipping environment verification | Check health and target org first. |
| Leaving state unexplained | Write a manifest and seed ledger. |
