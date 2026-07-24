---
name: rudder-desktop-dev-recovery-maintainer
description: "Use when Rudder Desktop or its development shell will not launch, points at the wrong instance, fails during update/restart, or differs between dev and packaged execution. Recovers one verified Desktop path and returns RECOVERED or BLOCKED."
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
3. Find the first failing layer.
4. Apply only a safe, reversible runtime recovery within the user's requested
   scope. Do not edit product source unless the user separately asked for a fix.
5. Restart the same target path.
6. Observe the Electron window or installed application.
7. Verify runtime identity and the original symptom.

For update failures, reconstruct download, replacement, old-app exit,
progress-pipe behavior, and relaunch. Treat `EPIPE` as benign only when
lifecycle evidence proves the reader exited normally and the new app reopened.

## Report Format

```text
RESULT: RECOVERED | BLOCKED
Target mode:
Runtime identity:
First failing layer:
Action:
Observed Desktop proof:
Remaining blocker:
```
