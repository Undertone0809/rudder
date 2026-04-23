# Run Recovery

This document defines the recovery contract for failed heartbeat runs and serves as the initial recovery case library.

## 1. Purpose

Rudder retries failed runs as explicit recovery work, not as an invisible "just wake the agent again" shortcut.

Recovery must stay:

- visible
- auditable
- same-agent by default
- continue-preferred by default

Recovery must not silently:

- reassign the issue
- release the issue
- hide the failure
- create a brand-new task interpretation when prior work already exists

## 2. Recovery Contract

Manual retry and automatic `process_lost` retry share the same contract.

Every recovery run must:

- derive from an existing run
- preserve the original task context instead of rebuilding a lossy wake payload
- carry `retryOfRunId` at the run row level
- carry `contextSnapshot.recovery`

`contextSnapshot.recovery` contains:

- `originalRunId`
- `failureKind`
- `failureSummary`
- `recoveryTrigger` (`manual` or `automatic`)
- `recoveryMode` (`continue_preferred`)

For issue-backed runs, recovery keeps the original task context when available, including:

- `issueId`
- `taskId`
- `taskKey`
- `projectId`
- `wakeCommentId`
- `issue`
- `comment`

When retrying an older lossy retry run, Rudder backfills missing issue/comment context from the retry chain before creating the new recovery run.

## 3. Public Surface

Use:

- `POST /api/heartbeat-runs/:runId/retry`

Do not use manual retry to call:

- `POST /api/agents/:id/wakeup`

That generic wakeup path is still valid for ordinary manual wakes, but not for recovery-from-failure semantics.

## 4. Prompt Contract

Recovery prompts must say all of the following clearly:

- this is a recovery, not a fresh task
- which run failed
- why it failed
- what issue/task context still applies
- that the agent must inspect prior progress and existing side effects before continuing

For issue-backed recovery, the prompt must include the issue summary directly.

For non-issue recovery, the prompt may degrade to a generic recovery prompt, but it must still include failure metadata and continue-preferred guidance.

## 5. Auto Retry Policy

V1 keeps a single automatic retry only for clearly transient runtime failures, currently:

- `process_lost`

Automatic retry is still explicit:

- the new run is a recovery run
- recovery metadata is attached
- run events record the recovery reason
- UI can trace the new run back to the source run

V1 still does not do:

- automatic retry for logic/task/business failures
- automatic reassignment
- automatic issue release
- automatic issue status rollback

## 6. Case Library

### Case: issue assignment run fails, then manual retry

Expected behavior:

- retry creates a recovery run
- the new run keeps the original issue snapshot
- the prompt tells the agent to inspect finished work and side effects before continuing

Coverage:

- automated: `server/src/__tests__/heartbeat-process-recovery.test.ts`
- automated: `packages/agent-runtime-utils/src/server-utils.test.ts`

### Case: `process_lost` automatic retry

Expected behavior:

- retry derives from the failed run
- the new run keeps issue/task continuity
- the new run is visibly marked as automatic recovery

Coverage:

- automated: `server/src/__tests__/heartbeat-process-recovery.test.ts`

### Case: network/model interruption

Expected behavior:

- manual retry is continue-preferred
- prompt includes the failure summary
- prompt explicitly warns against blindly repeating the whole task

Coverage:

- automated: `server/src/__tests__/heartbeat-process-recovery.test.ts`
- automated: `packages/agent-runtime-utils/src/server-utils.test.ts`

### Case: partial external side effects already happened

Example:

- the run already created a CMO agent, but did not finish file edits, comments, or status cleanup

Expected behavior:

- recovery prompt tells the agent to inspect the current world state first
- retry does not frame the work as a fresh assignment

Coverage:

- automated: `packages/agent-runtime-utils/src/server-utils.test.ts`

### Case: issue is already completed or context is stale

Expected behavior:

- retry still stays explicit and auditable
- if the current run snapshot is lossy, Rudder backfills from the retry chain when possible
- agents should re-check current issue state before taking irreversible action

Coverage:

- future eval case: stale/done issue retry transcript eval

### Case: no issue-bound run

Expected behavior:

- retry still creates a recovery run
- prompt falls back to generic recovery framing
- failure metadata and continue-preferred guidance are preserved

Coverage:

- automated: `packages/agent-runtime-utils/src/server-utils.test.ts`

## 7. Debugging Checklist

When a recovery run looks wrong, check these in order:

1. Did the UI call `POST /api/heartbeat-runs/:runId/retry`?
2. Does the new run row have `retryOfRunId`?
3. Does `contextSnapshot.recovery` exist and match the source failure?
4. Did the retry chain preserve or backfill `contextSnapshot.issue` / `comment`?
5. Did prompt selection choose a recovery-aware template instead of the default generic prompt?
6. If the run was automatic, was the failure actually `process_lost`?
