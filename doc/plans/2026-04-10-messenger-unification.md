# Messenger Unified Threads Plan

Date: 2026-04-10
Status: Draft

## Summary

Unify the board communication surfaces into `Messenger` while preserving the underlying work objects. `Messenger` should combine chat conversations, issue attention, approvals, and system notifications into one three-column experience:

- left: main nav with a single `Messenger` entry
- middle: a time-ordered thread list
- right: the selected thread rendered by type

The core product intent is not to turn Rudder into a generic chat app. `Messenger` is the board communication shell; issues remain the execution surface.

## Key Decisions

1. `chat` stays a first-class thread type, but it is no longer the only communication surface.
2. `issues`, `approvals`, and system notifications are aggregated into single middle-column items when appropriate.
3. The right column renders a thread timeline for the selected aggregate item instead of a full detail form.
4. `issue` and `approval` aggregate threads support the highest-value actions in place, with full-detail pages reachable via explicit links.
5. Follow and unread state for aggregated threads should be durable and user-scoped.

## Implementation Notes

- Keep routing and compatibility layers stable during the transition.
- Preserve existing chat conversation behavior and detail pages.
- Add shared thread summary/detail types before introducing UI-specific rendering logic.
- Prefer additive server endpoints and test coverage over broad rewrites.

## Test Plan

- Verify board entry points route into `Messenger`.
- Verify mixed middle-column ordering across chat, issues, approvals, and system threads.
- Verify the issue aggregate thread can surface followed or assigned issues and supports quick comments.
- Verify the approval aggregate thread supports inline decisions.
- Verify legacy chat and inbox behaviors remain reachable while the migration is in flight.

## Assumptions

- `Messenger` is a board-level shell, not a replacement for issue detail pages.
- Aggregated issue and approval threads are single items in the thread list.
- The migration is incremental and may require compatibility redirects during rollout.
