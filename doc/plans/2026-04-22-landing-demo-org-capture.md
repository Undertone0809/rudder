---
title: Landing demo org and proof-shot capture
date: 2026-04-22
kind: implementation
status: in_progress
area: ui
entities:
  - landing_page
  - proof_screenshots
  - messenger_chat
issue:
related_plans:
  - 2026-04-22-landing-proof-screenshots.md
supersedes: []
related_code:
  - scripts/capture-landing-proof-shots.ts
  - doc/LANDING-PROOF-SHOTS.md
  - package.json
commit_refs: []
updated_at: 2026-04-22
---

# Landing Demo Org And Proof-Shot Capture

## Summary

Create a reproducible capture workflow that boots an isolated Rudder instance,
seeds one coherent demo organization with landing-quality mock data, and emits
the proof-shot screenshots needed for the marketing and README surfaces.

## Problem

The screenshot spec now exists, but we still need a way to turn it into actual
images without manually rebuilding data every time. Manual screenshot setup
will drift quickly because:

- the demo data spans multiple product surfaces
- the chat proof shot depends on a controlled issue-proposal flow
- dashboard, costs, heartbeats, approvals, and org chart all need the same
  underlying org story
- the Codex desktop runtime in this environment cannot safely load native
  Rollup add-ons, so screenshot capture must explicitly route child processes
  through the non-hardened Homebrew Node toolchain

## Scope

- in scope:
  - boot an isolated local_trusted Rudder server for capture work
  - seed one demo org with agents, issues, chat, approvals, cost, finance, and
    heartbeat data
  - generate the chat-to-create-issue flow with a deterministic stub runtime
  - capture the landing proof shots to a temp output directory
  - document or encode the environment workaround needed for capture
- out of scope:
  - redesigning the product UI for landing-specific variants
  - adding final marketing copy to the product
  - packaging desktop-shell screenshots in this change

## Implementation Plan

1. Add a scripted capture workflow under `scripts/` that:
   - writes an isolated Rudder config
   - starts the server with the Homebrew Node toolchain on PATH
   - waits for health
2. Seed a canonical `Rudder` organization with one believable launch-week
   narrative across:
   - org structure
   - issues and outputs
   - approvals
   - heartbeat runs
   - costs and finance events
3. Drive the chat proof flow through the real UI using Playwright so the
   create-issue screenshot matches shipped behavior.
4. Capture the proof shots defined in `doc/LANDING-PROOF-SHOTS.md`.

## Design Notes

- The seed data should optimize for coherence, not maximum realism in every
  field. The screenshots need one believable week of work, not a full fake
  enterprise dataset.
- The environment workaround is part of the implementation. Running child
  processes under the hardened Codex app Node breaks native Rollup loading, so
  the capture workflow must explicitly prepend `/opt/homebrew/bin` to PATH for
  the server and Playwright-facing child processes.
- Outputs should land outside the repo tree.

## Success Criteria

- One command produces the demo org and all landing proof shots.
- The chat screenshot shows the issue proposal review block and the created
  issue state.
- The resulting screenshots map cleanly to the proof-shot spec.

## Validation

- run the capture script end to end
- verify the screenshot files are written
- visually inspect the resulting images before hand-off

## Open Issues

- Whether we want a second capture mode for desktop-shell-only marketing shots
  remains open.
