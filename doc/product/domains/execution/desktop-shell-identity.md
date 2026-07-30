---
title: Desktop Shell Identity
domain: execution
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - DESKTOP.SHELL.IDENTITY.001
related_code:
  - desktop/src/app-icon.ts
  - desktop/src/main.ts
  - desktop/package.json
  - desktop/build/icon.icns
  - desktop/build/icon.png
related_tests:
  - desktop/src/app-icon.test.ts
  - desktop/scripts/smoke.mjs
edit_policy: user_confirmed_only
---

# Desktop Shell Identity

## DESKTOP.SHELL.IDENTITY.001

### Contract Summary

Rudder Desktop keeps a stable, platform-native application identity before,
during, and after launch. On packaged macOS builds, the Dock must continue
using the application bundle's canonical `.icns` icon while the process is
running. Desktop must not replace that icon at runtime with the cross-platform
PNG, because doing so changes the icon from the macOS rounded-square treatment
to a visually larger circular mark.

Development builds may apply an environment-specific Dock icon so contributors
can distinguish development from packaged Rudder. Windows and Linux continue
using their platform-specific window, taskbar, tray, and installer assets.

### Intent / User Job

The operator should be able to recognize Rudder in the macOS Dock without the
icon changing shape or scale when the application opens. Restarting or
restoring the Desktop window should preserve the same application identity.

### Why / Design Reasoning

The packaged macOS bundle already supplies the canonical icon through
`icon.icns`. Calling Electron's runtime Dock icon API with the generic PNG
overrides that platform-native asset and produces a different visible result.
Packaged macOS should therefore trust the bundle identity, while development
may keep an explicit override for environment differentiation.

### Actors / Objects / State

- Actors: Desktop operator and Electron main process.
- Objects: packaged application bundle, canonical `.icns`, cross-platform PNG,
  development icon, Dock item, window icon, and resident-shell state.
- States: application not running, packaged application running, window hidden
  to resident mode, window restored, application restarted, and development
  application running.

### Entry Points / Inputs

- Launching the packaged macOS application.
- Launching a macOS development build.
- Showing or hiding the main window through resident-shell behavior.
- Quitting and restarting the packaged application.
- Creating platform window or tray icons on Windows and Linux.

### Product Logic Flow

1. Packaging assigns the canonical macOS `.icns` asset to the Rudder
   application bundle.
2. When a packaged macOS process starts, Desktop leaves the Dock icon under
   bundle ownership and does not call the runtime Dock icon override.
3. Showing, hiding, or restoring the main window may change Dock visibility
   according to the resident-shell contract, but must not replace the icon.
4. Restarting the packaged application restores the same bundle-owned icon.
5. A macOS development process may apply its environment-specific PNG through
   the runtime Dock icon API.
6. Non-macOS platforms do not use the macOS Dock API; their existing window,
   taskbar, tray, and packaging icon paths remain authoritative.

### Decision Table

| Situation | Expected result | Must not happen |
| --- | --- | --- |
| Packaged macOS app is not running | Finder/Dock uses the bundle `.icns` | Generic runtime PNG becomes the canonical package identity |
| Packaged macOS app launches or restarts | Running Dock item keeps the same rounded-square bundle icon | Startup replaces it with the circular cross-platform PNG |
| Packaged macOS window hides or restores | Dock visibility follows resident-shell behavior and the icon identity remains stable | Hide/show changes the icon asset or scale |
| macOS development app launches | Development may use its environment-specific Dock icon | Packaged identity rules prevent contributors from distinguishing dev |
| Windows or Linux app launches | Existing platform icon paths remain in effect | macOS Dock policy disables window, taskbar, tray, or installer icons |

### Actor-Visible Input

This behavior requires no operator input or setting. Launch, hide, restore,
quit, and restart use the ordinary Desktop controls.

### Operator-Visible Output

- The packaged Rudder Dock item has the same macOS rounded-square appearance
  before launch, while running, and after restart.
- Development builds may remain visually distinguishable.
- No settings, prompts, migrations, or user-data changes are required.

### Persisted Evidence

This behavior does not create server-side records or user preferences. The
canonical packaged identity is stored in the application bundle; runtime icon
selection is process-local.

### Canonical Scenarios

1. Packaged launch: the operator opens Rudder from the Dock or Finder, and the
   running Dock item retains the same rounded-square bundle icon.
2. Packaged restart: the operator quits and reopens Rudder, and the icon remains
   unchanged across both runs.
3. Resident restore: the operator restores a hidden Rudder window, and the Dock
   item returns with the same bundle-owned identity.
4. Development launch: a contributor opens Rudder Desktop in development and
   sees the environment-specific development icon.

### Invariants / Non-Goals

- Packaged macOS must not call `app.dock.setIcon` with the generic PNG.
- The canonical `.icns` remains the source of packaged macOS Dock identity.
- Development-only icon differentiation must not leak into packaged behavior.
- This contract does not redesign the Rudder mark or icon artwork.
- This contract does not change resident-shell Dock visibility rules.
- This contract does not change Windows or Linux icon assets.

### Drift Boundaries

Update this contract when changing the packaged macOS icon source, Electron
runtime Dock overrides, development icon differentiation, resident hide/show
identity behavior, or platform-specific icon ownership.

Artwork redesigns require explicit product/design approval. Changes that affect
only tray-menu glyphs or in-product logos belong to their owning surface unless
they also alter application identity.

### Traceability

- `desktop/src/app-icon.test.ts` proves that packaged macOS rejects the runtime
  override, development macOS permits it, and non-macOS platforms do not use
  the Dock API.
- `desktop/scripts/smoke.mjs --mode=packaged` proves the packaged application
  can launch through the real Electron path.
- Packaged visual verification compares the Dock item while running and after
  restart against the bundle-owned rounded-square icon.
