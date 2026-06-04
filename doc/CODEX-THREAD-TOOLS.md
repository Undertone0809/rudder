# Codex Thread Tools

This document explains the Codex Desktop thread-management tools available to an
agent in this local environment, what information they expose, and the practical
boundaries for using them against real local thread data.

It is intentionally about the **current Codex app tool surface exposed to this
thread**, not a public API guarantee. For public integration work, prefer the
Codex app-server/SDK documentation. For local operator work inside the Codex
Desktop app, these tools are the fastest way to find, inspect, continue, pin,
archive, or create Codex threads.

## Mental model

Codex uses threads as durable conversations. A thread contains turns, and a turn
contains items such as user messages, assistant messages, tool calls, command
outputs, and status events.

The thread tools expose a summarized, permission-bounded view of that data:

- `list_threads` finds recent threads and returns compact summaries.
- `read_thread` reads recent turns for one thread, optionally including clipped
  tool or command outputs.
- `send_message_to_thread` continues an existing thread.
- `create_thread` creates a new separate thread when explicitly requested.
- `set_thread_title`, `set_thread_archived`, and `set_thread_pinned` manage
  thread metadata.

These are not filesystem commands and not a generic transcript database dump.
They are Codex Desktop app tools surfaced to the current agent session.

## Tool reference

### `codex_app.list_threads`

Use this first when the user gives a keyword, title fragment, project hint, or
when the thread id is unknown.

Input:

```json
{
  "query": "optional search text",
  "limit": 8
}
```

Output shape:

```json
{
  "schemaVersion": 1,
  "query": "codex",
  "threads": [
    {
      "id": "019e93f3-3942-7f61-a7ef-df626c895416",
      "title": "Thread title",
      "preview": "First visible prompt or summary preview",
      "status": "active",
      "cwd": "/Users/zeeland/projects/rudder-oss",
      "createdAt": 1780598651,
      "updatedAt": 1780598869
    }
  ]
}
```

What it is good for:

- Find a thread by title, prompt text, project, or branch-related wording.
- Confirm whether a thread is active or idle before reading or steering it.
- Identify the project/worktree path attached to the thread.

Boundaries:

- It returns summaries, not full turns.
- Search quality depends on what the app indexes.
- A title/preview match is only a candidate; read the thread before drawing
  conclusions.

### `codex_app.read_thread`

Use this after identifying a thread id.

Input:

```json
{
  "threadId": "019e93f3-3942-7f61-a7ef-df626c895416",
  "turnLimit": 5,
  "includeOutputs": true,
  "maxOutputCharsPerItem": 1200,
  "cursor": "optional cursor for older turns"
}
```

Output shape:

```json
{
  "schemaVersion": 1,
  "thread": {
    "id": "019e93f3-3942-7f61-a7ef-df626c895416",
    "title": "Thread title",
    "status": { "type": "active", "activeFlags": [] },
    "cwd": "/Users/zeeland/projects/rudder-oss"
  },
  "page": {
    "order": "newest_first",
    "limit": 5,
    "nextCursor": "cursor-for-older-turns",
    "hasMore": true
  },
  "turns": [
    {
      "id": "019e93f5-d646-7973-9b6e-ea9e8404b62a",
      "status": "inProgress",
      "startedAt": 1780598822,
      "completedAt": null,
      "items": [
        { "type": "userMessage", "content": [{ "type": "text" }] },
        { "type": "agentMessage", "phase": "commentary" }
      ]
    }
  ]
}
```

What it is good for:

- Understand the latest ask, current status, and whether a thread is still
  running.
- Recover the last few decisions, final answers, and visible progress updates.
- Read enough tool or command output to debug failures, when
  `includeOutputs=true`.
- Page backward through older turns with `page.nextCursor`.

Boundaries:

- Output can be clipped by `maxOutputCharsPerItem`.
- The tool returns the page requested, not a proof that no older relevant
  context exists. If `hasMore=true`, older turns exist.
- Reading a thread does not verify the current filesystem, remote branch, test
  result, or deployment state. Treat those as separate evidence sources.
- In-progress turns may change after the read.

### `codex_app.send_message_to_thread`

Use this to continue an existing thread after the user explicitly wants that
thread steered.

Input:

```json
{
  "threadId": "019e93f3-3942-7f61-a7ef-df626c895416",
  "prompt": "Continue from the last blocker and run the focused test.",
  "model": "gpt-5.5",
  "thinking": "high"
}
```

`model` and `thinking` are optional. Omit them to preserve the thread's current
settings.

What it is good for:

- Resume a stalled or blocked thread with new evidence.
- Ask a background worker to continue the task it already has context for.
- Keep follow-up work in the same conversation instead of starting over.

Boundaries:

- This is a write action: it changes the target thread by adding a prompt.
- It should not be used just to inspect a thread.
- It can cause commands, file edits, or other tool usage inside the target
  thread depending on its instructions and permissions.

### `codex_app.create_thread`

Use this only when the user explicitly asks for a new or separate thread.

Project-local thread:

```json
{
  "target": {
    "type": "project",
    "projectId": "/Users/zeeland/projects/rudder-oss",
    "environment": { "type": "local" }
  },
  "prompt": "Review the staged patch only."
}
```

Project worktree thread:

```json
{
  "target": {
    "type": "project",
    "projectId": "/Users/zeeland/projects/rudder-oss",
    "environment": {
      "type": "worktree",
      "startingState": { "type": "working-tree" }
    }
  },
  "prompt": "Build this feature in an isolated worktree."
}
```

Projectless thread:

```json
{
  "target": {
    "type": "projectless",
    "directoryName": "codex-thread-research"
  },
  "prompt": "Summarize these notes."
}
```

What it is good for:

- Parallel read-heavy analysis.
- Isolating implementation in a worktree.
- Starting a fresh projectless research task.

Boundaries:

- Creating a thread is an explicit user-request action, not a default way to
  avoid doing work in the current thread.
- Local mode can touch the same checkout. Worktree mode is safer for parallel
  code edits.
- A created thread still needs follow-up inspection if the user wants verified
  results.

### Metadata tools

These tools update thread metadata:

```json
{ "threadId": "019e...", "title": "New title" }
{ "threadId": "019e...", "archived": true }
{ "threadId": "019e...", "pinned": true }
```

Use them for housekeeping:

- Rename a vague thread after identifying its real task.
- Pin important ongoing work.
- Archive stale or completed threads.

They do not change the repository, but they do change the user's Codex app
state.

## Real local examples from this environment

The examples below were run in this checkout on 2026-06-05 using the current
Codex Desktop thread tools. Details are intentionally summarized to avoid
committing private transcript content.

### Example 1: Find threads about Codex

Call:

```json
{
  "query": "codex",
  "limit": 6
}
```

Observed result:

- Returned two candidate threads.
- Each result included `id`, `title`, `preview`, `status`, `cwd`, `createdAt`,
  and `updatedAt`.
- One result was the current active thread in
  `/Users/zeeland/projects/rudder-oss`.
- Another result was an active thread in a Rudder worktree.

Capability proven:

- The agent can search recent local Codex threads without opening them.
- The agent can see which project/worktree a thread belongs to before reading
  it.

Boundary proven:

- This did not read full messages or outputs. It only identified candidates.

### Example 2: Read the current thread

Call:

```json
{
  "threadId": "019e93f3-3942-7f61-a7ef-df626c895416",
  "turnLimit": 5,
  "includeOutputs": true,
  "maxOutputCharsPerItem": 1200
}
```

Observed result:

- Returned the current thread metadata.
- Returned the current in-progress turn, including the user's request and the
  assistant's commentary updates.
- Returned the previous completed turn, including the user's prior question and
  the assistant's final answer.
- `hasMore=false`, because this short thread had no older turns beyond the
  returned page.

Capability proven:

- The agent can inspect the live conversation state and detect that the newest
  turn is still in progress.
- The agent can recover prior final answers from the same thread.

Boundary proven:

- Reading an in-progress thread is a snapshot. Later tool calls and messages are
  not included until the thread is read again.

### Example 3: Read an older multi-turn thread

Call:

```json
{
  "threadId": "019e8973-e1aa-7160-a136-e14c1756c332",
  "turnLimit": 3,
  "includeOutputs": true,
  "maxOutputCharsPerItem": 1000
}
```

Observed result:

- Returned three newest completed turns from an older idle thread.
- `hasMore=true` and `nextCursor` was present, proving older turns can be paged.
- The returned turns included user messages, commentary, final answers, status,
  durations, and item phases.

Capability proven:

- The agent can inspect an older thread without reopening it in the UI.
- The agent can page backward when a thread has more history than the current
  read window.

Boundary proven:

- Only the newest three turns were returned. A conclusion about the whole thread
  would require following `nextCursor` until enough history is read.
- Included output is bounded by `maxOutputCharsPerItem`; large command output is
  not a complete log unless separately fetched from another evidence source.

## Practical use cases

### 1. Continue a blocked implementation thread

User prompt:

```text
Find the thread where we were adding Cursor support and continue from the last
blocker.
```

Agent flow:

1. `list_threads({ "query": "Cursor support", "limit": 5 })`
2. Pick the matching `cwd` and title.
3. `read_thread({ "threadId": "...", "turnLimit": 5, "includeOutputs": true })`
4. Verify local repo state with `git status`, tests, or files as needed.
5. `send_message_to_thread` only if the user wants that other thread to resume.

Boundary:

- Thread history can explain the blocker.
- Current repo state must still be verified locally because branches, files, and
  test results may have changed since the thread ran.

### 2. Audit whether another agent actually validated a change

User prompt:

```text
Read thread 019e... and tell me whether it really ran the E2E test it claimed.
```

Agent flow:

1. `read_thread({ "threadId": "...", "turnLimit": 10, "includeOutputs": true,
   "maxOutputCharsPerItem": 4000 })`
2. Look for explicit command items, command output, screenshots, or final
   validation claims.
3. If output is clipped or missing, use repo files, local logs, or rerun focused
   tests where appropriate.

Boundary:

- A final answer saying "tested" is a claim, not proof.
- `read_thread` can surface command output snippets, but clipped output may be
  insufficient for a review-grade conclusion.

### 3. Summarize recent work across threads

User prompt:

```text
Find my recent Rudder threads and summarize what is active, blocked, or done.
```

Agent flow:

1. `list_threads({ "query": "Rudder", "limit": 20 })`
2. Read the likely candidates one by one.
3. Group by `status`, `cwd`, last user ask, and final answer or active state.
4. Avoid claiming filesystem results unless verified with local repo commands.

Boundary:

- This works well for operator awareness.
- It is not a complete historical analytics pipeline. For large cohorts, use
  local session indexes or database-backed analysis in addition to thread tools.

### 4. Keep noisy investigation out of the main thread

User prompt:

```text
Create a separate background thread in a worktree to investigate this flaky test.
```

Agent flow:

1. `create_thread` with a project worktree target.
2. Let the new thread run the investigation.
3. Later, `read_thread` the child thread to extract a short result summary.

Boundary:

- This is appropriate when the user explicitly asks for parallel/separate work.
- It is safer for read-heavy or isolated worktree tasks than for simultaneous
  edits in the same local checkout.

### 5. Manage thread hygiene

User prompt:

```text
Find stale completed threads about release notes, archive the irrelevant ones,
and pin the release blocker.
```

Agent flow:

1. `list_threads({ "query": "release notes", "limit": 20 })`
2. `read_thread` candidates before deciding relevance.
3. `set_thread_archived` for stale threads.
4. `set_thread_pinned` for the active blocker.

Boundary:

- Pin/archive are app-state mutations. The agent should make sure the user's
  intent is clear before changing them.

## Capability boundaries

Thread tools can answer:

- Which recent threads match a query?
- Which project or worktree does a thread belong to?
- Is the thread active, idle, archived, or otherwise marked by status?
- What did the latest turns ask and answer?
- Did a turn expose tool calls, command output snippets, or progress updates?
- Is there older history available through pagination?
- Can this existing thread be continued with a new prompt?

Thread tools cannot, by themselves, answer:

- Whether a branch is currently clean, merged, pushed, or deployed.
- Whether a test result still passes now.
- Whether a clipped command output had failures outside the returned range.
- Whether all local session history has been read if pagination was not
  exhausted.
- Whether an external connector, browser login, GitHub PR, or production system
  changed after the thread ended.
- Whether private data outside the current user's authorized Codex app context
  exists.

Use thread tools as the coordination layer, then verify volatile facts with the
right source of truth:

- Files and diffs: `git status`, `git diff`, `rg`, file reads.
- Tests and builds: focused repo commands.
- Browser-visible behavior: Browser plugin or screenshot.
- GitHub state: GitHub plugin or `gh`/remote checks.
- Rudder runtime state: local API, DB, logs, or CLI.
- Long historical analysis: local session files, indexes, or SQLite where
  appropriate.

## Safety rules

- Use `list_threads` and `read_thread` freely for read-only diagnosis when the
  user asks about threads.
- Use `send_message_to_thread` only when the user wants to steer or resume that
  specific thread.
- Use `create_thread` only when the user explicitly asks for a new/separate
  thread or background worker.
- Use pin/archive/title updates only after the target is clear.
- Do not treat thread summaries as proof of external state.
- Do not expose sensitive transcript details in committed docs or public
  summaries unless the user explicitly asks for that content to be preserved.

## Fast prompts to use

```text
Find the thread about <topic>, read the last 5 turns, and tell me the current
status plus what needs verification.
```

```text
Read thread <id> with outputs included and check whether the claimed tests are
actually visible in the transcript.
```

```text
Find recent active Rudder threads, group them by local checkout/worktree, and
tell me which ones are risky to continue in the same working tree.
```

```text
Create a separate worktree thread to investigate <topic>, then report back here
with the child thread id.
```

```text
Archive stale threads matching <topic>, but read each candidate first and list
what you changed.
```
