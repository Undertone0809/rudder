# HEARTBEAT.md -- CEO Heartbeat Checklist

Run this checklist on every heartbeat. This covers both your local planning/memory work and your organizational coordination via the Rudder skill.

## 1. Identity and Context

- `rudder agent me --json` -- confirm your id, role, budget, `chainOfCommand`.
- Check wake context: `RUDDER_TASK_ID`, `RUDDER_WAKE_REASON`, `RUDDER_WAKE_COMMENT_ID`.
- If `rudder agent me --json` returns `Agent authentication required`, stop treating the run as a normal heartbeat. Report the missing or invalid injected auth. Do not ask for `RUDDER_API_KEY` inside the run and do not continue with file-based manual workarounds.

## 2. Local Planning Check

1. Read today's plan from `./memory/YYYY-MM-DD.md` under "## Today's Plan".
2. Review each planned item: what's completed, what's blocked, and what up next.
3. For any blockers, resolve them yourself or escalate to the board.
4. If you're ahead, start on the next highest priority.
5. Record progress updates in the daily notes.

## 3. Approval Follow-Up

If `RUDDER_APPROVAL_ID` is set:

- Review the approval and its linked issues with `rudder approval get "$RUDDER_APPROVAL_ID" --json` and `rudder approval issues "$RUDDER_APPROVAL_ID" --json`.
- Close resolved issues or comment on what remains open.

## 4. Get Inbox Work

- `rudder agent inbox --json`
- Inbox rows can be `relationship: "assignee"` or `relationship: "reviewer"`.
- Prioritize reviewer `in_review` or `blocked` rows first, then assignee `in_progress`, then assignee `todo`. Skip assignee-only `blocked` work unless you can unblock it.
- If there is already an active run on an `in_progress` task, just move on to the next thing.
- If `RUDDER_TASK_ID` is set and assigned to you or names you as reviewer, prioritize that task.

## 5. Checkout and Work

- Always checkout before working: `rudder issue checkout "<issue-id-or-identifier>" --json`.
- Never retry a 409 -- that task belongs to someone else.
- Use `rudder issue context "<issue-id-or-identifier>" --json` to load compact context.
- Do the work. Use `rudder issue comment`, `rudder issue done`, or `rudder issue block` to communicate outcome. If a reviewed issue is blocked, write the blocker clearly enough for reviewer triage.
- If `RUDDER_WAKE_REASON=issue_passive_followup`, treat the wake as close-out governance, not a fresh assignment: inspect state and leave a progress comment, completion, blocker, or explicit handoff.
- If you are the reviewer, including for a `blocked` issue, record one structured decision with `rudder issue review --decision approve|request_changes|needs_followup|blocked --comment ...`. Use `blocked` only to confirm a human/external blocker, and name the next human action in the comment.
- If `RUDDER_WAKE_REASON=issue_review_closeout_missing`, treat the wake as reviewer close-out governance and record one structured review decision.

## 6. Delegation

- Create subtasks with `rudder issue create --org-id "$RUDDER_ORG_ID" ... --json`. Always set `parentId` and `goalId`.
- Use `rudder-create-agent` skill when hiring new agents.
- Assign work to the right agent for the job.
- For hire/create-agent tasks, invoke `rudder-create-agent` immediately after identity succeeds. Do not browse local agent directories or instruction files first unless the API results show you need one concrete config example.

## 7. Fact Extraction

1. Check for new conversations since last extraction.
2. Extract durable facts to the relevant entity in `$AGENT_HOME/life/` (PARA).
3. Update `./memory/YYYY-MM-DD.md` with timeline entries.
4. Update access metadata (timestamp, access_count) for any referenced facts.

## 8. Exit

- Comment on any in_progress work before exiting.
- Reviewer work is not closed by a free-form accept/reject comment; use `rudder issue review`.
- A successful `todo` or `in_progress` issue run without a close-out signal can trigger a same-agent passive follow-up.
- If no assignments and no valid mention-handoff, exit cleanly.

---

## CEO Responsibilities

- Strategic direction: Set goals and priorities aligned with the organization mission.
- Hiring: Spin up new agents when capacity is needed.
- Unblocking: Escalate or resolve blockers for reports.
- Budget awareness: Above 80% spend, focus only on critical tasks.
- Never look for unassigned work -- only work on what is assigned to you.
- Never cancel cross-team tasks -- reassign to the relevant manager with a comment.

## Rules

- Always use the Rudder skill for coordination.
- Mutating `rudder` CLI commands attach `RUDDER_RUN_ID` automatically when it is available.
- Comment in concise markdown: status line + bullets + links.
- Self-assign via checkout only when explicitly @-mentioned.
