# Rudder Single-Package CLI Plan

## Context

Rudder already has a CLI implementation in the monorepo, but its current npm packaging and public quickstart story are not aligned with the intended first-run experience.

The desired user journey is:

1. first use: `npx @rudder/cli onboard --yes`
2. during onboarding, install the same package so the persistent `rudder` binary becomes available
3. after install, the primary documented command becomes `rudder ...`
4. `npx @rudder/cli ...` remains supported as a zero-install fallback

This plan intentionally keeps the solution to a single npm package. There will be no separate bootstrap package.

## Recommendation In One Sentence

Publish the existing CLI as `@rudder/cli`, keep `rudder` as its only binary, add a first-run global install flow when invoked through `npx`, and treat `rudder ...` as the primary long-term command while still supporting `npx @rudder/cli ...`.

## Core Decisions

### 1. Use a single npm package

The package model is:

- npm package: `@rudder/cli`
- installed binary: `rudder`

There is no second bootstrap package, wrapper package, or shell shim. Both first-run and long-term use go through the same CLI codebase and the same release artifact.

Why this is the right tradeoff:

- it keeps the product story simple
- it avoids duplicated command logic
- it reduces release, canary, and smoke-testing complexity
- it lets the docs tell one coherent story

### 2. The first-run entrypoint is `npx @rudder/cli ...`

The CLI should explicitly support npm exec usage as the public quickstart path:

```bash
npx @rudder/cli onboard --yes
```

This is the only first-run syntax that docs should lead with.

`npm exec @rudder/cli ...` can still work, but it should not be the primary documented path.

### 3. The long-term command is still `rudder ...`

After installation, the primary command should be:

```bash
rudder run
rudder doctor
rudder issue list
```

The repo already uses `rudder` as the natural command name in development and in docs. That should remain the long-term mental model.

The scoped package name exists to solve npm distribution and first-run discovery. It should not leak into the main post-install UX more than necessary.

### 4. First-run install happens from inside the same CLI

When the CLI is launched through `npx` and the persistent `rudder` binary is not already available, onboarding should offer to install `@rudder/cli` globally with npm.

Behavior:

- interactive mode:
  - show that Rudder can now install the persistent CLI
  - ask for confirmation before global install
- `--yes` mode:
  - proceed automatically with install after successful onboarding
- if installation fails:
  - keep the onboarding/config result intact
  - print the exact recovery command
  - exit non-zero only if the original command itself failed

The CLI should not try to write shell profile aliases or generate local wrapper scripts. Persistence should be handled by npm global install only.

### 5. `npx @rudder/cli ...` remains supported after install

Even after the persistent `rudder` binary is available, users should still be able to run:

```bash
npx @rudder/cli doctor
npx @rudder/cli issue list
```

This is useful as:

- a fallback path
- a no-install path on temporary machines
- a canary/stable verification path

However, docs should bias users toward `rudder ...` after installation.

## User Journey

### First-time local setup

1. User runs `npx @rudder/cli onboard --yes`
2. CLI performs the normal onboarding flow
3. CLI detects that it is being executed through `npx`
4. CLI checks whether `rudder` already exists on the machine
5. If `rudder` is missing, CLI installs `@rudder/cli` globally with npm
6. CLI prints the next commands using `rudder`

### Returning user

Returning users primarily use:

```bash
rudder run
rudder doctor
rudder --help
```

If they prefer not to install globally on another machine, they can still use:

```bash
npx @rudder/cli run
```

## Implementation Plan

### 1. Package identity and metadata

Update the CLI package metadata so the published package is `@rudder/cli` while the executable remains `rudder`.

Required outcomes:

- `cli/package.json` uses `name: "@rudder/cli"`
- `bin` stays:
  - `"rudder": "./dist/index.js"`
- the publishable manifest generated during release preserves that exact shape

No other package should be introduced for this feature.

### 2. First-run install detection

Add a small internal utility module that determines:

- whether the current process is running through `npx` / `npm exec`
- whether a usable `rudder` binary is already available outside the current transient execution context
- which package spec should be installed:
  - stable default: `@rudder/cli`
  - canary usage: `@rudder/cli@canary`
  - explicit version if the invocation was version-pinned

The detection should be conservative. If the CLI cannot confidently determine that `rudder` is already installed, it should offer installation rather than silently assuming persistence exists.

### 3. Install flow integration

Hook the install flow into the successful end of onboarding.

Why onboarding is the correct integration point:

- it is already the first-run setup command
- `run` already delegates to onboarding when config is missing
- it keeps the install prompt out of unrelated commands like `issue list` or `doctor`

This means:

- direct `onboard` gains the install flow
- `run` inherits the same behavior when it triggers onboarding
- normal already-installed `rudder run` remains unchanged

### 4. Command behavior invariants

The following must not change:

- existing `rudder` subcommand names
- current onboarding semantics
- `run` meaning "bootstrap local setup and start Rudder"
- company-scoped client command behavior
- release channels and versioning rules

This work is packaging and first-run UX only. It is not a CLI redesign.

### 5. Release and packaging updates

Update release packaging so `@rudder/cli` is the publish target for the CLI.

Required updates:

- npm build script produces a publishable manifest using the scoped package name
- release scripts treat `@rudder/cli` as the CLI package identity
- canary and stable smoke flows use the new package name
- README copied into the publish artifact remains accurate for the scoped package install story

## Documentation Changes

Update the following docs so they all tell the same story:

- `README.md`
- `doc/CLI.md`
- `doc/PUBLISHING.md`
- `doc/RELEASING.md`

Documentation rules:

- first-run quickstart uses `npx @rudder/cli onboard --yes`
- long-term examples prefer `rudder ...`
- canary examples use `npx @rudder/cli@canary ...`
- avoid mentioning any separate bootstrap package

## Test Plan

### Unit tests

Add tests for:

- detection of `npx` execution context
- detection of an existing `rudder` binary
- install package spec resolution for:
  - default stable
  - canary
  - explicit version
- `--yes` install behavior
- interactive confirmation branch

### Integration tests

Cover these scenarios:

1. clean environment:
   - `npx @rudder/cli onboard --yes`
   - onboarding succeeds
   - persistent `rudder` becomes available

2. already installed environment:
   - `npx @rudder/cli onboard`
   - no unnecessary reinstall prompt

3. fallback path:
   - `npx @rudder/cli doctor`
   - command still works after installation

4. persistent usage:
   - `rudder --help`
   - `rudder run`
   - `rudder doctor`

### Release verification

Before shipping:

- run `./scripts/build-npm.sh`
- run `cd cli && npm pack --dry-run`
- verify the generated package name, bin, README, and dependency list
- verify canary docs/examples match the published package identity

## Non-Goals

This plan does not include:

- acquiring the unscoped npm package name `rudder`
- introducing a second npm package for bootstrap
- changing the existing CLI command taxonomy
- replacing npm global install with shell aliases or wrapper scripts

## Assumptions

- `@rudder` is the official npm scope for public Rudder packages.
- npm global install is acceptable for making `rudder` persist on the user's machine.
- Users are on Node 20+ and can run npm commands locally.
- The CLI should remain the canonical local-first onboarding path for Rudder V1.
