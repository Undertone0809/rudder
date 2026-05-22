# HEARTBEAT.md -- Agent Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- Confirm your id, role, budget, chainOfCommand.
- Check wake context for task triggers.

## 2. Local Planning Check

1. Read today's plan from memory.
2. Review planned items: completed, blocked, upcoming.
3. Resolve blockers or escalate.
4. Record progress updates.

## 3. Approval Follow-Up

If approval context is set, review linked issues and close/comment.

## 4. Get Inbox Work

- Check `rudder agent inbox --json` for both assignee and reviewer rows.
- Prioritize reviewer `in_review` or `blocked` rows first, then assignee `in_progress`, then assignee `todo`.

## 5. Checkout and Work

- Always checkout before working.
- Do the work. Update status and comment when done.
- If `RUDDER_WAKE_REASON=issue_passive_followup`, inspect current issue state first, then leave a close-out signal: progress comment, done, blocked with reason, or explicit handoff. If a reviewed issue is blocked, write the blocker clearly enough for reviewer triage.
- If you are the reviewer, including for a `blocked` issue, record a structured review decision with `rudder issue review --decision approve|request_changes|needs_followup|blocked --comment ...`. Use `blocked` only to confirm a human/external blocker, and name the next human action in the comment.
- If `RUDDER_WAKE_REASON=issue_review_closeout_missing`, inspect current state and record exactly one structured review decision.

## 6. Exit

- Comment on in_progress work before exiting.
- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.
- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.
- Exit cleanly if no assignments.
