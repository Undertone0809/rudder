# Rudder Desktop

Rudder Desktop is the Electron-packaged local-first distribution of Rudder V1. It runs the existing board UI and local API inside a desktop shell, but it no longer owns a separate Rudder data directory.

Desktop, browser, and CLI surfaces now attach to the same local Rudder instance for the selected profile.
On first launch, packaged Desktop also attempts to export a `rudder` shell command by
installing a small wrapper script into a writable bin directory and routing CLI calls
back through the installed Desktop executable. Development Desktop runs do not install
or manage the `rudder` command.

## Scope

Current desktop scope is intentionally narrow:

- bundled local instance only
- `local_trusted` only
- packaged app uses a resident shell lifecycle
- no update detection or auto-update yet
- no launch-at-login
- no remote-instance connection mode

## Commands

From the repo root:

```sh
pnpm dev
pnpm dev:watch
pnpm dev:reset
pnpm desktop:verify
pnpm prod
pnpm desktop:build
pnpm desktop:dist
pnpm --filter @rudder/desktop smoke
node desktop/scripts/smoke.mjs --mode=packaged
```

Recommended defaults:

- `pnpm dev` starts the non-watch local `dev` runtime first, then opens the development Desktop shell against that same shared instance
- `pnpm dev:watch` starts the watched local `dev` runtime first, then opens the development Desktop shell against that same shared instance
- `pnpm desktop:verify` is the default contributor validation flow for Desktop work: dev-shell smoke, packaged build, then packaged-app smoke
- `pnpm prod` builds the packaged Desktop installer for the current platform, verifies the packaged app boots successfully, and then opens it so you can install the local production Desktop app

Low-frequency escape hatches:

- `RUDDER_DESKTOP_RESIDENT_SHELL=1 pnpm dev:watch` keeps the shared `dev` profile but forces resident tray/menu lifecycle for local debugging
- `pnpm --filter @rudder/desktop dev` runs only the development Desktop shell
- `pnpm rudder run` is the persistent local `prod_local` runtime entrypoint that packaged Desktop attaches to
- `pnpm desktop:dist` builds installer artifacts without opening them

Smoke scenarios:

- `pnpm --filter @rudder/desktop smoke` runs the clean-instance desktop smoke path.
- `node desktop/scripts/smoke.mjs --mode=packaged` now runs both a clean packaged smoke path and an upgrade smoke path that downgrades the temp `prod_local` schema before relaunching.
- Pass `--scenario=clean`, `--scenario=upgrade`, or `--scenario=all` to target a specific smoke path manually.

## Local profiles

Desktop follows the same local profiles as the rest of Rudder:

- unpackaged development Desktop defaults to `dev`
- packaged Desktop defaults to `prod_local`
- `RUDDER_LOCAL_ENV` overrides either default

That means:

- `pnpm dev` and `pnpm dev:watch` share `~/.rudder/instances/dev/`
- `pnpm rudder run`, default local CLI usage, and packaged Desktop share `~/.rudder/instances/default/`

## Lifecycle behavior

Desktop now has intentionally different lifecycle behavior in development vs packaged builds.

### Development shell

`pnpm dev` and `pnpm dev:watch` are the two supported development entrypoints.

Development Desktop stays optimized for iteration:

- close window => quit app
- no resident tray/menu shell by default
- no hidden long-lived background process
- no automatic `rudder` shell wrapper installation; use `pnpm rudder ...` for CLI work in development

Simulation path for production resident behavior:

- `RUDDER_DESKTOP_RESIDENT_SHELL=1 pnpm dev:watch`
- this keeps the `dev` profile and development shell wiring, but exercises the same resident tray/menu control path used by packaged Desktop

This keeps the desktop dev loop predictable while sharing the same `dev` data as browser and CLI.

### Packaged shell

Packaged Desktop is the primary local shell for `prod_local`.

- close window => hide to background when resident controls are available
- explicit Quit => fully exit the shell and stop the runtime it owns
- browser and CLI can still attach to the same local instance, but they do not define packaged Desktop lifecycle
- packaged Desktop first launch is the only automatic CLI export path for the `rudder` command
- packaged Desktop refreshes `PATH` from the user's login shell before starting the local runtime so CLI adapters like `codex` still resolve when the app is launched from Finder/menu shells

Platform behavior:

- macOS: resident control lives in the menu bar; when hidden, the Dock icon is removed until the window is shown again
- Windows: resident control lives in the notification area
- Linux: resident control uses tray/AppIndicator support when the current desktop environment is likely to support it; otherwise Desktop safely falls back to windowed quit-on-close behavior

## Window chrome contract

On macOS, Rudder Desktop keeps the native traffic-light window controls while hiding the default window title text.
The app uses Electron's `titleBarStyle: "hiddenInset"` so the top chrome remains a real macOS window region instead of a fake in-app replacement.

This means the top row of the app is treated as shared chrome:

- native close, minimize, and zoom buttons remain visible at the top-left
- the default title text is hidden
- Rudder content may extend into that top area, but must reserve leading space for the native buttons
- non-interactive top-bar background may act as a drag region
- interactive controls in that row must opt out of dragging so clicks, text input, and menus still work

Do not treat `hiddenInset` as "remove the title bar". It means "hide the default title presentation, keep the native macOS controls, and reuse the space intentionally".

## Data and shell paths

Rudder business data lives under the shared Rudder home:

- home: `~/.rudder`
- config: `~/.rudder/instances/<instance>/config.json`
- env file: `~/.rudder/instances/<instance>/.env`
- embedded Postgres: `~/.rudder/instances/<instance>/db`
- storage: `~/.rudder/instances/<instance>/data/storage`

Electron `userData` now stores only desktop-shell preferences such as window state. It is not the source of truth for Rudder config, database, or storage.

## Runtime coordination

Desktop does not blindly start a second local server for the same instance.

Instead it:

1. checks the shared runtime descriptor under `~/.rudder/instances/<instance>/runtime/server.json`
2. validates the existing runtime via `/api/health`
3. attaches when the runtime is healthy and compatible
4. starts a new runtime only when needed

The boot screen and Desktop settings page show the active profile, instance, runtime mode (`attached` or `owned`), server version, and the shared instance data path.

In packaged mode, resident-shell actions can restart the local runtime without changing the shared instance path.

## Smoke and isolated runs

For smoke tests or isolated manual runs, override both the shared Rudder home and the Electron shell data root:

```sh
RUDDER_HOME=/tmp/rudder-home \
RUDDER_DESKTOP_USER_DATA_DIR=/tmp/rudder-electron \
RUDDER_LOCAL_ENV=prod_local \
pnpm --filter @rudder/desktop smoke
```

`RUDDER_HOME` controls shared Rudder state. `RUDDER_DESKTOP_USER_DATA_DIR` only controls Electron shell preferences.

## Validation rules

Use this validation split when changing Desktop behavior:

- Development-shell changes:
  - `pnpm --filter @rudder/desktop smoke`
- Packaged boot, local prod startup, installer, icons, startup migrations, or shared-instance path changes:
  - `pnpm desktop:verify`

Do not rely on `pnpm prod` alone during development.
`pnpm prod` is a convenience wrapper that opens the installer after validation.
The contributor workflow should validate first, then open artifacts only after the packaged smoke path passes.

## Reset

To reset desktop-backed Rudder data for a profile, quit the app and remove that shared instance directory, for example:

```sh
rm -rf ~/.rudder/instances/dev
rm -rf ~/.rudder/instances/default
```

The startup failure screen exposes the active instance path for the current run.

## Packaging

Desktop packaging uses Electron + electron-builder and currently produces:

- macOS: `.dmg`
- Windows: `NSIS .exe`
- Linux: `.AppImage`

The GitHub Actions desktop workflow builds artifacts on all three operating systems. Tag builds under `desktop/v*` publish a GitHub prerelease with those artifacts attached.
