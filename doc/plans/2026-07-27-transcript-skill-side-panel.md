---
title: Transcript Skill Read-Only Side Panel
date: 2026-07-27
kind: implementation
status: completed
area: chat
entities:
  - messenger_chat
  - side_panel
  - organization_skills
  - run_transcript
issue:
related_plans:
  - 2026-06-30-chat-side-panel.md
  - 2026-07-11-chat-transcript-local-file-preview.md
  - 2026-07-21-chat-local-file-side-panel.md
supersedes: []
related_code:
  - ui/src/components/transcript/RunTranscriptView.chat.tsx
  - ui/src/lib/side-panel-targets.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/Chat.tsx
commit_refs: []
updated_at: 2026-07-27
---

# Transcript Skill Read-Only Side Panel

## Summary

Make a concrete `Use <skill> skill` activity in Messenger clickable and open
the corresponding `SKILL.md` beside the conversation. Prefer the organization
Skill Library copy when the transcript identity resolves uniquely, otherwise
use an exact trusted local path through the existing Desktop preview boundary.
The Side Panel remains read-only and does not turn transcript inspection into a
skill mutation surface.

## Product Logic Alignment

- Affected contracts: `RUN.RESULT.001`, aligned with `AGENT.SKILLS.001`.
- `RUN.RESULT.001` gains the visible interaction rule that a skill-use action
  preserves structured skill targets and may open a uniquely resolved,
  read-only `SKILL.md`.
- `AGENT.SKILLS.001` ownership, enablement, installation, and editability rules
  remain unchanged.

## Implementation Plan

1. Preserve structured skill names and trusted `SKILL.md` paths while deriving
   readable transcript actions from file reads, shell reads, provider Skill
   tools, and Claude skill context.
2. Render each resolved skill identity as an accessible action and pass a
   structured target to the Chat surface without reparsing visible prose.
3. Resolve exact source-path matches before unique normalized skill identity
   matches. Open organization skills as ephemeral Skill Side Panel targets and
   exact non-library paths through the existing local-file target.
4. Render organization `SKILL.md` through the existing file API with Preview
   and Source modes, explicit read-only status, and no edit controls.
5. Keep ambiguous or unresolved identities as readable non-actions.

## Verification

- Unit tests cover provider shapes, exact and relative paths, multiple skills,
  ambiguous resolution, target identity, and read-only rendering.
- Messenger E2E opens a real organization skill from a transcript action,
  verifies Preview and Source, preserves the Chat URL, and proves edit controls
  are absent.
- Run product-logic checks, focused tests, lint, repository typechecks, the full
  test suite, build, and browser-based visual verification.
- Independent reviewer and verifier agents inspect the finished change before
  hand-off.
