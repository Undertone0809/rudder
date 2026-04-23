# Local Dev / Local Prod Isolation

## Summary

Introduce first-class local environment profiles so daily development, persistent local usage, and E2E runs stop sharing the same Rudder instance data.

Profiles:

- `dev`: disposable local development instance
- `prod_local`: persistent local instance that preserves existing `default` data
- `e2e`: isolated test-only instance

## Key Changes

- Add shared local environment profile resolution for CLI and scripts.
- Make `pnpm dev` use the `dev` profile by default.
- Add a dedicated `local:prod` entrypoint for the persistent local instance.
- Add a safe reset helper that only deletes disposable local environments.
- Update E2E startup to use the isolated `e2e` profile.
- Document per-instance config and env usage so environment-specific database settings do not live in the shared repo root `.env`.

## Assumptions

- “Local prod” means a persistent local instance used from the source tree, not a packaged release binary.
- Existing `default` instance data remains in place and becomes the `prod_local` target.
- `dev` and `e2e` are disposable and may be recreated at any time.
