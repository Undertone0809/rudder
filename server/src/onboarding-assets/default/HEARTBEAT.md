# HEARTBEAT.md -- Agent Heartbeat Checklist

Run this checklist on every heartbeat.

## 1. Identity and Context

- Confirm your id, role, budget, chainOfCommand.
- Check wake context for task triggers.
- If `RUDDER_WAKE_COMMENT_ID` is set, read that comment before acting. Plain
  `agent://...` links are references; board/operator `@Name` or
  `agent://...?intent=wake` comments are the wake signals.

## 2. Local Planning Check

1. Read today's plan from memory.
2. Review planned items: in progress, completed, blocked, upcoming.
3. Resolve blockers or escalate.
4. Record progress updates.

## 3. Approval Follow-Up

If approval context is set, review linked issues and close/comment.

## 4. Get Inbox Work

- Check `rudder agent inbox --json` for both assignee and reviewer rows.
- Prioritize reviewer `in_review` or `blocked` rows first, then assignee `in_progress`, then assignee `todo`.

## 5. Checkout and Work

* Always checkout before working.

* Do the work. Update status and comment when done.

* In comments, use clickable Markdown links like `[label](url)` for pages or actions the board should open. Do not wrap action URLs in code spans unless you are showing literal code or a command.

* If `RUDDER_WAKE_REASON=issue_passive_followup`, inspect current issue state first, then leave a close-out signal: progress comment, done, blocked with reason, or explicit handoff. If a reviewed issue is blocked, write the blocker clearly enough for reviewer triage.

* Do not rely on an agent-authored comment mention to wake a peer agent. Use the
  reviewer or assignment workflow, and write the handoff plainly.

* If you are the reviewer, including for a `blocked` issue, record a structured review decision with `rudder issue review --decision approve|request_changes|needs_followup|blocked --comment-file <path>`. Use `blocked` only to confirm a human/external blocker, and name the next human action in the comment.

* If `RUDDER_WAKE_REASON=issue_review_closeout_missing`, inspect current state and record exactly one structured review decision.

## 6. Exit

- Comment on in_progress work before exiting.
- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.
- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.
- Exit cleanly if no assignments.
