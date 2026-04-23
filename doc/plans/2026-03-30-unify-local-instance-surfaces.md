# Unify Local Instance Surfaces

## Summary

- Merge the existing `codex/dev-prod-2` work into the local `main` checkout and continue implementation there instead of in a worktree.
- Write this plan into `doc/plans/` before implementation starts.
- Make profile/instance the only owner of local Rudder state. Web, Desktop, and CLI become different shells over the same local instance.
- Desktop no longer keeps a separate Rudder data root. Desktop, Web, and CLI must see the same `config.json`, `.env`, database, and storage when they target the same profile.
- `pnpm dev` and `pnpm dev:desktop` default to `dev`; `pnpm local:prod`, default CLI usage, and packaged Desktop default to `prod_local`.

## Key Changes

### Runtime Ownership and Paths

- `~/.rudder` remains the single source of truth for local Rudder data.
- `dev` uses `~/.rudder/instances/dev`.
- `prod_local` uses `~/.rudder/instances/default`.
- `e2e` uses `~/.rudder/instances/e2e`.
- Electron `userData` stores only desktop shell preferences, not Rudder `config.json`, `.env`, database, or storage.
- Keep the repo-scoped `.rudder/dev-server-status.json` only for dev restart UX. Do not reuse it for cross-shell instance discovery.

### Shared Runtime Coordination

- Add an instance-scoped runtime descriptor at `~/.rudder/instances/<instance>/runtime/server.json`.
- The descriptor contains `instanceId`, `localEnv`, `pid`, `listenPort`, `apiUrl`, `version`, `ownerKind`, and `startedAt`.
- Add a startup lock file such as `runtime/start.lock` to serialize attach-or-spawn and prevent duplicate boot attempts for the same instance.
- All local server entrypoints use the same attach-or-spawn coordinator instead of starting directly.
- Reuse checks follow a fixed order: read lock, read descriptor, validate pid, call `/api/health`, validate instance/profile/version, then attach or spawn.
- Treat stale descriptors, invalid pids, and port reuse with mismatched health as non-reusable and rebuild the descriptor.

### Surface Behavior

- `pnpm dev` remains the preferred owner for `dev` because it manages watch and restart. If a non-dev-runner process owns `dev`, `pnpm dev` should take over cleanly.
- `pnpm dev:desktop` targets `dev`, attaches to a healthy existing `dev` server when present, and only starts a server when needed.
- `pnpm local:prod` and `rudder run` also use attach-or-spawn for `prod_local`, attaching to an existing healthy same-version runtime instead of starting a second process.
- Packaged Desktop defaults to `prod_local` and attaches when a healthy same-version runtime already exists.
- If packaged Desktop finds an older-version runtime for its target profile, it should prefer the Desktop version: request graceful stop, wait briefly, then start its own version. If graceful stop fails, show a blocking error and do not hard-kill.
- Desktop boot and settings surfaces show the active profile, instance, data path, server version, and whether Desktop is attached or owning the runtime.

### Interface and Compatibility

- Extend `/api/health` with `instanceId`, `localEnv`, and `runtimeOwnerKind` while keeping existing fields compatible.
- Desktop profile resolution defaults to `dev` in unpackaged development and `prod_local` in packaged builds. An explicit `RUDDER_LOCAL_ENV` override still wins.
- Ignore the legacy desktop-only data root. Do not auto-migrate, auto-merge, or treat it as authoritative; new Desktop runs directly against `~/.rudder`.
- Keep the current compatibility mapping `prod_local -> instance default`. Do not rename the instance id.

## Test Plan

- `pnpm dev`, `pnpm dev:desktop`, and CLI all see the same data when targeting `dev`.
- `pnpm local:prod`, default CLI usage, and packaged Desktop all see the same data when targeting `prod_local`.
- Starting Desktop while Web is already running attaches instead of starting a duplicate server.
- Starting CLI while Desktop already owns the runtime attaches instead of starting a duplicate server.
- `pnpm dev` can take over a `dev` runtime previously started by Desktop and keep watch/restart behavior.
- The attach-or-spawn flow recovers from stale descriptors, invalid pids, failed health checks, and unrelated processes occupying the recorded port.
- `/api/health` exposes the new runtime fields without breaking existing callers.
- Same-version runtimes attach cleanly. Packaged Desktop performs graceful version takeover on mismatch and blocks with a clear error if takeover fails.
- Desktop shell preferences still live in Electron `userData`, while Rudder business data does not.

## Assumptions

- This phase does not implement tray persistence, close-to-background behavior, or auto-update installation, but the runtime owner model should stay compatible with those future features.
- Packaged Desktop is the long-term primary local shell, so packaged Desktop wins version arbitration.
- Legacy desktop-only data can be ignored and eventually discarded; `~/.rudder` is the only data root that matters.
- This work only targets single-machine local runtime sharing and coordination, not remote Web deployments or multi-machine sync.
