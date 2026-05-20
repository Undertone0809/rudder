---
name: rudder-desktop-dev-recovery-maintainer
description: >
  Diagnose and recover Rudder local Desktop development startup and update
  failures. Use when `pnpm dev` or the Electron Desktop shell cannot start,
  the API/UI works but Desktop does not, embedded Postgres or `~/.rudder`
  instance state is confusing, a Desktop update/install path fails during local
  validation, or a release is blocked by local Desktop dev/runtime breakage.
  Separates local dev recovery from publishing work, verifies the active
  runtime, preserves unrelated dirty files, and escalates to release-maintainer
  only after local Desktop state is understood.
---

# Rudder Desktop Dev Recovery Maintainer

Use this skill to get the local Rudder Desktop development path back to a known
working state.

This is not the release runbook. It is the recovery layer for local Desktop
startup, dev-shell runtime, embedded database state, update/install smoke, and
the handoff point before release work.

## Use When

Use this skill for prompts like:

- "`pnpm dev` 好像桌面端跑不起来了"
- "Desktop dev shell 起不来"
- "API 能访问，但桌面端没起来"
- "embedded Postgres / `~/.rudder` 状态是不是乱了"
- "update 最新版失败，先 debug 一下"
- "桌面端问题修完之后再发版"
- "我本地 Desktop 是不是指到错的 instance"

Also use this when a release request is blocked by local Desktop validation.
Fix the local Desktop blocker first, then route the release to
`release-maintainer`.

## Do Not Use When

Do not use this skill for:

- npm/GitHub Release/tag/dist-tag publishing; use `release-maintainer`
- packaged-app verification after code changes with no startup failure; follow
  the normal Desktop validation workflow
- stopping only a known repo-local dev runtime; use
  `stop-rudder-dev-maintainer`
- ordinary web UI data diagnosis; use `rudder-data-path-diagnostician-maintainer`
- review-only of a Desktop feature; use `agent-work-reviewer-maintainer`

If the user's first request is "发版" and Desktop is already healthy, do not
route through this skill.

## Default Workflow

### 1. Classify the failure mode

Start with a short state packet:

- `git status --short --branch`
- requested command, for example `pnpm dev`, `pnpm desktop:dev`, or
  `pnpm desktop:verify`
- whether the failure is API server, Vite middleware, Electron shell, embedded
  Postgres, packaged smoke, update download, or app launch
- exact stderr/stdout excerpt and exit code
- currently listening ports around `3100`
- relevant `~/.rudder/instances/*` path when the process prints one

Do not guess from memory when the command can be rerun safely.

### 2. Read the local Desktop contract

Read only the relevant docs and scripts:

- `doc/DEVELOPING.md`
- `doc/DESKTOP.md`
- `doc/README.md` for navigation when needed
- `desktop/package.json`
- root `package.json` scripts
- `desktop/scripts/smoke.mjs` for packaged-smoke expectations
- `scripts/prod-desktop.mjs` only when the failure is prod-local or installer
  related

When docs and scripts disagree, scripts are the executable truth for the active
diagnosis. Record the mismatch as a docs follow-up if it matters.

### 3. Verify the active runtime before repairing

Check the local server and org list when the API is expected to be running:

```bash
curl -sS http://127.0.0.1:3100/api/health
curl -sS http://127.0.0.1:3100/api/orgs
```

If the Desktop shell is pointed at another base URL, use that URL instead.

Common causes to distinguish:

- no server process is running
- wrong port or stale process owns the port
- embedded Postgres failed to initialize
- dev server is up but Electron did not launch
- Electron launched but cannot reach the server
- Desktop profile or instance id points to unexpected data
- update metadata resolves but asset download/checksum/install fails
- packaged smoke differs from dev-shell behavior

### 4. Repair narrowly

Prefer the smallest repair that matches the cause:

- stop only the repo-local stale process when it blocks the port
- reinstall dependencies only when package state or lockfile evidence points
  there
- fix script/config code when the failure is reproducible from a clean command
- reset `~/.rudder/instances/dev` only when the user accepts data loss or the
  instance is disposable and the task explicitly targets dev state
- keep release publishing untouched until local Desktop state is green

Do not delete `~/.rudder`, change npm auth, move GitHub dist-tags, or install a
new app globally as a "dev recovery" shortcut.

### 5. Validate the right path

Validation depends on what failed:

- dev server/API: health and org API calls
- Desktop dev shell: launch evidence plus logs that the shell reached the API
- packaged startup, profile isolation, migrations, installer assets, or
  prod-local data path: `pnpm desktop:verify`
- update/download path: dry-run is not enough when the issue is download,
  checksum, extraction, or launch; run the strongest safe non-dry-run local
  check available and state platform limitations

If code changed, run the narrow relevant tests first, then the repo baseline
when feasible:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

For Desktop startup, migration, profile routing, or packaging changes, do not
claim done without packaged verification or an explicit blocker.

### 6. Handoff or escalate

If the user also asked to release after recovery:

1. finish the local Desktop repair
2. record validation evidence
3. route the release portion to `release-maintainer`

Keep the handoff concrete:

```markdown
Root cause: ...

Repair:
- ...

Validation:
- ...

Next route:
- release-maintainer for version ...
```

## Common Failure Modes

- Treating local `pnpm dev` breakage as a release problem before reproducing the
  local command.
- Resetting `~/.rudder` too early and losing the user's useful local state.
- Looking only at API health when the Electron shell is the broken layer.
- Looking only at Electron logs when embedded Postgres never started.
- Claiming update install is fixed from a dry-run that never downloads or
  launches the app.
- Mixing unrelated dirty package changes into a Desktop recovery commit.

## Safety Rules

- Preserve unrelated dirty worktree files.
- Do not destroy local Rudder data without explicit authorization.
- Do not publish, tag, move dist-tags, or create GitHub Releases from this
  skill.
- Prefer exact command output and log excerpts over guesses.
- If the fix changes Desktop startup, profile routing, migrations, packaging,
  or update behavior, require packaged verification before final handoff unless
  blocked.
