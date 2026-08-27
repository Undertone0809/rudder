---
title: Built-in Rudder MCP Semantic Cards
date: 2026-08-25
kind: implementation
status: completed
area: chat
entities:
  - run_transcript
  - messenger_chat
  - rudder_mcp
issue:
related_plans:
  - 2026-07-27-transcript-skill-side-panel.md
supersedes: []
related_code:
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/components/transcript/RunTranscriptView.common.tsx
  - ui/src/pages/Chat.messages.tsx
commit_refs: []
updated_at: 2026-08-27
---

# Built-in Rudder MCP Semantic Cards

## Summary

Replace generic Input and Response disclosures in Nice transcripts with typed,
operator-readable cards for the first 40 built-in Rudder MCP tools. The first
slice covers Goal, Issue, Project, Approval, and Automation through three shared
presenter families: collection rails, entity summaries, and mutation receipts.
Raw transcript evidence, persisted transcript data, MCP schemas, and server
behavior remain unchanged.

## Product Logic Alignment

- Primary contract delta: `RUN.RESULT.001` requires covered built-in Rudder
  tools to use typed Nice presenters derived from structured evidence.
- Goal, Issue, Project, Approval, and Automation domain contracts remain the
  source of truth for object state and mutation outcomes. Presentation must not
  imply a stronger terminal state than the structured response proves.
- Links must be derived from structured identifiers, never reparsed from
  rendered labels. Secret material is excluded from Nice presenters.

## Tool Matrix

| Domain | Rail | Summary | Receipt | Total |
| --- | ---: | ---: | ---: | ---: |
| Goal | 1 | 1 | 4 | 6 |
| Issue | 3 | 3 | 8 | 14 |
| Project | 1 | 1 | 2 | 4 |
| Approval | 1 | 1 | 1 | 3 |
| Automation | 3 | 1 | 9 | 13 |
| Total | 9 | 7 | 24 | 40 |

The exact mapping is maintained in the typed UI presenter registry and covered
by a contract test that requires each of the 40 tools to resolve exactly once.

## Interaction Contract

- Collection results render as one horizontally scrollable row. Mount at most
  six cards initially and append six when the end sentinel approaches the rail
  viewport. Do not issue another MCP or API request.
- Do not show counts, Open-all controls, standalone Open actions, Input,
  Response, or MCP envelopes in covered Nice disclosures.
- A valid target makes the whole card a link with hover, focus-visible,
  keyboard, and touch affordances. A card without a trustworthy destination is
  not styled as interactive.
- Agent owners and authors use the organization Agent directory and the shared
  avatar component. Unresolved identities retain their existing reference and
  use a deterministic fallback avatar.
- Running calls retain the existing progress row. Empty, failed, cancelled,
  malformed, and secret-bearing results use explicit safe states and never
  fabricate a successful object or destination.

## State Inventory

| State | Visible decision or action | Deferred or preserved context |
| --- | --- | --- |
| Running | Inspect current tool progress | Cards wait for structured output |
| Empty or at most six | Inspect available results or empty state | No sentinel or count chrome |
| More than six | Scroll and open a result | Existing cards, order, focus, and scroll anchor remain stable |
| Mutation success | Inspect the actual outcome or open its target | Raw request and response remain in Raw mode |
| Failed or cancelled | Inspect the reason and any trusted target | No success language or phantom target |
| Malformed | See Result unavailable | Raw evidence remains available |
| Collapse and reopen | Continue from the prior rail position | Mounted count and scroll position persist in the component instance |
| Refresh or remount | Start from the first six results | Scroll position resets to zero |
| Nice to Raw to Nice | Inspect diagnostics and return | Nice rail state persists in the component instance |

Back, Cancel, draft restoration, and workflow Reopen are not applicable to this
read-only transcript disclosure. Browser Back follows normal route behavior.

## Verification

- Unit and component fixtures cover all 40 tool registrations, response
  envelopes, semantic mutation outcomes, empty and malformed results, secret
  redaction, Agent fallback, safe links, and 0/5/6/7/12/13-item rails.
- E2E covers the public Chat Process and Run Detail surfaces, horizontal batch
  reveal, deep links, proposal-pending language, Issue block distinctions,
  Automation run status, and trigger-secret redaction.
- Rendered acceptance covers desktop and mobile, light and dark themes, long
  content, hover, focus, keyboard movement, and console/runtime errors.
- Run product-logic checks, focused tests, lint, repository typechecks, full
  tests, build, and the applicable E2E suite before freezing the candidate.
- Require reviewer stage acceptance, verifier PASS on the frozen candidate,
  and final reviewer acceptance before commit and push.
