---
title: Desktop Startup Loading and Recovery
date: 2026-07-15
kind: proposal
status: completed
area: desktop
entities:
  - desktop_startup
  - startup_recovery
  - support_diagnostics
issue:
related_plans:
  - 2026-04-12-settings-about-page.md
  - 2026-04-13-desktop-shell-design-language-guardrails.md
  - 2026-07-13-runtime-supervisor-resource-lifecycle.md
supersedes: []
related_code:
  - desktop/src/boot-screen.ts
  - desktop/src/boot-preload.ts
  - desktop/src/desktop-startup-failure.ts
  - desktop/src/desktop-support-mail.ts
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - desktop/src/desktop-update-flow.ts
  - desktop/src/boot-screen.test.ts
  - desktop/scripts/smoke.mjs
commit_refs: []
updated_at: 2026-07-15
---

# Desktop Startup Loading and Recovery

## Overview

Replace the current diagnostic-heavy Desktop boot screen with a quiet branded
startup experience and a failure-only recovery surface. A healthy startup shows
only the Rudder identity and motion. It does not show `Starting Rudder`, phase
labels, runtime metadata, filesystem paths, or recovery actions.

When managed local server startup fails, the same window expands into a compact recovery surface. It
prioritizes retry, explains how to email useful support information to
`zeeland4work@gmail.com`, and keeps technical diagnostics behind explicit
disclosure. The email action opens an editable draft and never sends mail
silently.

## What Is The Problem?

The existing boot screen treats every startup as a diagnostic session. It
renders profile, instance, runtime details, and four filesystem paths before the
operator has a problem to solve. The large nested panel, pills, gradients, and
competing actions make startup feel like an internal maintenance console rather
than the entrance to a calm operator tool.

The current failure state also leaves support work fragmented. The operator can
restart or copy a path, but the screen does not explain what information makes a
support email useful, what must not be shared, or that the mail client opens an
editable draft rather than sending automatically.

This is primarily an information-architecture and recovery-flow problem. Motion
is the visible expression of the fix, not the product decision by itself.

## First-Principles Design Goals

1. Healthy startup requires no operator decision, so it should expose no
   operator controls or technical detail.
2. Motion must prove that the app is alive without pretending to measure
   unpredictable database and migration work.
3. Failure must answer three questions in order: what happened, what should I do
   now, and what can I share if recovery still fails?
4. A failed startup must remain useful even when the local server never became
   healthy and no full server log exists.
5. Support collection must minimize disclosure. Guidance should prefer a small
   generated diagnostic summary over config files, `.env`, databases, or whole
   workspaces.
6. The operator remains the sender. Rudder may prepare a draft and copy useful
   diagnostics, but it must not send mail or upload local data without an
   explicit future product decision.

## What Will Be Changed?

- Redesign `createBootScreenHtml()` as two mutually exclusive visual states:
  quiet startup and expanded startup failure.
- Keep all existing real boot events internally, but do not render stage names,
  messages, details, metadata, paths, or actions during a healthy startup.
- Reuse the existing Desktop icon as a data URL and derive motion from its
  circular heading-arrow form. Do not add orbiting particles, a generic atom
  loader, a new animation dependency, or fake percent.
- Respect `prefers-reduced-motion` with a static branded mark and non-moving
  state treatment.
- On `stage === "error"`, reveal a compact failure panel in the same window with
  one primary action (`Try again`), an `Email support` action, and a native
  disclosure control for technical details.
- Prefill the support draft with a concise main-process-owned failure summary
  derived from the current boot state, app version, platform, architecture,
  attempt count, and failure id.
- Add visible guidance asking for only the human context Rudder cannot know:
  what the operator was trying to do and what changed before the failure.
- Add a warning not to attach `.env`, `config.json`, databases, credentials, API
  keys, or private workspace files.
- Keep `Open data folder` and `Copy diagnostic` as secondary technical recovery
  actions inside the disclosed details rather than the default surface.
- Extend automated coverage for markup safety, failure-only disclosure, email
  draft construction, IPC routing, and rendered interaction states.

## Success Criteria For Change

- A non-error boot screenshot contains no visible startup copy, phase label,
  profile, instance, runtime mode, version, filesystem path, or button.
- The healthy loading composition remains visibly active without layout shift at
  the supported Desktop minimum window size.
- Reduced-motion mode removes continuous transforms while retaining a clear
  branded loading state, a visually hidden one-time status announcement, and
  discrete state changes when real boot events arrive.
- A startup error reveals one plain-language heading, retry and email actions,
  and a collapsed technical-details control.
- Technical paths and raw error text are absent until the operator opens the
  details disclosure.
- The email action opens a draft addressed to `zeeland4work@gmail.com` with a
  bounded subject and body. It does not send automatically.
- The support surface tells the operator what to add and what sensitive material
  not to attach.
- Startup retry returns the same window to the quiet loading state without
  creating another window.
- Concurrent retry and email clicks are coalesced in the main process.
- Light mode, dark mode, keyboard focus, reduced motion, and long diagnostic text
  pass rendered verification.
- Packaged Desktop boot verification passes.

## Out Of Scope

- Fake percentage progress or estimates.
- A visible `Starting Rudder` label or rotating technical phase copy.
- Automatic email sending, SMTP credentials, a hosted support-upload endpoint,
  or silent telemetry.
- Cross-client automatic attachments. Standard `mailto:` does not provide a
  reliable attachment contract across Apple Mail, Outlook, Spark, and web mail.
- Apple Mail automation through AppleScript in this iteration.
- Attaching raw logs, `.env`, `config.json`, the embedded database, crash dumps,
  or workspace contents.
- Detecting or cancelling a managed startup operation that never settles. This
  is an existing lifecycle gap that needs a rollback-safe watchdog design under
  `CONTROL.SERVER.LIFECYCLE.001`; this proposal handles explicit rejection only.
- Failures before the boot window and IPC registration exist, including some
  environment and Browser-profile initialization failures. This iteration
  guarantees recovery for managed local server startup after the boot window is
  available.
- Electron load/crash/unresponsive recovery and the React `AppErrorBoundary`.
  Their primary actions and state semantics differ and remain a separate
  recovery-unification project.
- Changing server startup, rollback, database ownership, or cleanup semantics.

## Non-Functional Requirements

- **Performance:** the boot page remains self-contained, dependency-free, and
  fast to parse from a `data:` URL. Animate only transform and opacity.
- **Availability:** all failure actions work without a healthy local API.
- **Security:** use a narrow boot preload; accept intent-only recovery IPC;
  construct diagnostics from main-owned state; encode mailto fields with
  `URLSearchParams`; render diagnostics with `textContent`; do not put secrets
  or full config contents in the draft.
- **Maintainability:** share one support draft builder between About feedback and
  startup recovery rather than adding an unrelated mail path.
- **Accessibility:** preserve native macOS chrome and its safe area, page-level
  scrolling, visible keyboard focus, semantic buttons/details, a one-time
  visually hidden loading status, an announced/focused failure state, and
  reduced-motion behavior across loading, reveal, hover, and disclosure.
- **Observability:** preserve the original startup error for technical details
  and copying while keeping it out of the initial visual hierarchy.

## User Experience Walkthrough

### Healthy startup

1. Rudder opens the Desktop window with its normal tinted shell background.
2. A centered Rudder mark animates as an active control point. There is no
   visible status text.
3. Real startup stages do not change the animation cadence or imply progress.
   They may update the visually hidden accessibility state without resizing the
   layout or revealing technical language.
4. When the board is ready, the boot window is replaced by the board window as
   today.

### Startup failure

1. Active motion settles and the composition shifts into a failure state.
2. The surface reveals `Rudder could not start` plus a short recovery sentence.
3. `Try again` is primary. Activating it immediately restores the quiet loading
   state while the existing restart flow runs.
4. `Email support` opens an editable draft addressed to the maintainer with a
   bounded diagnostic summary. Main-process single-flight prevents duplicate
   handoffs.
5. Guidance beside the action asks the operator to add what they were doing and
   what changed before the failure. Attempt and retry context are automatic.
6. `Technical details` remains collapsed. Opening it reveals failure stage,
   profile, instance, version when available, instance path, and sanitized raw
   error text, plus `Copy diagnostic` and `Open data folder`.

### Mail client unavailable

1. Rudder reports that it could not hand the draft to the operating system.
2. The operator can copy the support email address and diagnostic summary from
   the failure surface.

## Implementation

### Product Or Technical Architecture Changes

- Add a typed main-process `InternalStartupFailure` and a separate renderer-safe
  recovery view model. The raw cause never enters the boot renderer or mailto.
- Extract a typed, pure `createSupportMailtoUrl()` helper from the update module.
  It uses a fixed recipient/subject grammar, rejects header controls, and keeps
  the encoded URL within a bounded length.
- Add a dedicated boot preload that exposes only state subscription, retry,
  support-draft, fixed-address copy, safe-diagnostic copy, and instance-folder
  intents. It does not expose Browser, update, arbitrary path, or arbitrary
  clipboard APIs.
- Keep mail and recovery payload construction in main. The boot renderer sends
  no path, error, subject, recipient, or body.
- Add sender, top-level frame, current-state, single-flight, and cooldown guards
  to recovery IPC.
- Add a main-process retry single-flight and update the existing failure window
  in place before starting another managed local server attempt.
- Keep server lifecycle behavior aligned with `CONTROL.SERVER.LIFECYCLE.001`.
  This proposal changes presentation and support recovery only.

### Breaking Change

No API, database, storage, runtime, or public CLI contract changes are planned.
The visible boot-screen presentation changes intentionally.

### Design

- The outer window is the shell backdrop, not a giant bordered parent card.
- Healthy loading has one visual focal point and no nested cards.
- The motion loop uses a stable fixed-size composition so phase changes cannot
  shift layout. The circular icon remains visually anchored while its heading
  arrow performs a restrained `6-10deg` correction and return over a fixed
  `1800-2200ms` cadence. It does not spin continuously or emit particles.
- Failure uses neutral surfaces with one restrained semantic error accent.
- Buttons use the repository's compact-radius language rather than pills.
- The details disclosure uses native semantics and stays closed by default.
- Failure transition duration stays within the existing `220-360ms` panel
  guidance; continuous loading motion uses the existing `1400-2600ms` range.
- The page scrolls vertically when needed and reserves macOS hidden-inset chrome
  space. At `1080x720`, 200% zoom, long paths, and a 2KB safe diagnostic, every
  action remains reachable by scrolling and keyboard.
- Light and dark modes use an explicit full-window tint. The failure sheet is
  more opaque and paper-like than the shell. `prefers-contrast: more` and forced
  colors retain structure and focus without relying on translucent borders.

### Security

- No new dependency, endpoint, remote API, or temporary diagnostic bundle is
  introduced.
- The draft whitelist is limited to app version, platform/architecture,
  timestamp, failure id/category/stage, attempt count, and profile/instance
  identifiers. It contains no raw error, URL, path, stack, or log.
- The draft omits config contents, environment contents, database contents,
  logs, workspace data, tokens, and credentials.
- All mailto fields are encoded. All boot-page error rendering uses DOM text
  assignment rather than HTML interpolation.

## What Is Your Testing Plan (QA)?

### Goal

Prove that healthy startup is visually quiet, failure recovery is actionable
and progressively disclosed, support mail is safe, and packaged boot behavior
is unchanged.

### Prerequisites

- Node.js and existing workspace dependencies.
- An isolated `RUDDER_HOME` and `RUDDER_DESKTOP_USER_DATA_DIR` for Desktop
  smoke and screenshots.
- A real invalid embedded-Postgres startup configuration. No contributor
  config, database, real browser profile, or real mail sending.

### Test Scenarios / Cases

1. Static markup and a real boot-only Electron window assert healthy loading has
   no visible operational metadata or action controls.
2. Error state renders recovery actions while details start closed.
3. Opening details reveals diagnostics; copied output excludes config/env file
   contents and remains bounded.
4. Double-clicking retry produces one main-process attempt and no additional
   window; the original failure window returns to loading before retry work.
5. Email support sends intent only and builds the expected recipient, subject,
   and body without attachment, cc, or bcc parameters. Concurrent intent is
   coalesced and opener rejection exposes fallback actions.
6. HTML/error injection is escaped and mail fields are percent encoded.
7. Light, dark, reduced-motion, high-contrast, keyboard, focus-transfer, and
   overflow checks at `1440x960` and `1080x720`, including 200% zoom.
8. A real isolated startup rejection in development-shell and packaged Desktop
   smoke exercises failure disclosure and retry single-flight.
9. Repository lint, typecheck, test, and build gates.

### Expected Results

Every test confirms failure-only disclosure, one-window recovery, no secret
collection, and no regression to runtime startup or renderer recovery.

### Pass / Fail

Passed for the shipped managed-local-startup scope:

- 21 focused unit tests cover boot markup, safe failure classification,
  diagnostic allowlisting, bounded mailto construction, encoding, and injection
  resistance.
- A real isolated development Electron startup failure covers the narrow boot
  bridge, failure-only disclosure, focus transfer, retry single-flight, email
  preload-to-IPC handoff, safe recipient/parameters, concurrent coalescing, and
  opener-rejection fallback.
- Light, dark, reduced-motion, keyboard, focus, responsive overflow, and 200%
  zoom checks passed. Contrast and forced-colors fallbacks are present in the
  generated boot document.
- Desktop TypeScript compilation, lint, repository typecheck, product-logic
  structural validation, and build passed during implementation.

An additional initial renderer-load black-box probe was not retained as a gate:
Electron 37.10.3 on macOS 26.3.1 exited in native code with
`EXC_BREAKPOINT/SIGTRAP` when a second hidden transparent/vibrant window loaded
either an unreachable URL or missing file, before the JavaScript recovery catch
could run. The implementation still commits global main-window ownership only
after the candidate has loaded its app or recovery document. Renderer recovery
semantics otherwise remain outside this managed startup feature.

## Documentation Changes

- Update `doc/engineering/DESKTOP.md` to document quiet startup, failure-only
  disclosure, email guidance, and attachment limitations.
- Do not edit guarded `doc/product/**` in this iteration without explicit user
  authorization for that registry delta. After implementation, propose a focused
  Desktop startup/recovery contract if the user wants this behavior guarded.

## Open Issues

- Healthy startup uses the icon only. There is no wordmark or visible status
  copy; assistive technology receives one visually hidden status announcement.
- Raw server logs may contain private request context and are therefore excluded.
  A future diagnostic bundle requires a separate redaction and consent design.
- Default mail clients differ in supported mailto body length. The initial draft
  must keep diagnostics concise and leave copying full technical details as a
  separate operator action.

## Adversarial Review Decisions

Three independent reviewers evaluated the proposal from product/state-machine,
visual/accessibility, and Electron/security perspectives before implementation.

Accepted changes:

- main-owned diagnostics and intent-only IPC
- a narrow boot preload and bounded typed mail helper
- retry and mail single-flight guards
- a renderer-safe failure view model with no raw stack in mail
- motion derived from the existing circular heading-arrow icon
- explicit VoiceOver, focus-transfer, reduced-motion, contrast, scroll, zoom,
  and macOS chrome-safe-area behavior
- real isolated Electron failure recovery in automated smoke coverage
- automatic technical mail fields with only two human-context prompts

Deferred with explicit rationale:

- A never-settling startup watchdog requires cancellation and rollback semantics
  under the guarded server lifecycle contract. This presentation change must not
  invent a timeout that marks failure while owned startup work is still active.
- Electron renderer crash, unresponsive, and React render failures retain their
  existing recovery semantics. Unifying those paths is wider than this startup
  feature and would require separate E2E coverage and product review.
- Pre-window bootstrap failures remain outside this pass because recovering them
  requires reordering Browser-profile and environment initialization around a
  dedicated early shell. The current scope is named precisely rather than
  claiming complete startup-failure coverage.
