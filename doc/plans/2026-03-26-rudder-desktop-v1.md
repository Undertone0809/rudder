# Rudder Desktop V1 Plan

## Summary

Build Rudder Desktop V1 as an **Electron-based desktop shell** around the existing **local_trusted** product, targeting **macOS + Windows + Linux** for **internal alpha** use.

The first version should preserve the current **full board UI** and existing REST/WebSocket behavior. It should not introduce a second client model, remote-instance support, or a separate native control plane. The desktop app’s job is to make Rudder installable and locally runnable: launch, start embedded state, show the board UI, and package the app for the three desktop platforms.

## Implementation Changes

### 1. Desktop host architecture

- Add a new `desktop/` workspace that owns the Electron main process, preload bridge, packaging config, icons, and startup UX.
- Use a **single-window** model in V1. On launch, the main process acquires a single-instance lock, starts Rudder, waits for health readiness, then opens a `BrowserWindow` pointed at the local Rudder URL.
- Keep the renderer as the existing board UI loaded from the local Rudder server. Do not fork the UI into a desktop-specific frontend.
- Use an app-scoped data root under Electron `userData`; the desktop app should set `RUDDER_HOME` to that location so DB, storage, secrets, logs, and workspaces live under the desktop-managed instance.
- Force V1 desktop runtime into `local_trusted` mode. No authenticated/private/public mode selector in the first desktop release.
- Include a lightweight startup surface in the shell: loading screen, “starting database/server” status, fatal error screen with log-path copy/open affordance, and restart action.

### 2. Server/runtime integration

- Refactor the server bootstrap so desktop can manage it as a reusable lifecycle, not as a CLI side effect.
- Introduce a server lifecycle interface exported from the server package: start, readiness, resolved URLs/paths, and graceful stop. Desktop should call this directly rather than shelling out to `pnpm rudder run`.
- Preserve current API/UI behavior; the desktop app should consume the same `/api` and WebSocket surfaces as the browser version.
- Ensure server startup in desktop mode never tries to open the system browser and never enables Vite middleware.
- Keep the embedded PostgreSQL, local storage, and secret-provider defaults, but source all filesystem locations from the desktop-managed `RUDDER_HOME`.
- Add desktop-aware shutdown handling so app quit cleanly stops the HTTP server, background services, and embedded Postgres.

### 3. Desktop product scope

- Ship the **full existing board experience** inside the desktop shell, including onboarding, companies, agents, issues, approvals, costs, runs, and plugins that already work in the web app.
- Reuse the existing first-run flow: if there is no company, land in the current onboarding path rather than inventing a desktop-only wizard.
- Keep V1 native integrations intentionally narrow:
  - no tray/menu-bar mode
  - no launch-at-login
  - no auto-update
  - no remote-instance connection mode
  - no desktop-only notification system beyond what the web UI already does
- Treat any browser-only gaps discovered during packaging as targeted compatibility fixes in the UI, not as a separate redesign.

### 4. Packaging and release

- Use **Electron + electron-builder** for three-platform packaging.
- Produce these V1 artifacts:
  - macOS: `.dmg`
  - Windows: `NSIS .exe`
  - Linux: `.AppImage`
- Create a separate desktop release workflow rather than overloading the current npm release flow. Desktop artifacts should be built by a dedicated GitHub Actions workflow and attached to GitHub prereleases/releases.
- Since this is **internal alpha**, do not block V1 on code signing, notarization, or auto-update infrastructure. Structure the workflow so signing can be added later without changing the app runtime model.
- Add desktop-specific docs for install, app data locations, reset flow, and known platform warnings.

## Public Interfaces / Contracts

- Add a new public workspace/package for desktop distribution: `desktop/`.
- Extend the server package export surface with a **desktop-safe lifecycle API** used by Electron:
  - start server with explicit runtime options
  - expose readiness + resolved local URL
  - provide graceful stop/dispose
- Add a small desktop runtime contract via environment/config:
  - `RUDDER_HOME` set by Electron to app-managed storage
  - desktop mode disables browser auto-open and dev middleware
  - desktop V1 enforces `local_trusted`
- No changes to the board API contract are planned for V1; desktop should ride the existing API surface unchanged.

## Test Plan

- Packaging CI verifies artifact creation on macOS, Windows, and Linux.
- First-run desktop smoke test verifies:
  - app launches successfully
  - can create a company
  - can create a CEO
  - can create an issue
- Restart smoke test verifies relaunch still opens the same local instance state.
- Manual alpha sanity check verifies app quit/reopen does not wedge the local server or embedded DB.

## Assumptions and Defaults

- Runtime choice is **Electron**, not Tauri.
- First release is **internal alpha**, not public beta or signed production distribution.
- Desktop V1 is **bundled local instance only**; connecting to remote Rudder servers is out of scope.
- Desktop data is stored in the app’s own OS-managed app-data directory and is **not shared by default** with CLI/dev installs.
- Native extras such as tray, auto-launch, auto-update, signing, notarization, and richer OS notifications are deferred to a later phase after the core install-and-run loop is solid.
