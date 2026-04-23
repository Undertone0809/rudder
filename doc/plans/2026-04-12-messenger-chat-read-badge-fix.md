# Messenger Chat Read Badge Fix

Status: Completed
Date: 2026-04-12
Owner: Codex

## Context

Opening an unread Messenger chat is expected to clear two unread indicators immediately:

- the unread badge on the specific Messenger thread row
- the aggregate unread badge on the primary rail Messenger entry

Right now the chat read mutation updates the conversation read state, but the UI does not immediately refresh all read-state projections that depend on that write.

## Goal

Make chat read behavior consistent so that opening an unread Messenger chat clears both the thread-level unread badge and the rail-level Messenger unread badge without requiring a manual reload.

## Scope

- inspect the existing chat read mutation and its refresh path
- refresh the chat list data used by the Messenger thread sidebar
- refresh the Messenger thread summary data used by the rail badge
- add or update automated coverage for this read-state synchronization path if there is an appropriate existing test surface nearby

## Non-Goals

- changing unread semantics for issues, approvals, or system threads
- redesigning Messenger badges or attention styling
- rewriting Messenger read-state ownership across all surfaces
- changing server-side unread counting rules unless debugging proves that the backend write is wrong

## Implementation Notes

- prefer a small fix in the existing chat read refresh chain over a broad Messenger refactor
- keep the change scoped to the chat read path unless verification shows another surface is also stale
- verify both the per-thread unread indicator and the rail aggregate badge after the patch
