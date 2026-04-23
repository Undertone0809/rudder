---
name: stop-rudder-dev-maintainer
description: >
  Stop or clean up Rudder local `pnpm dev` processes safely. Use this whenever
  the user asks to stop, restart, kill, or clean the current dev runtime or
  says things like "把 pnpm dev 停了", "重启 dev", "清掉 dev 残留", "把本地开发环境关掉".
  Prefer this skill over ad-hoc `pkill pnpm` so only Rudder repo dev processes
  are targeted.
---

# Stop Rudder Dev Maintainer

Keep Rudder local dev runtime maintenance tight and safe.

The job is usually simple:

- identify the current Rudder dev runtime processes
- stop them gracefully
- confirm whether anything was actually running

Do not broaden that into generic process cleanup for the whole machine.

## Scope

This skill is only for the current Rudder checkout.

It is designed around the repo-root development flow:

```bash
pnpm dev
```

That flow launches `scripts/dev-shell.mjs`, which in turn manages the local dev runner and desktop shell.

## Default Workflow

### 1. Use the bundled script first

From the repo root:

```bash
bash .agents/skills/stop-rudder-dev-maintainer/scripts/stop_rudder_dev.sh
```

Preview only:

```bash
bash .agents/skills/stop-rudder-dev-maintainer/scripts/stop_rudder_dev.sh --dry-run
```

### 2. What the script should target

The script is allowed to stop only repo-local Rudder dev processes such as:

- the root `pnpm dev` / `scripts/dev-shell.mjs` process
- `scripts/dev-runner.mjs`
- the desktop dev Electron process for this repo
- repo-local Rudder dev helper processes that belong to the same runtime

It must not kill unrelated `pnpm`, `node`, `vite`, or Electron work from other repos.

### 3. Verification

After stopping processes, verify with focused checks:

```bash
ps -Ao pid=,command= | rg 'scripts/dev-shell\.mjs|scripts/dev-runner\.mjs|electron/cli\.js dist/main\.js'
lsof -nP -iTCP:3100 -sTCP:LISTEN
```

Use the verification to distinguish these cases clearly:

- nothing was running
- Rudder dev was running and is now stopped
- some targeted processes survived graceful shutdown

## Escalation Rules

- Prefer graceful shutdown with `SIGTERM`.
- If the bundled script reports survivors, show the exact survivors before using a hard kill.
- Use `--force` only when the user explicitly wants a hard stop or when graceful shutdown already failed and the user still wants everything down.
- Never use `pkill pnpm`, `killall node`, or similarly broad commands.

## Restart Requests

If the user asks to restart dev:

1. stop the current Rudder dev runtime with the bundled script
2. verify that the old runtime is gone
3. start the requested dev command
4. report the new process state

Do not assume restart means "kill every local development process".

## Report Format

Reply briefly with:

- whether a running Rudder dev runtime was found
- which process groups were stopped
- whether anything survived graceful shutdown

Example:

```text
已停止当前 Rudder `pnpm dev` 运行时。
关闭了 `scripts/dev-shell.mjs` 和其子进程，`3100` 端口当前没有监听。
```
