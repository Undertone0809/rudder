---
title: Experimental Computer Use
date: 2026-08-10
kind: implementation
status: validated_candidate
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
- Initial accepted platform/runtime: macOS Rudder Desktop with `codex_local`.
  Readiness has explicit macOS, Windows, Linux, and unsupported-platform
  branches, but Windows/Linux action acceptance remains a separate gate.
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

- Branch: `codex/experimental-computer-use`; implementation parent:
  `1e302c5cd4ee0fa8e77602fde7aebe9b0a5b8000` (original branch base:
  `ce0c24db0b76eade825059acf1089d7bc2c3bc39`).
- The implementation candidate contains the dedicated MCP projection, Server
  broker boundary, Desktop lifecycle/Driver adapter, Experimental UI, package
  staging/verifier, typed contracts, and acceptance tests described above.
- The exact accepted local package is
  `/tmp/rudder-cu-real.hsnZE7/Rudder CU Acceptance.app`, bundle ID
  `ai.rudder.desktop.cuacceptance`, arm64, ad-hoc signed. Its package hashes are:
  `main.js` `5f1167db76b1dc7360eaffa696e1d08cb1ff01c9f29adbe7514d3064d8bb4ec3`,
  `computer-runtime.js` `a6265673f4c4a1d65bc5f7b339b0b83d80e896967f8a691bf6d5c92be2e7214f`,
  and `cua-computer-driver.js`
  `38aa2cebd75924bed8e17149202d6b456ef986841a06a55f6104c5ed56bbbb90`.
- The code/package candidate is accepted for commit and push as an
  Experimental, default-off feature. The real Driver-backed macOS path is a
  PASS for this exact local package; production signing and Windows/Linux are
  not covered by this receipt.

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
- Final focused Computer Use regression: 42 tests across 7 files passed.
- Final Experimental Computer Use Playwright regression: 2 tests passed,
  including the 13-tool dedicated MCP surface and `launch_app` projection.
- `codesign --verify --deep --strict` passed for the exact acceptance app.

### UI evidence

- E2E mock-ready light:
  `tests/e2e/test-results/experimental-computer-use--ac8cd-thout-adding-a-new-workflow-chromium/experimental-computer-use-light.png`.
- E2E mock-ready dark:
  `tests/e2e/test-results/experimental-computer-use--ac8cd-thout-adding-a-new-workflow-chromium/experimental-computer-use-dark.png`.
- A real isolated Desktop instance used `RUDDER_HOME` under
  `/tmp/rudder-cu-real.hsnZE7`, API port `3300`, and PostgreSQL port `54349`.
  It enabled the experiment, obtained macOS Accessibility and Screen Recording
  readiness, registered the Desktop broker, and exposed the Agent capability.
- The real path was `Agent -> rudder-computer MCP -> Server -> Broker -> Desktop
  CUA Driver`. Chat `f72909a1-e350-41d6-bc15-c630928f648b`, Run
  `5232712e-4751-40fe-b3e2-5c476a7ab3de`, and Agent
  `8520c4f1-5b3d-4637-8be5-69ad800eec60` launched Calculator PID `24574`,
  window `21155`, and produced visible result `711`.
- The action consumed observation `76e88dbd-d40c-4565-a2d2-2d95f9ec404b`;
  reuse was rejected as `computer_stale_observation`. Fresh observation
  `d2928aaa-d929-4105-b698-1ffcb8f4e93e` succeeded. Screenshot observation
  `e77fcd32-f4ae-4165-adcf-8156e579769b` returned non-empty `image/png`
  content with no base64 in text or structured output.
- `stop` returned `stopped: true`; the last pre-stop observation
  `54bab4db-b167-4ab5-bdce-de3d571ac44f` was rejected after Stop. Disabling
  the Experimental toggle unregistered the broker, and the authenticated
  readiness endpoint returned
  `{ enabled: false, desktopConnected: false, supported: true }`.

### Honest residual boundary

- This is an exact local development-package receipt. The app is ad-hoc signed
  (`TeamIdentifier=not set`) rather than Developer ID signed/notarized, so it
  does not prove the production permission identity survives distribution.
- macOS uses explicit permission preflight, request, and Screen Recording
  settings actions. Windows and Linux report driver readiness without macOS
  permission prompts; their real target/action/Stop behavior still requires
  independent packaged acceptance on each OS. Other platforms fail closed as
  unsupported.
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
branch. The exact ad-hoc signed macOS package passed real Agent-to-app action,
freshness, screenshot, Stop, and disconnect acceptance. Do not treat this as
production signing/notarization or Windows/Linux acceptance, and do not
graduate the experiment on this receipt alone.
