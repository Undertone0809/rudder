---
name: stop-rudder-dev-maintainer
description: >
  Stop or clean up Rudder local `pnpm dev` processes safely. Use this only
  when the user's current task is specifically about stopping, restarting,
  killing, or cleaning the repo-local development runtime, including phrases
  like "把 pnpm dev 停了", "重启 dev", "清掉 dev 残留", "把本地开发环境关掉".
  If this skill is mentioned alongside an unrelated production data, database,
  organization, or packaged Desktop task, treat it as an optional preflight at
  most: run the bundled stop script once only if the user explicitly asked to
  stop dev, then continue with the real task. Prefer this skill over ad-hoc
  `pkill pnpm` so only Rudder repo dev processes are targeted.
---

# Stop Rudder Dev Maintainer

Keep Rudder local dev runtime maintenance tight and safe.

The job is usually simple:

- identify the current Rudder dev runtime processes
- stop them gracefully
- confirm whether anything was actually running

Do not broaden that into generic process cleanup for the whole machine.

## Fast Applicability Check

Before doing any process or port investigation, classify the user's current
task:

- Use the full workflow when the task is about the repo-local development
  runtime, such as stopping or restarting `pnpm dev`.
- If the task is mainly about production/local-prod data, packaged Desktop,
  organizations, database cleanup, backups, migrations, or API maintenance,
  this skill is not the main workflow. Do not spend time inspecting broad
  process lists for those tasks.
- If the user explicitly included this skill as a safety preflight for a
  non-dev task, run only the bundled script once, report whether it found a
  `pnpm dev` runtime, and move on.

Packaged Desktop, `pnpm prod`, `pnpm rudder run`, and embedded Postgres owned by
`/Applications/Rudder.app` are out of scope. Leave them running unless the user
explicitly asks to stop the production/local-prod runtime.

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

If the script prints `No matching Rudder dev processes found.`, stop the skill
workflow there unless the user's request is specifically to diagnose why dev is
still running. Do not follow with broad `ps`, `lsof`, or app-process searches
just because another Rudder process exists.

### 2. What the script should target

The script is allowed to stop only repo-local Rudder dev processes such as:

- the root `pnpm dev` / `scripts/dev-shell.mjs` process
- `scripts/dev-runner.mjs`
- the desktop dev Electron process for this repo
- repo-local Rudder dev helper processes that belong to the same runtime

It must not kill unrelated `pnpm`, `node`, `vite`, or Electron work from other repos.
It must not stop packaged Desktop or local production runtime processes.

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

Run these verification checks after the script stops something or reports
survivors. For a simple "nothing was running" result, the script output is
enough unless the user asked for a deeper diagnosis.

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
