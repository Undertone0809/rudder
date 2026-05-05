---
name: rudder-worktree-preview-maintainer
description: >
  Start the current Rudder checkout as a temporary managed preview, verify
  readiness, and hand the user a stable URL, logs, and stop command. Use this
  skill when the user asks to run the current branch, "把当前分支跑起来",
  "运行起来我自己测试下", "本地看一下效果", or wants a background preview
  handoff. Do not use it as the default Codex worktree isolation mechanism;
  `pnpm dev` already auto-isolates Codex-managed worktrees.
---

# Rudder Worktree Preview Maintainer

Run the current Rudder checkout as a temporary preview so the user can inspect
the feature in a browser without leaving a foreground command running.

This skill is for the common post-implementation hand-off: the branch already
contains the work, and the user wants a local URL to test. It is not a PR
checkout workflow, it is not a broad process cleanup workflow, and it is not
the canonical developer environment for Codex-managed worktrees.

Rudder's normal `pnpm dev` entrypoint is the canonical development path. In
Codex-managed worktrees under `~/.codex/worktrees/<id>/<repo>`, `pnpm dev`
auto-derives an isolated `RUDDER_HOME`, instance id, server port, embedded
PostgreSQL port, and worktree branding when no repo-local `.rudder/` config
exists. Use this preview skill only when the user wants a managed background
preview handoff with health verification, logs, and a stop command.

## Use This Skill When

- The user asks to run the current branch or current worktree locally.
- The user wants to manually test a recently implemented UI or workflow change.
- The assistant needs to hand off a stable preview URL after implementation
  without leaving `pnpm dev` in the foreground.
- The user asks for logs, a stop command, or a temporary preview that can be
  cleaned up independently.
- The task is to provide a preview URL, not to package Desktop or publish a
  release.

## Do Not Use This Skill When

- The user asks to check out or preview a GitHub PR; use
  `pr-local-preview-maintainer` instead.
- The user asks only to stop or clean local dev processes; use
  `stop-rudder-dev-maintainer` instead.
- The user is asking why Codex worktrees interfere, how normal development
  should be isolated, or whether `pnpm dev` is using the current worktree. In
  that case inspect `scripts/dev-local-env.mjs`, `doc/DEVELOPING.md`, and the
  `/api/health` payload for the active dev runtime.
- The user simply wants to develop inside the current Codex worktree. Use
  `pnpm dev`, which should auto-isolate Codex-managed worktrees, instead of
  starting a separate `/tmp/rudder-worktree-preview` instance.
- The change needs packaged Desktop verification; follow the Desktop validation
  workflow in the repo docs.
- The user wants production-like `pnpm prod` behavior rather than a dev preview.

## Default Workflow

### 1. Inspect the current worktree

Start from the repository root and record the current branch:

```bash
git status --short --branch
git branch --show-current
```

Do not switch branches, reset files, or stop unrelated runtimes. A dirty
worktree is normal after implementation work.

### 2. Choose isolated runtime settings

The preview is intentionally temporary and may use a different instance than
the canonical `pnpm dev` runtime for the same worktree. Tell the user this if
they are comparing data between surfaces.

Prefer a branch-derived instance id, a non-default app port, and an isolated
`RUDDER_HOME` under `/tmp`:

```text
RUDDER_INSTANCE_ID=<branch-slug>
PORT=<free-port>
RUDDER_HOME=/tmp/rudder-worktree-preview/<branch-slug>/home
```

Use `3100` only when the user explicitly asks for the default dev runtime and
the port is free. Otherwise choose a free port starting near `3310`.

If the user wants the same data and instance as their normal Codex worktree
development surface, do not use this launcher by default. Start or inspect
`pnpm dev` instead and verify the `/api/health` response matches the expected
worktree-derived instance id.

If embedded PostgreSQL works, use a free
`RUDDER_EMBEDDED_POSTGRES_PORT`. If embedded PostgreSQL fails in the local
environment, use a dedicated external database for this preview instead of
reusing another Rudder instance's database.

### 3. Use the bundled launcher first

From the repo root:

```bash
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh
```

The launcher:

- derives an instance id from the current branch
- finds free app and embedded PostgreSQL ports
- starts `@rudderhq/server` with Vite dev middleware
- uses `tmux` when available, then `launchctl` on macOS
- waits for `/api/health`
- prints the URL, logs, and stop command

Useful options:

```bash
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --replace
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --port 3312
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --database-url postgres://user:pass@127.0.0.1:5432/dbname
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --stop
```

Use `--replace` only for the same branch-derived preview session. Do not kill
ports or process groups that belong to another Rudder worktree.

### 4. Handle startup failures pragmatically

If readiness fails, inspect the managed logs before responding:

```bash
tmux capture-pane -pt rudder-preview-<instance-id> -S -180
tail -180 /tmp/rudder-worktree-preview/<instance-id>/*.log
```

Fix local startup issues that are clearly environmental, such as occupied ports
or missing dependencies. If embedded PostgreSQL fails, create or use an
isolated external database and rerun with `--database-url`; do not point the
preview at the user's main dev data unless they explicitly ask for that.

### 5. Verify readiness

Before handing off, check:

```bash
curl -fsS http://127.0.0.1:<port>/api/health
```

The `instanceId` in the response should match the preview instance id. If it
does not, the URL may belong to another runtime.

For visible UI work, also open the URL in a browser when practical. If browser
automation is unavailable or hangs, say that clearly and still provide the
health-checked URL.

### 6. Hand off the preview

Keep the response short and concrete:

```text
当前分支已经跑起来了：
http://127.0.0.1:<port>

实例：<instance-id>
日志：<tmux attach or log path>
停止：<stop command>
Health check passed.
```

Mention when the preview uses a non-default port because `3100` is occupied.
Mention when the database is isolated or temporary so the user knows what data
they are looking at.

## Cleanup Requests

For cleanup, stop only the managed preview for the current branch:

```bash
bash .agents/skills/maintainer/rudder-worktree-preview-maintainer/scripts/start_current_branch_preview.sh --stop
```

Verify the preview port is free afterward. Do not remove worktrees, delete
databases, or stop other Rudder sessions unless the user explicitly asks.

## Judgment Rules

- Isolation matters more than preserving the default port.
- Do not present this skill as the fix for Codex worktree isolation. That
  belongs in the default `pnpm dev` environment resolution.
- Be explicit when this preview uses a temporary `/tmp` instance that differs
  from the normal `pnpm dev` instance for the same checkout.
- A health-checked URL is the minimum hand-off; logs and a stop command make it
  usable.
- Never stop unrelated Rudder sessions just because they occupy `3100`.
- Do not leave a foreground command running when the user needs a preview after
  the assistant turn ends; use `tmux` or a user-level managed process.
- If the task shifts from previewing to fixing a startup bug, say that and keep
  source edits scoped.
