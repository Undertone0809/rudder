---
title: CLI Start Install Progress
date: 2026-04-29
kind: implementation
status: completed
area: deployment
entities:
  - cli_start
  - desktop_release
issue:
related_plans:
  - 2026-04-27-unified-npx-portable-desktop-install.md
  - 2026-04-24-release-desktop-npm-distribution.md
supersedes: []
related_code:
  - cli/src/commands/start.ts
  - cli/src/utils/progress.ts
  - cli/src/__tests__/start.test.ts
commit_refs: []
updated_at: 2026-04-29
---

# CLI Start Install Progress

## Goal

Make `rudder start` visibly move during the Rudder-managed install stages so a
first-run operator can distinguish a large Desktop download from a hung install.
The initial `npx` package fetch remains npm-controlled and out of scope for this
change.

## Decisions

- Add an internal CLI progress helper with no new dependency.
- Show determinate progress for HTTP downloads when `Content-Length` is known.
- Fall back to transferred byte counts when the download size is unknown.
- Use clear phase status for npm global install, checksum verification, Desktop
  replacement, extraction/copy, launcher creation, and launch.
- Keep non-TTY output stable and free of cursor-control sequences.

## Implementation Notes

- Update Desktop checksum and asset downloads to report progress.
- Keep existing `rudder start` flags and behavior compatible.
- Unit-test progress formatting and non-TTY behavior.
- Cover the mocked download path so checksum and Desktop asset downloads emit
  progress updates.

## Validation

- Passed: `pnpm exec vitest run cli/src/__tests__/start.test.ts`
- Passed: `pnpm --filter @rudderhq/cli typecheck`
- Passed: `pnpm rudder start --dry-run --no-version-check --no-open`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm test:run`
- Passed: `pnpm build`
