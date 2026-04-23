# Staging Worktree Sandbox

## Summary

Enable a dedicated `staging` git worktree to run its own isolated local Rudder instance without colliding with the main checkout's `dev` runtime.

This work intentionally does **not** introduce a new first-class global local environment profile such as `staging`.
Instead, it makes the existing worktree-local instance model the recommended path for a personal staging sandbox.

## Problem

Today, contributors can create a worktree-local Rudder instance with `rudder worktree init`, but the root `pnpm dev` flow still hard-codes the shared `dev` profile/runtime behavior.

That creates a model mismatch:

- worktree docs promise isolated instance state
- repo-local `.rudder/.env` can define a unique `RUDDER_HOME`, `RUDDER_INSTANCE_ID`, and config path
- but `pnpm dev` and related scripts still bias toward the shared `dev` profile and ports

For a personal `staging` branch worktree, this means the intended isolated sandbox can still be confusing or fragile.

## Goals

- Let a worktree-local `.rudder/.env` control the instance identity used by the root dev flow.
- Keep `pnpm dev` as the normal entrypoint inside a staging worktree.
- Preserve the existing global profiles:
  - `dev`
  - `prod_local`
  - `e2e`
- Document a clear staging workflow built on worktrees rather than on a new global profile.

## Non-Goals

- Do not add a canonical `staging` value to `RUDDER_LOCAL_ENV`.
- Do not change packaged Desktop defaults.
- Do not redesign all local command naming in this change.

## Implementation Plan

1. Make the root dev scripts respect repo-local worktree env

- Ensure `pnpm dev` / `pnpm dev:watch` / related root flows load `.rudder/.env` from the current repo when present.
- Prefer explicit worktree-provided `RUDDER_INSTANCE_ID`, `RUDDER_HOME`, `RUDDER_CONFIG`, `PORT`, and `RUDDER_EMBEDDED_POSTGRES_PORT`.
- Only fall back to the shared `dev` profile defaults when those values are not already provided.

2. Preserve existing shared-profile behavior outside worktrees

- Main checkout behavior should remain unchanged:
  - `pnpm dev` uses `dev`
  - `pnpm local:prod` uses `prod_local`
  - E2E continues to use `e2e`

3. Add automated coverage

- Add tests for the environment-resolution behavior that now distinguishes:
  - default root dev flow
  - repo-local worktree override flow

4. Update contributor docs

- Document the recommended staging workflow:
  - create/switch to a staging worktree
  - run `pnpm rudder worktree init` if needed
  - use `pnpm dev` inside that worktree
- Explain why this is preferred over adding a global `staging` profile.

## Verification

- In the main checkout, `pnpm dev` still resolves to the shared `dev` instance.
- In a worktree with repo-local `.rudder/.env`, `pnpm dev` targets the isolated worktree instance and ports.
- The two runtimes can run side-by-side without sharing runtime descriptors or embedded Postgres data.

## Commit Notes

- `ab311ad` `feat: support isolated worktree dev sandboxes`
