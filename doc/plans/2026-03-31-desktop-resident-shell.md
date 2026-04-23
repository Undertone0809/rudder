# Desktop Resident Shell Phase 1

## Summary

- Make packaged Rudder Desktop the primary local shell for `prod_local`.
- Keep local business data shared under `~/.rudder`; do not change instance ownership or data paths.
- Implement resident-shell lifecycle behavior first:
  - packaged Desktop close hides instead of quits
  - packaged Desktop stays running in the background
  - explicit Quit stops the shell and the runtime it owns
  - macOS uses a menu bar control surface
  - Windows/Linux use tray-style resident control where supported
- Defer update detection and release-feed polling until after the first packaged release exists.
- Preserve a fast development loop:
  - `pnpm dev:desktop` keeps quit-on-close behavior by default
  - no hidden long-lived dev process unless explicitly added later as a simulation mode

## Key Changes

### Lifecycle split by distribution mode

- Keep two distinct lifecycle modes:
  - unpackaged development shell
  - packaged resident shell
- Development mode remains window-oriented:
  - close window => quit app
  - no resident tray/menu shell by default
- Packaged mode becomes app-oriented:
  - close window => hide main window
  - app remains alive in background
  - explicit Quit exits fully

### Resident shell control surface

- Add a Desktop shell controller in `desktop/src/main.ts` for:
  - main-window visibility
  - resident-mode state
  - quit intent
  - runtime ownership status
- Add a tray/menu surface with first-party actions:
  - Show Rudder
  - Local runtime status
  - Restart local runtime
  - Quit Rudder
- macOS packaged behavior:
  - use a menu bar icon
  - when hidden resident, remove Dock presence if feasible
- Windows packaged behavior:
  - use a notification area tray icon
  - hide window on close, keep tray control
- Linux packaged behavior:
  - attempt tray/AppIndicator resident mode
  - if tray support is unavailable, degrade safely instead of hiding to an undiscoverable background process

### Window close and quit semantics

- Replace the current unconditional `window-all-closed => app.quit()` packaged behavior.
- Distinguish:
  - window close
  - app activation / reopen
  - explicit quit from menu/tray/app menu
- Keep existing single-instance behavior.
- Ensure explicit Quit still shuts down the owned runtime cleanly.
- Attached runtime shutdown remains a no-op, matching current shared-runtime coordination.

### Runtime UX integration

- Surface runtime state in the tray/menu label or tooltip where practical:
  - attached vs owned
  - target profile / instance
- Keep packaged Desktop as the primary `prod_local` version arbiter.
- Do not add update-feed checks, background download logic, or install prompts in this phase.

### Documentation

- Update `doc/DESKTOP.md` to describe:
  - packaged resident-shell behavior
  - dev-mode difference
  - platform caveats
- Update `doc/DEVELOPING.md` where desktop dev semantics changed or need clarification.

## Test Plan

- `pnpm dev:desktop` still quits on close and does not leave a hidden resident process behind.
- Packaged Desktop closes to background instead of quitting.
- Explicit Quit from the tray/menu/app menu fully exits the packaged app.
- Packaged Desktop still starts or attaches to the correct `prod_local` runtime.
- If packaged Desktop owns the runtime, explicit Quit stops it cleanly.
- If packaged Desktop is attached, explicit Quit exits the shell without corrupting shared runtime state.
- Reopening from the tray/menu re-shows the main window and preserves the active board session.
- On Linux without tray support, the app does not hide into an unreachable background state.

## Assumptions

- Phase 1 does not implement update detection, download, or install flows.
- Phase 1 does not implement launch-at-login.
- The first shipped resident-shell UX should prioritize macOS correctness while keeping Windows/Linux behavior aligned where platform support is available.
- Browser and CLI remain attachable secondary local surfaces; packaged Desktop defines the local product lifecycle for `prod_local`.
