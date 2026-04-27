---
name: pr-local-preview-validator
description: >
  Check out a GitHub pull request into a local worktree, start it safely, verify
  the local preview, and hand the user a URL. Use this skill whenever the user
  asks to run, preview, review, or validate a PR locally, including commands
  like `gh pr checkout <number>`, "把这个 PR 跑起来", "本地 worktree 看一下效果",
  "让我 review 一下", or "启动 PR 预览". If the PR affects visible UI, use this
  skill to capture screenshots before hand-off so the user can inspect the
  shipped result, not just the URL.
---

# PR Local Preview Validator

Run pull requests in a disposable local worktree and give the user a stable
preview link. The point is to let the user review the PR while protecting their
current working tree and making UI changes visible.

## Default Workflow

### 1. Preserve the current workspace

Start by checking the repository state:

```bash
git status --short --branch
gh pr view <number> --json number,title,state,headRefName,headRepositoryOwner,url,isCrossRepository
```

If the current worktree has local changes, do not run `gh pr checkout` there.
Create or reuse a sibling worktree instead. This avoids overwriting unrelated
work and keeps the PR preview easy to remove later.

Use a predictable path:

```text
<repo-parent>/<repo-name>-pr-<number>
```

For this repository, PR 8 should become:

```text
/Users/zeeland/projects/rudder-oss-pr-8
```

If the directory already exists, inspect it before reusing it:

```bash
git -C <worktree-path> status --short --branch
git -C <worktree-path> branch --show-current
```

If it is dirty, ask only if the dirty changes conflict with the user's goal.
Otherwise, pick a suffixed path such as `<repo-name>-pr-<number>-preview`.

### 2. Check out the PR in the worktree

Create the worktree from the remote base, then check out the PR branch inside it:

```bash
git worktree add --detach <worktree-path> origin/main
gh pr checkout <number> --branch zeelandc/pr-<number>
```

If `main` is not the base branch, use the PR's actual base ref. Prefer a local
branch name that makes the preview purpose clear and follows the user's branch
prefix convention when the repository defines one.

After checkout, verify:

```bash
git status --short --branch
```

### 3. Install dependencies only when needed

Check whether dependencies are present:

```bash
test -d node_modules && echo node_modules-present || echo node_modules-missing
```

If missing, install them from the worktree:

```bash
pnpm install
```

Report install warnings only when they affect the preview. Routine peer or bin
link warnings can be mentioned briefly.

### 4. Choose isolated runtime settings

Before starting, inspect occupied ports and existing local runtimes:

```bash
lsof -nP -iTCP:<candidate-port> -sTCP:LISTEN
```

For Rudder, prefer:

```bash
RUDDER_INSTANCE_ID=pr-<number>
PORT=<free-api-port>
RUDDER_EMBEDDED_POSTGRES_PORT=<free-pg-port>
```

Use `3100` only if it is free and the user clearly wants the default instance.
If another Rudder dev runtime is already running, leave it alone and use a
separate port and instance ID.

Example:

```bash
env RUDDER_INSTANCE_ID=pr-8 PORT=3118 RUDDER_EMBEDDED_POSTGRES_PORT=54358 pnpm dev
```

### 5. Start the preview so it survives hand-off

Use `tmux` when available. It keeps the preview alive after the assistant turn
ends and gives the user a simple way to inspect logs.

```bash
tmux new-session -d -s rudder-pr-<number> -c <worktree-path> \
  'env RUDDER_INSTANCE_ID=pr-<number> PORT=<port> RUDDER_EMBEDDED_POSTGRES_PORT=<pg-port> pnpm dev'
```

If `tmux` is not available, use another managed background process and capture
logs to `/tmp/<repo-name>-pr-<number>.log`. Do not leave an opaque process
running without telling the user how to stop it.

### 6. Wait for readiness

Poll the health endpoint or the app's equivalent readiness check:

```bash
curl -fsS http://127.0.0.1:<port>/api/health
```

If the app has no health endpoint, use the first meaningful route and check for
a successful response. For frontend-only apps, load the dev server URL and
confirm it serves HTML.

When startup fails, inspect the session logs before returning:

```bash
tmux capture-pane -pt rudder-pr-<number> -S -160
```

Fix straightforward startup issues yourself when they are local environment
problems, such as missing dependencies or port conflicts. Do not edit PR source
code unless the user asked for a fix.

### 7. Decide whether UI screenshots are required

Screenshots are required when any of these are true:

- the PR title, files, or user request mentions UI, layout, pages, components,
  CSS, design, screenshots, visual review, browser behavior, or interaction
- changed files live under `ui/`, `desktop/`, frontend route files, component
  directories, stylesheets, or public assets
- the user says they want to "see" the effect

Use Browser Use for local browser inspection when available. Capture the
important screen or flow after the preview is running. Store temporary
screenshots outside the repository, for example:

```text
/tmp/rudder-pr-<number>-<view>.png
```

For non-UI backend/API PRs, a health check plus a task-specific API smoke check
is usually enough. If the user still needs to review manually, provide the URL.

### 8. Hand-off format

Keep the final response short and concrete:

```text
PR <number> is running in <worktree-path>.

Open: http://127.0.0.1:<port>
Logs: tmux attach -t rudder-pr-<number>
Stop: tmux kill-session -t rudder-pr-<number>

Health check passed: <brief status>
Screenshots: <paths or embedded images when UI changed>
```

If screenshots were required but could not be captured, say exactly why and
what verification did run.

## Cleanup Requests

When the user asks to close, stop, or clean up the preview, stop only the PR
preview session and verify its port is free:

```bash
tmux kill-session -t rudder-pr-<number>
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Do not remove the worktree unless the user explicitly asks for cleanup. If they
do ask to remove it, verify the worktree has no uncommitted changes first.

## Safety Notes

- Never use destructive Git commands in the user's main worktree to make a PR
  checkout succeed.
- Do not stop unrelated Rudder dev sessions just because the default port is in
  use; choose an isolated port instead.
- Keep PR preview data isolated with a dedicated `RUDDER_INSTANCE_ID`.
- If source edits become necessary, pause and state that the task has shifted
  from previewing a PR to fixing it.
