# Simplify Local Desktop Commands

## Summary

- Make `pnpm dev` the default local development entrypoint for Rudder.
- `pnpm dev` should start both:
  - the watched local `dev` runtime
  - the development Desktop shell attached to that runtime
- Add a single production packaging/install entrypoint:
  - `pnpm prod`
  - builds the packaged Desktop app for the current platform
  - opens the generated installer artifact automatically
- Keep the more granular commands for advanced use, but move them out of the primary workflow.

## Key Changes

- Replace the root `dev` script with a small orchestration script that:
  - launches the watched `dev` runtime first
  - waits until the `dev_runner` runtime is healthy
  - then launches the Desktop development shell
  - forwards signals and shuts both down cleanly
- Keep `dev:watch` as the server/browser-only advanced entrypoint.
- Keep `dev:desktop` as the desktop-only advanced entrypoint.
- Add `prod` as the top-level packaged-desktop entrypoint.
- Add a production packaging script that:
  - runs the existing desktop distribution build
  - locates the newest current-platform installer artifact
  - opens it for the user

## Test Plan

- `pnpm dev` launches the watched local runtime and then opens the Desktop dev shell.
- Closing the Desktop dev shell does not corrupt the running `dev` runtime.
- `Ctrl+C` from `pnpm dev` stops the watched runtime and any running Desktop child.
- `pnpm prod` builds the packaged desktop artifact and opens the installer on macOS.
- Existing advanced commands continue to work:
  - `pnpm dev:watch`
  - `pnpm dev:desktop`
  - `pnpm desktop:dist`

## Assumptions

- This phase targets simpler local developer ergonomics, not a broader release automation change.
- On macOS, “install” means building the `.dmg` and opening it for drag-to-Applications installation.
- Windows/Linux use the same `pnpm prod` abstraction, but the exact opened artifact differs by platform.
