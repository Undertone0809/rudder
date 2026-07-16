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
- update detection, Rudder-managed portable replacement, and layered shell
  updates are available; binary-delta patch updates are not implemented yet
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
pnpm --filter @rudderhq/desktop smoke
node desktop/scripts/smoke.mjs --mode=packaged
npx @rudderhq/cli@latest start
```

Recommended defaults:

- `pnpm dev` starts the non-watch local `dev` runtime first, then opens the development Desktop shell against that same shared instance
- `pnpm dev:watch` starts the watched local `dev` runtime first, then opens the development Desktop shell against that same shared instance
- `pnpm desktop:verify` is the default contributor validation flow for Desktop work: dev-shell smoke, packaged build, then packaged-app smoke
- `pnpm prod` builds the packaged portable Desktop artifact for the current platform, verifies the packaged app boots successfully, and then opens the local app artifact
- `npx @rudderhq/cli@latest start` is the public first-run form; after the
  persistent CLI exists, `rudder start` is the equivalent direct form. Both
  check for newer CLI releases and install/launch the matching portable Desktop
  asset from the GitHub Release when needed.
- `npx @rudderhq/cli@latest start --server-only` is the public server-only
  install form. It prepares the matching persistent CLI and server runtime cache
  without resolving, downloading, installing, or launching Desktop assets.

Low-frequency escape hatches:

- `RUDDER_DESKTOP_RESIDENT_SHELL=1 pnpm dev:watch` keeps the shared `dev` profile but forces resident tray/menu lifecycle for local debugging
- `pnpm --filter @rudderhq/desktop dev` runs only the development Desktop shell
- `pnpm rudder run` is the persistent local `prod_local` runtime entrypoint that packaged Desktop attaches to
- `pnpm desktop:dist` builds portable release artifacts without opening them

Smoke scenarios:

- `pnpm --filter @rudderhq/desktop smoke` runs startup-recovery, renderer-recovery, and clean-instance Desktop smoke paths.
- `node desktop/scripts/smoke.mjs --mode=packaged` runs startup-recovery, renderer-recovery, clean packaged, and upgrade smoke paths. The upgrade path downgrades the temporary `prod_local` schema before relaunching.
- Pass `--scenario=startup-recovery`, `--scenario=renderer-recovery`, `--scenario=clean`, `--scenario=upgrade`, or `--scenario=all` to target a specific smoke path manually.

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
- packaged Desktop refreshes `PATH` from the user's login shell and, for zsh/bash, the interactive login shell before starting the local runtime so CLI adapters like `codex` still resolve when the app is launched from Finder/menu shells and the CLI is installed through shell-managed toolchains such as nvm

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

Organization workspaces are user work files and default to the user's Documents
folder when `RUDDER_HOME` is not explicitly set:

- macOS, Windows, and Linux default:
  `~/Documents/Rudder/<org-folder>`
- local folder map:
  `~/Documents/Rudder/.rudder-organizations.json` records the
  `<org-folder>` to organization-id mapping for this machine
- explicit override:
  `RUDDER_ORGANIZATION_WORKSPACE_HOME=/path/to/rudder-workspaces`
- compatibility mode:
  setting `RUDDER_HOME` keeps organization workspaces under
  `~/.rudder/instances/<instance>/organizations/<org-storage-key>/workspaces`
  unless `RUDDER_ORGANIZATION_WORKSPACE_HOME` is also set

On startup or first workspace access, Rudder attempts to migrate the legacy
workspace subtree from the instance root into the configured organization
workspace home. This migration is silent when it succeeds. If the operating
system blocks access to the Documents target, Rudder reports the source path,
target path, and permission-oriented recovery guidance. On Windows, that
guidance includes choosing a writable workspace home or running Rudder as
administrator when local folder policy requires elevated access.

Electron `userData` stores desktop-shell preferences such as window state and
the local Rudder Browser profile. Browser data uses a dedicated persistent
partition named from a SHA-256 hash of the canonical absolute instance root.
It is shared across organizations attached to that local instance, isolated
from both the main Rudder renderer session and Browser profiles for other
instance roots, and does not expose the instance path in the partition name.
The Browser partition is separate from shell preferences even though both live
under Electron `userData`. Neither is the source of truth for Rudder config,
database, server-backed Browser settings, or organization storage. Desktop also
stores per-version release-note acknowledgement state there so a completed
update can show the current version's changelog once after restart.

### Browser data import

The first Browser data importer is a macOS Desktop capability for cookies from
Google Chrome, Microsoft Edge, and Brave profiles. Discovery reads only each
browser's `Local State` profile index. The renderer receives opaque source ids,
profile labels, and supported data types; it never receives source paths,
Keychain values, Cookie database rows, or decrypted cookie values.

Import requires the source browser to be closed. Desktop verifies that the
source Cookie database is not open, copies `Cookies` and any matching WAL/SHM
files into a mode-`0700` temporary directory owned by the opaque Browser
instance id and a live process marker, and rejects source changes during the
copy. Normal completion, failure, cancellation, and graceful quit terminate the
worker before removing the snapshot. After a crash, startup reaps only marked
directories owned by the same canonical instance and current OS user whose
owner process is no longer alive; it preserves live and foreign-instance
imports. If the database is open, the dialog tells the operator to close the
selected browser and retry while keeping source paths and raw worker errors out
of the renderer. SQLite parsing and macOS Chromium `v10` decryption run in a
worker thread. Linux `v11`, partitioned cookies that Electron cannot represent,
malformed rows, and expired cookies are reported as skipped instead of being
silently weakened. Existing Rudder Browser cookies win on identity collisions,
and successful imports are flushed to the instance-scoped Browser partition.

Saved-password import is not part of this implementation. Automated tests must
use synthetic profiles and must not inspect a contributor's real browser data or
Keychain.

### Browser Broker and lifecycle

Agent Browser tools do not connect directly to Electron. After the local API is
healthy, Desktop starts a loopback-only Broker with a random in-memory bearer
credential and registers that endpoint with the local server. The server keeps
the registration only in memory, derives organization, agent, and run identity
from the authenticated runtime request, checks the live Browser setting and
active run, records a durable action intent, and then forwards one bounded
high-level Browser command. Response deadlines include body consumption and
Broker responses have a byte limit.
Desktop rejects redirects on all Broker registration, unregister, settings, and
run-liveness requests, and the server rejects redirects when forwarding commands
to Desktop, so credentials and Browser command bodies stay on their literal
loopback endpoints.

The Browser capability is available only in `local_trusted` deployments.
Organization skill inventory additionally requires the live Browser setting;
run materialization requires `claude_local`, `codex_local`, `opencode_local`, or
`pi_local`. Runtime fallback recomputes the skill, capability flag, and tools as
one unit so an unsupported runtime cannot retain a partial Browser promise.

Desktop owns Agent Browser windows and their leases. Commands for one run are
serialized per tab, each run may own at most eight tabs, the process may own at
most 32 Agent tabs, and an absolute command deadline closes a timed-out tab. The
operator Side Panel separately permits eight Browser tabs per context. At that
limit, ordinary Rudder links reuse an existing tab; popup and explicit new-tab
requests are discarded. Popup admission is also limited to eight requests per
rolling ten-second window. A periodic sweep synchronizes the instance Browser
setting and closes tabs for runs that are no longer active.
Disabling Browser or clearing its data closes admission, operator tabs, and
Agent tabs immediately, even when an already-admitted import is still running.
Clear then waits for that import and uses Electron's exhaustive `clearData()`
session removal before flushing the profile. Runtime restart, Desktop
disconnect, and app quit stop command admission, close Agent tabs, unregister
the current credential, and stop the loopback Broker. App quit also aborts any
active import worker and waits for its temporary snapshot cleanup before
stopping the local runtime. Broker credentials, leases, and tabs never persist
across Desktop restarts.

V1 keeps one active in-memory Broker registration. Another same-instance
`local_trusted` instance-admin Desktop/client may replace it; token-matched
unregister prevents stale shutdown from removing the replacement, but a Broker
generation/owner handshake is deferred.

Published CLI and Desktop starts install the server runtime into a versioned
cache under `~/.rudder/runtimes/<version>`. Rudder automatically prunes old
runtime cache entries after runtime preparation while protecting the requested
version, the latest stable/canary entries, and versions referenced by live
local-runtime descriptors. This cache is reconstructable from npm and is
separate from instance data.

## Runtime coordination

Desktop does not blindly start a second local server for the same instance.

Instead it:

1. checks the shared runtime descriptor under `~/.rudder/instances/<instance>/runtime/server.json`
2. validates the existing runtime via `/api/health`
3. attaches when the runtime is healthy and compatible
4. starts a new runtime only when needed

Healthy startup intentionally shows only the Rudder mark and non-progress motion.
It does not expose profile, instance, runtime stage, version, paths, or actions.
The Desktop settings page remains the normal place to inspect the active profile,
instance, runtime mode (`attached` or `owned`), server version, and shared
instance data path.

In packaged mode, resident-shell actions can restart the local runtime without changing the shared instance path.

## Failure recovery

Desktop has three operator-facing recovery layers across startup and UI runtime:

- If managed local startup rejects after the boot window exists, the quiet boot
  surface expands in place. The operator can retry, open an editable support
  draft addressed to `zeeland4work@gmail.com`, open the fixed public GitHub bug
  form at
  `https://github.com/Undertone0809/rudder/issues/new?template=bug_report.yml`,
  or disclose technical details. Both external actions are fixed main-process
  intents and have copy fallbacks when the OS handoff fails.

  The support draft includes a bounded, main-process-owned diagnostic summary
  and editable prompts for summary, reproduction, actual and expected behavior,
  onset and preceding changes, retry result, impact/workaround, evidence, and
  environment context. The GitHub path identifies the destination as public and
  tells the operator to paste `Copy diagnostic` into the form's Environment
  details when useful. The copied support diagnostic omits the instance folder,
  even though that path remains available in the local collapsed details for
  recovery. Rudder does not attach files, send mail, submit issues, or upload
  evidence automatically. The UI warns against sharing secrets,
  private paths, prompts, command output, `.env`, `config.json`, databases,
  credentials, or private workspace files. Raw details and the instance path
  stay collapsed until requested.

- If the React UI throws during render, the board shows a recovery surface instead
  of unmounting to a blank window. The operator can reload the UI, copy a
  diagnostic, or restart Rudder from Desktop.
- If Electron detects that the renderer process exited, failed to load the main
  frame, or stopped responding, Desktop shows or prompts for recovery instead of
  leaving a dark empty window. Reloading the UI keeps the local runtime running;
  restarting Rudder restarts the owned or attached local startup flow.

## Smoke and isolated runs

For smoke tests or isolated manual runs, override both the shared Rudder home and the Electron shell data root:

```sh
RUDDER_HOME=/tmp/rudder-home \
RUDDER_DESKTOP_USER_DATA_DIR=/tmp/rudder-electron \
RUDDER_LOCAL_ENV=prod_local \
pnpm --filter @rudderhq/desktop smoke
```

`RUDDER_HOME` controls shared Rudder state. `RUDDER_DESKTOP_USER_DATA_DIR`
controls Electron-local state: shell preferences and the instance-keyed Rudder
Browser partition. Browser data remains a distinct partition and is not stored
inside the shell preference files.
Use `RUDDER_ORGANIZATION_WORKSPACE_HOME` when a smoke or manual run needs an
isolated organization workspace root outside the user's Documents folder.

## Validation rules

Use this validation split when changing Desktop behavior:

- Development-shell changes:
  - `pnpm --filter @rudderhq/desktop smoke`
- Packaged boot, local prod startup, portable artifacts, icons, startup migrations, or shared-instance path changes:
  - `pnpm desktop:verify`

Do not rely on `pnpm prod` alone during development.
`pnpm prod` is a convenience wrapper that opens the local packaged app after validation.
The contributor workflow should validate first, then open artifacts only after the packaged smoke path passes.

## Reset

To reset desktop-backed Rudder data for a profile, quit the app and remove that shared instance directory, for example:

```sh
rm -rf ~/.rudder/instances/dev
rm -rf ~/.rudder/instances/default
```

The startup failure screen exposes the active instance path for the current run
inside its collapsed technical details.

## Packaging

Desktop packaging uses Electron + electron-builder and currently produces:

- macOS: portable `.zip` containing `Rudder.app`
- Windows: portable `.zip` containing the unpacked Electron app
- Linux: `.AppImage`

The GitHub Actions desktop workflow builds artifacts on all three operating systems. Stable tags under `v*` and canary tags under `canary/v*` publish Desktop artifacts to the matching GitHub Release:

- `Rudder-X.Y.Z-macos-x64-portable.zip`
- `Rudder-X.Y.Z-macos-x64-shell.zip`
- `Rudder-X.Y.Z-macos-arm64-portable.zip`
- `Rudder-X.Y.Z-macos-arm64-shell.zip`
- `Rudder-X.Y.Z-windows-x64-portable.zip`
- `Rudder-X.Y.Z-windows-x64-shell.zip`
- `Rudder-X.Y.Z-linux-x64.AppImage`
- `SHASUMS256.txt`

Before packaging, the workflow rewrites package manifests to the release tag
version. That means canary builds report `0.1.0-canary.N` from the app shell,
the bundled local server, and the packaged `rudder --version` path instead of
falling back to the committed stable base version.

Desktop artifacts are not published to npm. The CLI `start` command resolves
the appropriate GitHub Release asset for the current platform, verifies
`SHASUMS256.txt`, installs the app into a per-user location, and launches it.
The CLI `start --server-only` path deliberately skips this Desktop asset flow
and only prepares the npm-backed CLI/server runtime side.
On macOS and Windows, `start` prefers the layered `shell` asset when the release
publishes one. Shell assets keep the Electron shell and packaged desktop CLI,
but load the server from the already prepared `~/.rudder/runtimes/<version>`
cache instead of carrying the full packaged server on every Desktop update. The
shell asset is eligible when the exact versioned runtime cache has been prepared.
If the shell asset is missing, unchecked, or cannot be downloaded, `start` falls
back to the full portable asset.
Launching a shell asset directly without the matching runtime cache is not a
supported install path; rerun `rudder start` so the CLI can prepare the runtime
cache first, or install the full portable asset.

Desktop assets do not bundle a PostgreSQL runtime by default. Local database
startup uses an explicit operator-provided `RUDDER_POSTGRES_BIN_DIR` first, then
the server runtime's npm-backed embedded PostgreSQL dependency. This keeps app
downloads smaller and leaves database runtime ownership with the CLI/server
runtime cache instead of the Electron shell. For a targeted escape hatch,
setting `RUDDER_DESKTOP_BUNDLE_POSTGRES_RUNTIME=1` during staging prepares a
PostgreSQL 18.4 payload under `desktop/.packaged/postgres-18.4/`; that explicit
mode fails when `initdb`, `pg_ctl`, or `postgres` are missing, or when
`postgres --version` is not PostgreSQL 18.4.
`desktop/scripts/stage-server.mjs` runs `pnpm deploy` with the legacy deploy
config scoped to that child process so pnpm 10+ and 11+ can still package the
server from a workspace that does not use injected workspace packages.
Downloaded Desktop assets are cached under `~/.rudder/desktop-assets/` by
SHA-256 checksum so repeated installs or retries can reuse an already verified
portable asset instead of downloading the full release again.
After a successful start or update, Rudder prunes old Desktop asset cache
entries while protecting the just-resolved asset and one recent previous asset.
The asset cache is reconstructable from GitHub Releases and is separate from
installed app files and instance data.
The current Desktop channel is an unsigned portable alpha; signed/notarized
installer distribution can be restored after Apple and Windows code signing are
available.

Packaged Desktop checks for updates on startup against GitHub Releases. The
local Desktop update channel defaults to stable, so update checks compare
against the latest stable release unless the operator enables canary updates in
Settings > General. With canary enabled, startup, menu, and About-page checks
compare against the latest canary release. Beta prereleases are ignored; if a
newer matching release exists, the app prompts the user to update.
When the operator chooses Update, Desktop starts the bundled CLI
`start --no-cli` replacement flow for the discovered version. That flow prepares
the matching server runtime cache, downloads the preferred shell asset when
available or the full portable fallback otherwise, verifies `SHASUMS256.txt`,
requests the running Desktop shell to quit, replaces the per-user app, refreshes
launchers, and reopens Rudder. Running Agent Runs across every organization in
the local instance delay replacement; queued or terminal close-out records do
not require a destructive Stop Runs decision.

During an in-app update, Desktop shows a compact bottom-right update status card
with structured progress from the bundled CLI. Byte-backed downloads may show a
determinate percentage; release resolution, checksum verification, active-run
waiting, replacement preparation, and relaunch are shown as phase status rather
than fake percentages. Accepting Update is sufficient intent to finish the
replacement: after the release asset is downloaded and verified, Desktop
refreshes instance-wide running blockers and applies automatically when none
remain. While waiting, the card names the blocking organization and agent and
keeps force-stop as an explicit secondary action. If the CLI's final update-quit
check discovers a run that started after Electron's ready-time query, Desktop
refreshes that run's identity, keeps retrying failed inspections, and allows the
same force-stop escalation without restarting the update. Settings > About can
show the same update session as a denser phase-by-phase diagnostic panel for
debugging or validation.

This is a layered asset replacement path, not a binary-delta patcher. Fresh
installs still download the server runtime and a Desktop app, but routine
macOS/Windows Desktop updates avoid redownloading the server runtime when the
release provides a shell asset and the matching runtime cache has already been
prepared.
