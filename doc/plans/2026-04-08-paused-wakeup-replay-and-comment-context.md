# Paused Wake Replay + `issue_commented` Context

## Summary

Fix two related behavior gaps without changing the external REST surface:

- Plain assignee comment wakes (`issue_commented`) must carry the same first-turn context quality as mention wakes: issue summary, comment payload, and a prompt template that actually uses that data.
- Manual `paused` agents must not lose incoming wakeups. While paused, wakes are stored as deferred; when the agent is resumed, they are replayed through the normal orchestration path so current issue-lock and concurrency rules still apply.

## Key Changes

### 1. Enrich plain comment wakes and give them a dedicated prompt

- Extend the plain assignee comment wake path so `contextSnapshot` includes:
  - `issueId`, `taskId`, `commentId`, `wakeCommentId`, `wakeReason: "issue_commented"`
  - nested `issue { id, title, description, status, priority }`
  - nested `comment { id, body, authorAgentId, authorUserId }`
- Keep mention wakes unchanged; do not widen this pass to unrelated wake reasons.
- Add a new built-in prompt template for `issue_commented` such as “there is a new comment on an issue you own,” and map `selectPromptTemplate()` to it by `wakeReason`.
- Do not change `issue_reopened_via_comment` prompt behavior in this pass.

### 2. Add a separate paused-defer state instead of reusing issue-lock defer

- Add `deferred_agent_paused` to shared wakeup status constants/types.
- Do not reuse `deferred_issue_execution`; that status remains only for issue execution lock deferral.
- In heartbeat wakeup enqueue:
  - keep budget-block handling exactly as-is
  - treat only `agent.status === "paused"` as deferrable
  - keep `terminated` and `pending_approval` as hard conflicts
- When paused, persist the wakeup as `deferred_agent_paused` with the original `source`, `triggerDetail`, `reason`, `payload`, and the fully enriched context snapshot preserved under the same internal deferred-context mechanism already used for deferred issue wakes.
- Coalesce repeated paused wakes by `agentId + taskKey` using the existing merged-context logic, so repeated comments on the same issue collapse to the newest comment context instead of creating a wake storm.

### 3. Resume must actively replay deferred paused wakeups

- Add a heartbeat-service entrypoint for “resume deferred paused wakeups for agent”.
- Call it from the agent resume flow immediately after the agent status flips back to `idle`.
- Replay deferred paused wakeups oldest-first through the same orchestration decision path used for fresh wakes, so:
  - `issue_comment_mentioned` keeps its current immediate/bypass behavior after resume
  - issue-scoped assignment/comment wakes still honor current issue-execution locking at resume time
  - non-issue wakes behave like normal fresh wakes
- Reuse the existing wakeup request row during promotion rather than inserting a second audit row for the same user action.
- If a resumed wake is still blocked/skipped at replay time, finalize that request with the resulting terminal reason; do not leave it stuck in deferred state.

## Public Interfaces / Types

- Extend `WakeupRequestStatus` with `deferred_agent_paused`.
- Add one new built-in prompt template selection branch for `issue_commented`.
- No database migration is required; `agent_wakeup_requests.status` is already text-backed.
- No REST request/response schema changes are required.

## Test Plan

- Extend the issue lifecycle route test to assert plain comment wakes now include issue/comment context and render the dedicated `issue_commented` prompt text.
- Add heartbeat-level tests for:
  - paused agent + plain comment wake => `deferred_agent_paused`, no run created
  - paused agent + mention wake => deferred while paused, then replayed on resume with existing mention semantics intact
  - paused agent + assignment/on-demand wake => deferred and replayed on resume
  - repeated paused comment wakes on the same issue => coalesced, latest comment wins
  - `terminated` / `pending_approval` still reject instead of deferring
  - budget-block behavior remains unchanged
- Add one resume-path integration test to prove `/agents/:id/resume` promotes deferred paused wakes instead of only changing the status field.

## Assumptions / Defaults

- Chosen scope: while an agent is manually paused, all new wakes are preserved and replayed on resume, not just comments.
- This pass does not redesign broader comment/reopen UX; it only upgrades `issue_commented` prompt/context quality and paused wake reliability.
- Deferred paused wake replay should preserve current ordering and coalescing expectations, not create parallel surprise runs beyond what fresh wakeup logic already allows.
