---
title: Simplify local dev command surface
date: 2026-04-14
kind: plan
status: planned
area: developer_workflow
entities:
  - developer_commands
  - desktop_shell
  - dev_runtime
issue:
related_plans: []
supersedes: []
related_code:
  - scripts/dev-shell.mjs
  - doc/DEVELOPING.md
commit_refs: []
updated_at: 2026-04-17
---

# Simplify Local Dev Command Surface

## Summary

- Collapse the public local development command surface around two top-level commands:
  - `pnpm dev`: Desktop + non-watch `dev` runtime
  - `pnpm dev:watch`: Desktop + watched `dev` runtime
- Remove redundant root aliases that exposed low-frequency debugging flows as first-class commands.
- Align development desktop startup with the desktop app defaults by removing the macOS-only forced `opaque` window mode from the dev shell launcher.

## Key Changes

- Root scripts:
  - repoint `dev` and `dev:watch` to `scripts/dev-shell.mjs` with explicit runtime modes
  - remove `dev:resident`, `dev:desktop`, `dev:desktop:resident`, `dev:once`, and `local:prod`
- `scripts/dev-shell.mjs`:
  - parse `dev` vs `watch` mode explicitly
  - launch `scripts/dev-runner.mjs` directly as a private implementation detail
  - keep the runtime-health gate before launching Electron
  - stop forcing `RUDDER_DESKTOP_MAC_WINDOW_MODE=opaque`
- Docs and developer-facing copy:
  - rewrite the main workflow docs around `dev`, `dev:watch`, `prod`, `dev:reset`, and `desktop:verify`
  - replace `local:prod` guidance with `pnpm rudder run`
  - replace `pnpm dev:once` references with `pnpm dev`

## Validation

- `pnpm dev` launches Desktop and the non-watch `dev` runtime.
- `pnpm dev:watch` launches Desktop and the watched `dev` runtime.
- Both development commands continue to target the shared `dev` instance.
- `pnpm prod` remains the packaged installer flow.
- `pnpm desktop:verify` remains the packaged Desktop validation path.
- On macOS, `pnpm dev` and `pnpm dev:watch` no longer override desktop window mode to `opaque`.

## Assumptions

- Resident-shell and desktop-only debugging remain possible through explicit environment variables or package-level commands, but no longer need root-level aliases.
- `pnpm rudder run` is the supported entrypoint for the persistent local `prod_local` runtime.
