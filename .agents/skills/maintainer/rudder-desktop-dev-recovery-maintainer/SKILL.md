---
name: rudder-desktop-dev-recovery-maintainer
description: "Use when Rudder Desktop or its development shell will not launch, gets stuck at login/account gate, has pending device approval or local-session exchange, returns 401 during update, points at the wrong instance, fails during update/restart, triggers macOS Keychain/safeStorage alerts, or differs between dev and packaged execution. Recover one exact Desktop path and return RECOVERED or BLOCKED with runtime, identity, storage, and visible-workspace evidence."
---

# Rudder Desktop Dev Recovery Maintainer

Recover the exact Desktop path the user named. API health alone is not Desktop
health, and a healthy server belonging to another checkout is not evidence.

## Exclusive Outcome

- `RECOVERED`: the named Desktop path opened and its runtime identity plus
  requested behavior were observed.
- `BLOCKED`: the failing layer and remaining external decision or dependency are
  proven.

Do not claim recovery from code inspection, typecheck, a dry run, or an
unrelated healthy server.

## Classify The Target Before Resolving Runtime Identity

### Development or worktree target

1. Inspect the current checkout's `.rudder/config.json` and safe keys from
   `.rudder/.env`.
2. Follow `scripts/dev-local-env.mjs` to resolve the effective Rudder home,
   instance, port, and descriptor.
3. Read that instance's `runtime/server.json`; use its `apiUrl`.
4. Only fall back to shared `3100/dev` after proving the checkout has no
   isolation configuration.

Typical current commands:

```bash
pnpm dev
pnpm dev:watch
pnpm --filter @rudderhq/desktop dev
pnpm --filter @rudderhq/desktop smoke
```

### Packaged or prod-local target

Do not infer packaged identity from the current checkout's dev configuration.
Use installed-app boot evidence and the prod-local runtime. Unless an explicit
override or boot record proves otherwise, expect:

- `RUDDER_LOCAL_ENV=prod_local`
- instance `default`
- descriptor `~/.rudder/instances/default/runtime/server.json`

For package-sensitive changes, the required proof path is:

```bash
pnpm desktop:verify
```

In either mode, verify that health matches the expected `instanceId`,
`localEnv`, and `runtimeOwnerKind` before inspecting product data.

## Identity Continuity Route

Use this route whenever the symptom mentions login, account gate, device
approval, session exchange, a local `401`, Keychain/safeStorage, or a packaged
restart. A healthy API is only one stage in the path:

Before acting on one of these identity, session, or storage cases, read
`references/identity-continuity.md` for the non-secret state ledger and
evidence boundaries.

```text
target identity
-> API health
-> account authorization
-> device approval
-> server exchange
-> local claim
-> renderer session
-> Electron main-process session
-> storage/codesign capability
-> first usable workspace
-> restart persistence
```

Record the first missing transition without reading or exporting credentials.
Do not treat a `local-board` compatibility session, a healthy Identity facade,
or an existing Electron process as proof of Rudder Account login. For a real
login claim, require observable evidence of the named account/session path,
`local-exchange`/`local-claim` when applicable, and a visible post-login
workspace. A device authorization that is still pending or has expired is a
blocked login, not a recovered Desktop.

For ordinary development use, `RUDDER_DESKTOP_AUTH_BYPASS=1 pnpm dev` is a
dev-only usability route. Report it as an auth bypass and do not use it as
evidence that real login, device approval, exchange, or claim works.

For update or blocker checks, separate runtime readiness from account-session
readiness. A healthy `/api/health` plus anonymous `/api/orgs` 401 usually means
the caller did not reuse the Electron session cookie; verify the actual
main-process session request path before blaming the runtime.

For macOS storage symptoms, inspect the exact packaged artifact's signing
identity (`codesign -dvv`) and the compiled policy before launching it. An
ad-hoc/unsigned packaged app is not equivalent to a signed package. If the
policy is memory-only, report the restart/login persistence consequence. A
renderer screenshot, API health check, dev smoke, or synthetic Chromium fixture
cannot prove that a native Keychain NSAlert did not appear. For that claim,
rebuild the candidate, repeat packaged launches, and observe the native dialog
surface with an available system/UI observation path; otherwise return
`BLOCKED` with the missing proof.

## Failure Layers

Classify the first failing boundary:

1. launcher, command, or port allocation;
2. API process and health;
3. embedded PostgreSQL and migrations;
4. UI build/dev middleware;
5. Electron main process and visible window;
6. profile, instance, base URL, and organization data;
7. packaged boot/resources;
8. update download, replacement, progress pipe, restart, and relaunch;
9. resource exhaustion or stale producer processes.

Test one boundary at a time. Preserve unrelated dirty files and user data.
Never reset or delete `~/.rudder` as a diagnostic shortcut.

## Recovery Loop

1. Capture exact command, checkout, target mode, logs, and current processes.
2. Resolve the correct descriptor and health payload.
3. If the symptom is identity-related, record each continuity transition and
   stop at the first missing one.
4. Find the first failing layer.
5. Apply only a safe, reversible runtime recovery within the user's requested
   scope. Do not edit product source unless the user separately asked for a fix.
6. Restart the same target path.
7. Observe the Electron window or installed application.
8. Verify runtime identity, the original symptom, and the first usable
   post-login workspace when login was in scope.
9. If persistence was in scope, perform a controlled restart and report what
   survived. Do not infer persistence from an in-process success.

For update failures, reconstruct download, replacement, old-app exit,
progress-pipe behavior, and relaunch. Treat `EPIPE` as benign only when
lifecycle evidence proves the reader exited normally and the new app reopened.

## Report Format

```text
RESULT: RECOVERED | BLOCKED
Target mode:
Runtime identity:
Identity continuity:
First failing layer:
Action:
Observed Desktop proof:
Restart/persistence proof:
Remaining blocker:
```
