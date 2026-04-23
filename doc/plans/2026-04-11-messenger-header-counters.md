# Messenger Header Counters

Status: Planned
Date: 2026-04-11
Owner: Codex

## Context

Messenger thread pages currently show aggregate counters in the right-side header, including:

- `n unread` on Issues
- `n pending` or `n total` on Approvals
- `n items` on system threads

These counters add noise without improving operator decision-making. They also conflict with the current design contract in `doc/DESIGN.md`, especially:

- tool, not stage
- density with clarity
- progressive disclosure

## Goal

Remove aggregate counters from the right-side Messenger content header while preserving the rest of Messenger behavior.

## Scope

- simplify the header in `ui/src/pages/Messenger.tsx` to show only title and description
- stop passing header counter strings from Issues, Approvals, and system thread views
- add automated coverage for the absence of these counters

## Non-Goals

- changing sidebar unread badges
- changing the primary rail Messenger badge
- changing unread/read behavior
- changing server-side Messenger summary generation
- changing object-level status chips or action blocks

## Implementation Notes

- keep the change presentation-only
- leave `unreadCount` and `needsAttention` intact for other surfaces
- verify one system thread path in addition to Issues and Approvals
