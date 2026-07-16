---
title: Two-Day Main Feature Acceptance
date: 2026-07-17
kind: advisory
status: completed
area: developer_workflow
entities:
  - main_integration
  - messenger_chat
  - desktop_update
  - agent_runs
issue:
related_plans:
  - 2026-07-15-inline-visual-artifacts.md
  - 2026-07-16-desktop-update-live-blockers-auto-apply.md
  - 2026-07-16-desktop-prod-startup-diagnostics-fix.md
supersedes: []
related_code:
  - ui/src/pages/Chat.tsx
  - ui/src/pages/Chat.work-manifest.tsx
  - server/src/services/chat-generation-protocol.ts
  - desktop/src/desktop-update-flow.ts
  - tests/e2e/chat-project-empty-heading.spec.ts
  - tests/e2e/chat-inline-visual.spec.ts
commit_refs:
  - c71536c0f
updated_at: 2026-07-17
---

# Two-Day Main Feature Acceptance

## Objective

Prove that work delivered through Codex tasks and production Z Studio Agent
runs on 2026-07-15 through 2026-07-17 is either preserved on `main`, rejected
for a recorded correctness reason, or explicitly tracked as incomplete. This
checklist does not treat a branch, commit message, or prior report as sufficient
proof without current-state evidence.

## Acceptance Baseline

- Remote main: `c71536c0f` (`test(chat): wait for inline visual responsive layout`)
- Clean acceptance worktree: `/private/tmp/rudder-main-acceptance-20260717`
- Shared checkout: intentionally left on its dirty feature branch because other
  tasks are still using it
- Product Logic Registry: 74 active contracts before this acceptance pass;
  no guarded registry edit is part of this advisory

## Status Definitions

- `PASS`: current main plus current automated or black-box evidence proves the
  requested behavior.
- `PARTIAL`: implementation exists, but deployment or required verification is
  incomplete.
- `PENDING`: current-state evidence has not been collected yet.
- `REJECTED`: reviewed change must not enter main in its current form.
- `BLOCKED`: completion requires authorization or an external state change.

## Acceptance Matrix

| Surface | Requested outcome | Main evidence | Runtime evidence | Status |
| --- | --- | --- | --- | --- |
| Project-scoped new Chat UI | Preserve `Use cases / Chats`, the Project label, and old Project chats beyond the global preview limit | `722acf414`, `77b1fae16`; `ui/src/pages/Chat.tsx` | Safe-port Playwright: 1 passed; in-app Browser at 1440x900 showed both tabs and `Long-running launch`; clicking `Chats` showed only `Older launch decision`; console warn/error 0; Vite overlay 0 | PASS |
| Inline Visual reports | Preserve declarative, responsive, durable report rendering and sandbox isolation | `4184dd2f1`, `2acb0d5fa`, `c71536c0f` | Playwright: 1 passed in 26.3s; desktop/mobile/reload, sandbox, and no-external-request assertions passed | PASS |
| Work Manifest height and category headings | Keep expanded content bounded with internal scrolling and preserve Sources/Outputs/References | `6872fd8e2`, `c65eae8ca`, `59d01b531`, `ea7431f4a` | Current-main focused matrix: 46 passed; real Playwright passed desktop and compact bounds, category headings, and internal scrolling | PASS |
| Chat Steer and Stop reliability | Preserve same-action retries and the `closing` to persisted `runtime_output` completion fence | `ada8a8fae` integrated as `dde98496e`; current code keeps `closing` output-admitting until persisted `runtime_output` | Current-main focused matrix: 46 passed across Work Manifest and Steer/Stop files; independent matrix: 535 passed across 29 files | PASS |
| Desktop update live blockers | Block unsafe update/quit paths and expose diagnostics | `a6200bb311e7f5fc2834d66f8915eabc0ba23258` is patch-equivalent to `e55642a0c` | Current-main CLI: 81 passed; Desktop update flow/check/diagnostics/channel: 41 passed; quit/reload and UI status bridge: 28 passed | PASS |
| Desktop production startup recovery | Require a usable exact PostgreSQL payload and preserve allowlisted diagnostics | `8c8cb33be` integrated as `cdbf87e99`; `5f1adfff7` is patch-equivalent to `bf39dd70d` | Current-main CLI startup coverage included in 81 passed; boot/failure/support-mail/embedded PostgreSQL recovery: 16 passed | PASS |
| Side Panel Markdown and previews | Preserve Markdown editing plus image, website, and file preview workflows | Markdown `7428cd6a9`/`4b5665c8a`; image `6f79d3a79`; website `0cf027c4c`/`12b24635c` | Current-main focused UI tests passed; real Playwright passed `chat-side-panel`, HTML preview, and Work Manifest image preview | PASS |
| Production Z Studio Agent runs | Preserve ZST-771 through ZST-776 work and distinguish merged code from deployed production | ZST-771 through ZST-775 commits are in main; ZST-776 slices 2/3 are in main; rejected slice 4 is not | Production is healthy on `0.4.6-canary.11` / `6b4a3cac6`, 119 commits behind main; no new work is deployed; ZST-776 remains active and uncommitted | PARTIAL |
| Desktop rollback candidate | Do not merge a rollback path that can launch side effects before commit or retry failed rollback indefinitely | `9465c36ca` remains outside main | Independent recheck confirmed both P1 defects, weak recovery integrity, and conflict with proposal-only Product Logic | REJECTED |
| Issue title regeneration candidate | Do not merge silent mutation failure or unaudited title mutation | `d4f4499ca` and `6319da96f` remain outside main | Independent recheck found missing error UX and durable activity; branch tip also contains unrelated WIP history | REJECTED |
| Archived-chat bulk delete candidate | Preserve the reviewed implementation without enabling new destructive behavior without an approved contract | `bb386c77e` remains outside main | Implementation has value but needs explicit Product Logic authorization and current-main conflict resolution | BLOCKED |
| Hidden Issue Key candidate | Preserve `ORG.IDENTITY.001` settings migration behavior | `c8136a43d` remains outside main | Candidate removes the required operator-visible Issue Key setting and replaces UI E2E with API mutation | REJECTED |
| Browser MCP parity candidate | Preserve completed browser work without merging incomplete or unreviewed local state | `acae0b04e` and dirty follow-up remain outside main | Current SHA expands 8 tools to 26 against active contracts; owner worktree is still dirty and unreviewed | REJECTED |

## Current QA Evidence

- `/tmp/rudder-main-project-use-cases.png`
- `/tmp/rudder-main-project-chats.png`
- Inline Visual Playwright command:
  `RUDDER_E2E_RUN_ID=main-inline-visual-timing-20260717c pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-inline-visual.spec.ts`
- Project Chat Playwright command used explicit safe ports:
  `RUDDER_E2E_PORT=3319 RUDDER_E2E_DB_PORT=55431 pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/chat-project-empty-heading.spec.ts --grep "keeps project Chats visible"`

## Test Infrastructure Finding

The run-ID port hash can produce Chromium-blocked ports. One otherwise valid
Project Chat run selected port `4045` and failed before page code with
`ERR_UNSAFE_PORT`. The same test passed unchanged on explicit safe port `3319`.
This is an E2E infrastructure defect and must not be reported as a product
failure.

## Z Studio Production Evidence

- Health: `status=ok`, version `0.4.6-canary.11`, instance `default`,
  `localEnv=prod_local`, owner `desktop`, bootstrap `ready`.
- Deployment: tag `canary/v0.4.6-canary.11` resolves to `6b4a3cac6` and is 119
  commits behind this acceptance baseline.
- Database: live PostgreSQL 18.4 on port 54339; the audit session confirmed
  `transaction_read_only=on`.
- Last 48 hours: 133 runs: 117 succeeded, 3 failed, 6 timed out, 6 cancelled,
  and 1 active.
- ZST-771 is `PARTIAL`: code is in main but lacks independent reviewer proof
  and a new-production exact Browser tool runtime check.
- ZST-772 through ZST-775 are `PASS` for code/review and `PARTIAL` for deploy.
- ZST-776 is `PARTIAL / in progress`: slices 2/3 are in main; rejected slice 4
  is not. Its active run and dirty isolated worktree were left untouched.
- The audit used only health GETs, read-only SQL, Git ancestry, and process/log
  inspection. It did not restart, migrate, deploy, or mutate production.

## Repository Verification

- `pnpm lint`: PASS; 1,976 files checked with one documented baseline ignore.
- `pnpm -r typecheck`: PASS after completing workspace dependency links.
- `pnpm product-logic:check`: PASS; 74 contracts valid.
- `pnpm build`: PASS. Existing CSS pseudo-element and large-chunk warnings
  remain non-blocking.
- `pnpm test:run`: 4,358 passed, 9 failed, 2 skipped across 528 files. Seven
  `workspace-runtime` failures and one release guard timeout passed on a
  single-worker rerun: 17 passed. The remaining Feishu long-connection test
  still fails alone because its setup creates a second active generation for
  the same conversation and hits `chat_generations_active_conversation_uq`.
  This is a current-main residual test defect outside the accepted feature
  surfaces; it is recorded rather than hidden or attributed to this advisory.

A `PARTIAL` production row is a truthful terminal result for this read-only
audit; it does not authorize or imply a deployment.
