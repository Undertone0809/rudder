---
title: Experimental Computer Use
date: 2026-08-10
kind: implementation
status: implemented_candidate
area: desktop
entities:
  - computer_use
  - agent_tools
  - desktop_broker
related_plans:
  - 2026-07-12-built-in-browser.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - server/src/routes/computer.ts
  - desktop/src/computer-runtime.ts
  - ui/src/pages/InstanceExperimentalSettings.tsx
  - tests/e2e/experimental-computer-use.spec.ts
commit_refs: []
updated_at: 2026-08-11
---

# Experimental Computer Use

## Outcome

Give a supported Rudder Agent one additional first-party capability: typed
Computer Use tools. The Agent chooses Computer Use, Browser, connectors, APIs,
or CLI based on the task. The operator manages one default-off Experimental
toggle and sees device readiness; there is no separate workflow or per-action
mutation switch.

## Locked Decisions

- Product contracts: `AGENT.COMPUTER.USE.001` and the existing
  `AGENT.CONTROL.TOOLS.001` projection contract.
- Initial accepted platform/runtime: signed macOS Rudder Desktop with
  `codex_local`; unsupported hosts and runtimes project no Computer Use tools.
- Agent-facing boundary: one Rudder-owned `rudder-computer` MCP server. The
  Agent never connects directly to Cua Driver.
- Trusted boundary: Server derives organization, Agent, and Run identity;
  Desktop owns Accessibility and Screen Recording permission plus Cua Driver.
- Driver: `@trycua/cua-driver` is hidden behind a Rudder `ComputerDriver`
  interface and loaded only after the operator enables the experiment and the
  required permissions are present.
- Confirmation behavior fully inherits the Codex Computer Use taxonomy in a
  versioned runtime instruction. Ordinary actions run directly. Only the named
  rare consequential actions confirm at action time or hand off.
- Third-party UI, pages, files, and documents never grant authorization.

## Delivery Slices

1. Add the default-off instance setting, health projection, Desktop readiness,
   and one Experimental settings row.
2. Add typed Computer Use contracts and runtime instruction to the dedicated
   MCP surface, projected only for an eligible run.
3. Add authenticated Server broker registration, live setting/run checks,
   bounded forwarding, and content-free activity records.
4. Add Desktop broker lifecycle, Cua adapter, run sessions, short-lived
   observations, stale-target rejection, Stop, and cleanup.
5. Prove the toggle, tool projection, run isolation, stale observation,
   sensitive audit redaction, Stop, Desktop disconnect, and real macOS path.

## Acceptance Packet

- Branch: `codex/experimental-computer-use`; implementation base:
  `ce0c24db0b76eade825059acf1089d7bc2c3bc39`.
- The implementation candidate contains the dedicated MCP projection, Server
  broker boundary, Desktop lifecycle/Driver adapter, Experimental UI, package
  staging/verifier, typed contracts, and acceptance tests described above.
- The code/package candidate is accepted for commit and push as an
  Experimental, default-off feature. Real Driver-backed action acceptance is
  still permission-blocked on this machine and is not represented as a PASS.

## Verification Receipt

### Green gates

- `pnpm exec vitest run ...`: 12 focused files, 114 tests passed, including
  strict tool contracts, run ownership, redacted activity, loopback broker,
  lease expiry, single-use stale observations, Stop, lifecycle revoke, Codex
  managed-home MCP injection, UI readiness, CLI MCP projection, and screenshot
  delivery as MCP image content without base64 in structured text.
- `npx playwright test tests/e2e/experimental-computer-use.spec.ts --config
  tests/e2e/playwright.config.ts`: 2 tests passed. The latest run receipt is
  `tests/e2e/test-results/.last-run.json` with `status: passed`.
- `pnpm -r typecheck`: 25 workspace projects passed.
- `pnpm product-logic:check`: 93 contracts valid.
- `pnpm mcp-contract:check`: passed.
- `pnpm lint`: 2,686 files checked; imports organized.
- `pnpm build`: passed; refreshed Shared, Desktop, Server, and UI artifacts.
- Packaged verifier: `Verified packaged Computer Use runtime (arm64).` It
  imports both the Rudder Computer runtime and Cua Driver from a copied system
  temporary directory, so workspace ancestor dependencies cannot make it pass.
- Packaged account-gate smoke and packaged App Builder assets smoke passed.
- `git diff --check`: passed.

### UI evidence

- E2E mock-ready light:
  `tests/e2e/test-results/experimental-computer-use--ac8cd-thout-adding-a-new-workflow-chromium/experimental-computer-use-light.png`.
- E2E mock-ready dark:
  `tests/e2e/test-results/experimental-computer-use--ac8cd-thout-adding-a-new-workflow-chromium/experimental-computer-use-dark.png`.
- A real isolated Desktop instance opened the exact Experimental route with the
  toggle enabled, showed `Accessibility and Screen Recording access are
  required`, and exposed `Grant access`. The Server readiness endpoint returned
  `{ enabled: true, desktopConnected: false, supported: true }`.
- Because the real UI hid the `Open Screen Recording settings` action while
  showing `Grant access`, the Desktop readiness state was Screen Recording
  present and Accessibility absent. The app correctly kept the broker
  disconnected rather than projecting an action-ready capability.

### Honest residual boundary

- No real `rudder_computer_*` Driver action was executed through the packaged
  app because granting Accessibility changes a security-sensitive macOS system
  permission. The permission was not changed during automated acceptance.
- The real action sequence (list apps/windows, observe exact window, ordinary
  action, stale refusal, fresh observation, Stop, disconnect/lease expiry) is
  covered by focused runtime/broker tests, but remains pending one signed-app
  run after the operator grants Accessibility.
- A full `pnpm desktop:verify` invocation was not a single green receipt. The
  first run found and led to fixing the `@rudderhq/shared/computer-use` packaged
  runtime export; a later full dev smoke competed with another App Builder
  runner and timed out on readiness. After the fix, Shared/Desktop builds,
  Desktop Computer Use tests, the final macOS `.app`, package verifier,
  packaged account-gate smoke, and packaged App Builder assets smoke all passed
  independently.
- Full-repo `pnpm test:run` is not claimed as green: concurrent machine load
  produced broad unrelated timeout/readiness and PostgreSQL teardown noise.
  Focused Computer Use tests and its E2E completed independently and passed.

## Review Verdict

Manual review found and fixed two candidate defects before commit:

1. Electron runtime resolution of `@rudderhq/shared` reached source-only
   imports, and electron-builder initially omitted Shared from the final app
   even though staging contained it. The exact
   `@rudderhq/shared/computer-use` subpath now resolves runtime to built
   JavaScript; Shared plus Zod are copied into the final app; the verifier
   imports the isolated runtime rather than resolving through the worktree.
2. Driver screenshots initially crossed the MCP boundary as JSON base64 text.
   The dedicated Computer MCP surface now emits standard image content blocks
   and excludes image bytes from text and `structuredContent`.
3. The first runtime instruction over-confirmed ordinary deletion,
   communication, and financial actions. It now faithfully preserves the Codex
   four-level confirmation taxonomy: hand-off, action-time confirmation,
   specific pre-approval, and no-confirmation ordinary actions.

Verdict: accept the code/package candidate for the default-off Experimental
branch. Keep real Driver action acceptance explicitly pending until the signed
Rudder app has Accessibility permission; do not graduate, merge, or release on
this receipt alone.
