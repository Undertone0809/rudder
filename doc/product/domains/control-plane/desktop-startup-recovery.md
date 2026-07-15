---
title: Desktop Startup Recovery
domain: control-plane
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - CONTROL.DESKTOP.STARTUP.RECOVERY.001
related_code:
  - desktop/src/boot-screen.ts
  - desktop/src/boot-preload.ts
  - desktop/src/desktop-startup-failure.ts
  - desktop/src/desktop-support-mail.ts
  - desktop/src/main.ts
related_tests:
  - desktop/src/boot-screen.test.ts
  - desktop/src/desktop-startup-failure.test.ts
  - desktop/src/desktop-support-mail.test.ts
  - desktop/scripts/smoke.mjs
related_plans:
  - doc/plans/2026-07-15-desktop-startup-loading-recovery.md
edit_policy: user_confirmed_only
---

# Desktop Startup Recovery

## CONTROL.DESKTOP.STARTUP.RECOVERY.001

## Contract Summary

Rudder Desktop presents managed local startup as a quiet branded transition.
Healthy startup shows the Rudder mark and motion without stage text, fake
progress, runtime metadata, local paths, or recovery controls. Recovery content
appears only after managed local server startup reports a failure.

The failure surface keeps the operator in the startup window, prioritizes a
single retry, and offers an editable support-email draft plus progressively
disclosed technical details. Rudder never sends mail or uploads local data
without the operator.

## Intent / User Job

The operator should be able to wait for an ordinary startup without reading an
internal diagnostic console. When startup actually fails, the operator should
understand what happened, retry safely, and prepare a useful support request
without exposing credentials or private workspace data.

## Why / Design Reasoning

Healthy startup is a waiting state with no operator decision, so technical copy
creates noise without improving control. Failure is the point where diagnosis
and recovery become useful. Main-owned, allowlisted diagnostics also reduce the
trust placed in a renderer that is active before the normal application loads.

## Actors / Objects / State

- Actors: Desktop operator and Desktop main process.
- Objects: boot window, managed local runtime attempt, startup failure record,
  support draft, and technical disclosure.
- States: quiet loading, managed startup failed, retry in flight, and support
  draft open/fallback available.

## Entry Points / Inputs

- Desktop managed-local startup.
- A startup-stage update owned by the main process.
- A managed startup exception.
- Operator actions: `Try again`, `Email support`, technical disclosure, copy
  diagnostics, and open data folder.

## Product Logic Flow

1. Desktop opens a dedicated boot renderer through a narrow startup preload.
2. While startup remains healthy, the renderer shows only the Rudder identity
   and active motion. Internal startup stages may update state but do not become
   visible status copy or percentage progress.
3. When managed local startup throws, the main process classifies and owns the
   failure state. The same boot window reveals a plain-language summary, `Try
   again`, `Email support`, and collapsed `Technical details`.
4. `Try again` returns the existing window to its quiet loading state and starts
   one restart attempt. Concurrent retry requests coalesce rather than creating
   multiple runtime or window transitions.
5. `Email support` asks the main process to open an editable draft addressed to
   `zeeland4work@gmail.com`. The draft contains only allowlisted, bounded
   diagnostic fields and guidance about useful context and unsafe attachments.
6. If the mail client cannot open, the surface keeps the support address and
   diagnostic-copy fallback available.
7. Technical paths and allowlisted failure metadata remain behind explicit
   disclosure. The original exception stays in the main-process log and never
   enters the boot renderer, copied diagnostic, or support draft.

## Decision Table

| Situation | Expected result | Must not happen |
| --- | --- | --- |
| Healthy startup | Show only Rudder identity and active motion | Show stage copy, paths, fake progress, or controls |
| Managed startup throws | Reveal failure summary, retry, support, and collapsed details in the boot window | Replace the failure with a silent exit or expose unallowlisted exception text |
| Retry clicked repeatedly | Start one restart and return the same window to quiet loading | Start duplicate runtimes or create duplicate windows |
| Email support clicked | Open one editable, bounded draft or expose copy fallback | Send automatically, upload data, or attach private files |
| Reduced motion requested | Keep a recognizable static/low-motion branded state | Require continuous motion to understand failure or recovery |

## Actor-Visible Input

- Healthy startup requires no input.
- Failure presents retry, support email, disclosure, diagnostic-copy, and data
  folder actions with explicit labels.
- Support guidance asks for what the operator was doing, what changed, and
  whether retry behaved differently; it warns against sensitive attachments.

## Operator-Visible Output

- Quiet branded loading during healthy startup.
- A plain-language failure summary only after managed startup failure.
- Visible feedback when retry is running or a mail client cannot be opened.
- Technical details only after explicit disclosure.

## Persisted Evidence

- This presentation adds no server-side product record or automatic telemetry.
- The main process keeps the current failure record in memory for recovery and
  support-draft construction. Existing Desktop/server logs remain governed by
  their owning diagnostics and lifecycle behavior.

## Canonical Scenarios

1. Healthy startup: Rudder shows the branded motion with no text or controls,
   then replaces the boot window with the ready application.
2. Database startup failure: Rudder reveals the recovery surface; the operator
   opens details, copies bounded diagnostics, and retries once in the same
   window.
3. Support request: Rudder opens an editable draft to the support address. If no
   mail client is available, the operator copies the address and diagnostics
   without losing the failure surface.

## Invariants / Non-Goals

- Healthy startup must not expose stage names, profile or instance identifiers,
  filesystem paths, version metadata, technical details, buttons, or fake
  percentage progress.
- Failure actions must remain available without a healthy local API.
- The main process, not untrusted renderer input, owns the failure record used
  for support diagnostics.
- Support drafts are bounded and encoded. They exclude config contents, `.env`,
  databases, credentials, API keys, raw logs, and workspace contents.
- Renderer and copied diagnostics use the same bounded failure-metadata
  allowlist. The original exception is logged by the main process but is not
  copied or rendered.
- Standard cross-client email drafts do not promise automatic attachments.
  Rudder tells the operator what may be useful to add and what must not be
  attached.
- Retry and email actions are single-flight. Repeated clicks must not create
  duplicate restarts, windows, or draft-open requests.
- Loading motion respects reduced-motion preferences. Failure disclosure moves
  focus into actionable recovery content and remains usable with keyboard,
  zoom, light/dark appearance, and constrained window height.

## Drift Boundaries

- This contract covers managed local server startup that resolves or throws. It
  does not add a watchdog for startup work that never settles.
- Renderer-load recovery keeps its separate reload/restart semantics. This
  contract does not claim an initial renderer-load black-box path that the
  current Electron/macOS harness cannot execute reliably.
- Server resource rollback and restart ownership remain governed by
  `CONTROL.SERVER.LIFECYCLE.001`.
- Automatic SMTP sending, support uploads, telemetry, Apple Mail automation,
  and attachment collection require separate product decisions.

Update this contract when Desktop changes healthy boot visibility, failure
classification, retry/window ownership, support-recipient or diagnostic fields,
mail/attachment behavior, technical disclosure, or accessibility guarantees.

## Traceability

- `desktop/src/boot-screen.test.ts` covers healthy-state silence, failure-only
  disclosure, safe DOM rendering, reduced motion, focus, and responsive layout.
- `desktop/src/desktop-startup-failure.test.ts` covers failure classification,
  bounded diagnostics, and retry coordination.
- `desktop/src/desktop-support-mail.test.ts` covers recipient, encoding,
  allowlisting, injection resistance, and mail-client fallback behavior.
- `desktop/scripts/smoke.mjs` covers a real isolated Electron managed-startup
  failure, narrow preload, email IPC, technical disclosure, and coalesced retry.
- Visual QA covers healthy/failure states in light and dark appearance,
  reduced-motion, keyboard focus, constrained height, and 200% zoom.
