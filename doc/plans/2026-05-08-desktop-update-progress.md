---
title: Desktop Update Progress
date: 2026-05-08
kind: proposal
status: proposed
area: desktop
entities:
  - desktop_release
  - desktop_settings
  - desktop_update_progress
issue:
related_plans:
  - 2026-05-01-desktop-update-button-flow.md
  - 2026-05-06-desktop-update-channel-setting.md
  - 2026-04-29-cli-start-install-progress.md
  - 2026-04-24-release-desktop-npm-distribution.md
supersedes: []
related_code:
  - desktop/src/main.ts
  - desktop/src/preload.ts
  - cli/src/commands/start.ts
  - cli/src/utils/progress.ts
  - ui/src/pages/InstanceAboutSettings.tsx
  - ui/src/lib/desktop-shell.ts
  - doc/DESKTOP.md
commit_refs:
  - docs: propose desktop update progress
updated_at: 2026-05-08
---

# Desktop Update Progress

## Overview

Rudder Desktop already lets an operator check for an update and start the
Rudder-managed portable replacement flow from the About page, startup prompt, or
macOS application menu. The missing piece is observability after the operator
chooses Update.

This proposal adds a first-class Desktop update progress session. The UI should
show a compact update status card with truthful progress: determinate
percentage only while bytes are being downloaded, phase-based status for
resolution, checksum verification, replacement, launcher refresh, and relaunch,
and explicit waiting state when active agent runs delay replacement.

Decision update, 2026-05-14:

- Default app-wide surface uses the compact bottom-right status card direction
  (`Quiet Toast Card`). This is the normal operator experience across Dashboard,
  Messenger, Issues, and other work surfaces.
- Settings > About may show the more detailed installer-panel direction when
  update progress exists. That panel is treated as a development/debugging and
  explanation surface, not the default global update UI.
- The default card should stay lightweight. The detailed Settings surface may
  show phase list, byte counts, active-run waiting, and failure details.
- The compact card's downloaded/verified state is the `Status Capsule + Final
  Confirm` direction: after the progress finishes, the card becomes an explicit
  `Restart to update` action. Replacement must not begin before that final
  confirmation.

## What Is The Problem?

Current state:

- The About page can discover a newer stable or canary release and expose an
  Update button.
- The Electron main process starts the bundled CLI portable replacement flow for
  the selected version.
- The update child process is detached and ignores stdio, so the renderer only
  receives the initial `started`, `waiting`, `blocked`, `unavailable`, or
  `failed` result.
- The CLI already has phase and byte-level progress for its interactive `start`
  flow, but that progress is not available to Desktop UI.

Problem:

- After clicking Update, the operator cannot tell whether Rudder is resolving
  the release, downloading a large asset, verifying the checksum, waiting for
  active runs, preparing to restart, or failing.
- A generic spinner or fake progress bar would make the surface look active
  without making it more trustworthy.
- Active-run deferral is especially ambiguous because it is intentional safety
  behavior, not a stalled update.

Impact:

- Operators lose confidence during the riskiest lifecycle action in the app.
- Failed or slow downloads are hard to distinguish from a hung installer.
- The existing update flow feels less complete than the CLI flow it delegates
  to, even though the underlying installer already has useful state.

## What Will Be Changed?

- Add a Desktop update session concept for in-app updates.
- Add a structured progress channel from the CLI `start` installer to Electron.
- Add Electron IPC for renderer subscription to Desktop update progress.
- Add a global bottom-right update status card after Update is started.
- Update the About page to render a more detailed progress/debug panel when an
  update session is active.
- Reuse the same progress session for update actions started from startup and
  the macOS Check for Updates menu where practical.
- Keep old result shapes compatible while adding an optional update session id.
- Document the observable update phases in `doc/DESKTOP.md`.

## Success Criteria For Change

- Clicking Update produces immediate visible feedback in a global bottom-right
  status card.
- Settings > About can show a higher-density phase breakdown for debugging or
  explanation.
- Download phases show real byte-backed progress when total size is known.
- Unknown-size downloads show transferred bytes without pretending to know a
  percentage.
- Non-download phases show clear step labels, not fake percentages.
- Active agent runs produce a clear waiting state with the number of active
  runs.
- Failure states name the failed phase and offer Retry plus Open Releases.
- The UI remains compact and consistent with Settings density.
- Browser and dev-shell environments continue to fall back safely without
  claiming in-app install support.

## Out Of Scope

- Binary-delta updates.
- Signed or notarized installer changes.
- Organization-wide update policy.
- A full persistent background job system for Desktop updates.
- Full cancel/resume semantics in the first iteration.
- Showing exact replacement progress after the current app has quit.

## Non-Functional Requirements

- Usability: progress must be truthful and easy to scan.
- Observability: every major installer phase must be represented in a structured
  event.
- Maintainability: Electron should observe the existing CLI installer rather
  than duplicating GitHub download, checksum, replacement, and launcher logic.
- Availability: failures in progress parsing must not prevent the underlying
  update flow from continuing.
- Compatibility: existing Desktop shell methods and tests should continue to
  work for callers that ignore progress sessions.

## User Experience Walkthrough

1. The operator opens Settings > About and clicks Check for updates.
2. Rudder compares the current Desktop version with the selected release
   channel.
3. If a newer release exists, About shows the release inline and exposes Update.
4. The operator clicks Update.
5. A compact bottom-right card appears across the app:

   ```text
   Updating to v0.2.1
   Downloading desktop asset... 42%
   [====================----------------------------]
   ```

6. The card advances through these user-visible phases:

   ```text
   Resolving release...
   Downloading checksums...
   Downloading desktop asset...
   Verifying checksum...
   Update ready. Restart to finish.
   Waiting for active runs...
   Preparing to restart...
   Rudder will close and reopen to finish the update.
   ```

7. After download and checksum verification complete, the global card becomes
   actionable:

   ```text
   Update ready
   Downloaded and verified. Restart to finish the update.
   [Restart to update]
   ```

8. If active runs exist, Rudder keeps the existing native confirmation prompt:
   Download and Update When Idle, or Cancel.
9. If the operator confirms, the progress card can later move to a queued/waiting state:

   ```text
   Update queued
   Waiting for 2 active runs to finish. Rudder will update when idle.
   ```

10. If the update fails, the global card becomes actionable:

   ```text
   Update failed while verifying checksum.
   [Retry] [Open Releases]
   ```

11. Settings > About may show the detailed phase list and diagnostic details
    while the global card stays compact.
12. When replacement begins, the old app can only say that Rudder will close and
    reopen. The app should not promise continued in-window progress after that
    point.

## Implementation

### Product Or Technical Architecture Changes

Introduce an update session owned by the Electron main process.

The session is the renderer-facing source of truth for a single in-app update
attempt:

```ts
type DesktopUpdateProgressPhase =
  | "starting"
  | "resolving_release"
  | "downloading_checksums"
  | "downloading_asset"
  | "verifying_checksum"
  | "waiting_for_active_runs"
  | "preparing_restart"
  | "closing"
  | "failed";

type DesktopUpdateProgressEvent = {
  updateId: string;
  version: string;
  phase: DesktopUpdateProgressPhase;
  message: string;
  percent?: number;
  transferredBytes?: number;
  totalBytes?: number;
  totalRuns?: number;
  error?: string;
  at: string;
};
```

The CLI remains responsible for release resolution, download, checksum,
replacement, launcher refresh, and relaunch. Electron is responsible for
starting the CLI, parsing structured progress events, maintaining the latest
session state, and broadcasting events to the renderer.

### Breaking Change

No breaking change is required.

Existing `desktopShell.checkForUpdates()` and `desktopShell.installUpdate()`
should keep their current meaning. `installUpdate()` may add an optional
`updateId` to `started` and `waiting` results. Existing callers that ignore the
field should continue to work.

### Design

The CLI should gain an internal structured progress mode for Desktop:

```text
rudder start --no-cli --target-version 0.2.1 --repo Undertone0809/rudder \
  --no-version-check --desktop-progress-json
```

In that mode, the CLI writes newline-delimited JSON progress events to stdout.
Human spinner output remains unchanged for normal TTY use.

Electron should spawn the update child with stdout piped instead of ignored:

```ts
const child = spawn(process.execPath, args, {
  detached: true,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

Electron should parse only events that match the Desktop progress envelope.
Unexpected stdout/stderr should be logged for diagnostics but should not crash
or block the update.

Renderer API shape:

```ts
desktopShell.installUpdate(version): Promise<DesktopUpdateInstallResult>;
desktopShell.onUpdateProgress(listener): () => void;
desktopShell.getUpdateProgress(updateId): Promise<DesktopUpdateProgressEvent | null>;
```

The normal app-wide surface should render as a compact bottom-right card in the
same visual family as existing update toasts. Settings > About should render the
same session as a denser diagnostic panel when present. This keeps the everyday
operator experience light while preserving a place to inspect phase detail when
debugging or validating the updater.

The progress card should use:

- title: target version and status
- body: current phase message
- determinate progress bar only when `percent` is present
- indeterminate bar or step row for non-byte phases
- Retry and Open Releases on failure

### Security

This proposal does not add new remote APIs beyond the existing GitHub Releases
and npm paths used by the CLI update flow.

The new risk is local process output parsing. Electron must parse progress JSON
as untrusted child output:

- ignore events without the expected envelope and update id
- clamp percentages to `0..100`
- do not render raw stack traces or unbounded child output in the UI
- keep existing checksum verification as the authority for downloaded assets

## What Is Your Testing Plan (QA)?

### Goal

Prove that the Desktop update UI reflects the real updater state, preserves the
safe active-run behavior, and fails clearly when the underlying installer fails.

### Prerequisites

- Packaged Desktop build for the main update path.
- Mocked CLI progress events for unit tests.
- Mocked active-run API responses for waiting/blocked tests.
- A controllable test release or fixture asset for packaged smoke coverage.

### Test Scenarios / Cases

- About page starts an update and renders `starting`.
- Download event with `percent` renders determinate progress.
- Download event without total bytes renders transferred bytes and no fake
  percent.
- Phase-only event renders step status.
- Active runs produce waiting/queued state after operator confirmation.
- Operator cancels active-run prompt and sees blocked state.
- Child process failure renders failed state with Retry and Open Releases.
- Browser/dev shell still reports in-app install unavailable.
- Startup/menu update checks can start the same progress session without
  duplicating incompatible UI state.

### Expected Results

- The UI never shows determinate progress without byte-backed data.
- Update failure messages identify the phase where the failure happened.
- Retrying starts a new update session and does not reuse stale progress.
- Existing update check and update channel tests remain valid.
- Packaged smoke verifies the About route and update IPC availability.

### Pass / Fail

To be filled during implementation.

## Documentation Changes

- Update `doc/DESKTOP.md` to describe observable update phases and clarify which
  phases can show real percentage.
- Update `doc/README.md` only if Desktop update progress becomes a navigational
  topic.
- Add code comments near the Electron update-session bridge because the process
  lifetime and old-app replacement boundary are easy to misunderstand.

## Open Issues

- Should the first version expose Cancel, or only Retry after failure?
- Should startup/menu-triggered updates show the About page automatically, a
  toast progress card, or both?
- Should the latest update session survive renderer reloads only in memory, or
  be written to user data for crash recovery?
- How should a successful relaunch prove to the user that the update completed:
  one-time toast, About inline status, or both?
- `desktop_update_progress` is a newly minted plan entity for this proposal
  because the current taxonomy and nearby plans have `desktop_release`,
  `desktop_settings`, and `cli_start`, but no stable noun for the in-app
  progress bridge itself.
