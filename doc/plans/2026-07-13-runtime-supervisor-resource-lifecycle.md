---
title: Runtime supervisor resource lifecycle
date: 2026-07-13
kind: implementation
status: completed
area: deployment
entities:
  - runtime_supervisor
  - server_lifecycle
  - resource_ownership
  - graceful_shutdown
issue:
related_plans:
  - 2026-03-26-rudder-desktop-v1.md
  - 2026-06-18-architecture-fitness-and-hotspot-extraction.md
supersedes: []
related_code:
  - server/src/index.ts
  - server/src/runtime/runtime-supervisor.ts
  - server/src/realtime/live-events-ws.ts
  - server/src/__tests__/runtime-supervisor.test.ts
  - server/src/__tests__/live-events-ws.test.ts
  - scripts/smoke/server-runtime-lifecycle.mjs
  - scripts/smoke/server-runtime-lifecycle-child.ts
commit_refs:
  - "refactor: supervise server runtime resources"
updated_at: 2026-07-14
---

# Runtime Supervisor Resource Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` and `test-driven-development` to implement this
> plan task-by-task. Keep the verifier and final reviewers separate from the
> implementation author.

**Goal:** Give the Rudder server one internal owner for process-level resources
so normal shutdown and startup failure both release acquired resources without
changing product, API, persistence, runtime, or UI behavior.

**Architecture:** Keep `startServer()` and `StartedServer` as the stable public
facade. Add a private LIFO `RuntimeSupervisor` beside the server runtime, register
each process-owned disposer immediately after acquisition, and route both
programmatic shutdown and startup rollback through the same idempotent close
path. Keep business-state runtimes and workspace services outside this owner.

**Tech Stack:** TypeScript, Node.js HTTP and process lifecycle APIs,
postgres-js/Drizzle, `ws`, Vitest, pnpm.

---

## Summary

`server/src/index.ts` currently acquires process-level resources across one long
bootstrap function and reconstructs part of the cleanup sequence at the end.
That has three confirmed gaps:

- the main postgres-js client created by `createDb()` is never ended;
- the Live Events WebSocket server, its 30-second heartbeat interval, its active
  clients, and its HTTP `upgrade` listener have no shutdown owner;
- an exception after any resource is acquired but before `startServer()` returns
  bypasses the normal `stop()` path and leaves already-acquired resources alive.

Programmatic stop also leaves the `SIGINT` and `SIGTERM` listeners installed,
which matters for Desktop-owned same-process restart. The current stop promise is
already idempotent and most cleanup failures are best-effort; this plan preserves
those semantics while making ownership explicit.

## Non-Negotiable Compatibility Guarantees

- No `doc/product/**` edits in the implementation commit; any later registry
  sync must remain documentation-only and separately authorized.
- No HTTP route, query, status, response, or authentication changes.
- No WebSocket path, authentication, payload, event ordering, or reconnect
  changes while the server is running.
- No database schema, migration, pool-size, or migration-repair changes.
- No UI, Desktop interaction, CLI command, runtime adapter, prompt, skill, or
  business-state transition changes.
- Keep the public `StartedServer` and `ManagedStartedServer` shapes unchanged.
- Keep attached-runtime shutdown behavior unchanged.
- Do not cancel Agent Runs, Chat generations, workspace runtime services, or
  in-flight HTTP requests as part of cleanup.
- Preserve best-effort shutdown: one disposer failure is logged and does not
  skip remaining resource cleanup.

The Product Logic Registry remained read-only during implementation. This is an
internal lifecycle refactor, so no product contract delta was authorized or
required for the implementation commit.

Post-implementation contract sync (2026-07-14): the user later explicitly
authorized updating `doc/product/**`. The delivered observable lifecycle
guarantees are now recorded as `CONTROL.SERVER.LIFECYCLE.001` without changing
runtime or business behavior. The contract deliberately scopes ownership to
resources registered with the server lifecycle owner and records unbounded HTTP
drain, shared-PostgreSQL black-box coverage, and deferred teardown work as known
gaps.

## Target Boundary

```text
startServer(options)
  -> create private RuntimeSupervisor
  -> supervisedStart(() => startServerRuntime(options, supervisor))
       -> own each resource immediately after acquisition
       -> return unchanged StartedServer { stop, dispose, ... }

normal stop / dispose         startup exception
          |                         |
          +------> supervisor.dispose() <------+
                         |
                 reverse acquisition order
                         |
       continue after failures and report resource names
```

The intended normal close order is:

1. remove process signal handlers;
2. initiate HTTP close so no new work is accepted, without waiting on upgraded
   WebSocket connections;
3. clear scheduler intervals and disable/stop Feishu ingestion;
4. close Live Events WebSocket clients, heartbeat, and upgrade listener;
5. await HTTP drain completion after upgraded connections are gone;
6. close the app/plugin host;
7. end the main postgres-js pool;
8. stop embedded PostgreSQL only when this process started it;
9. remove the owned runtime descriptor.

Exact reverse order comes from registration order. The HTTP drain waiter is
registered when the server is created, while a non-blocking ingress-close
trigger is registered immediately after successful listen. This lets shutdown
stop new requests first, close upgraded WebSockets, and only then await the HTTP
close callback without cancelling in-flight HTTP requests or deadlocking on an
active WebSocket.

## Scope

In scope:

- a small server-internal RuntimeSupervisor with named LIFO disposers;
- concurrent and repeated dispose idempotency;
- cleanup failure isolation and named reporting;
- startup rollback that rethrows the original startup error;
- explicit ownership of the main DB client, embedded PostgreSQL, app handle,
  HTTP server, Live Events WebSocket runtime, server scheduler intervals,
  Feishu runtime/registry, runtime descriptor, and signal listeners;
- a closable Live Events WebSocket handle;
- a real programmatic start/health/WebSocket/stop/restart smoke in an isolated
  `RUDDER_HOME`.

Out of scope for this commit:

- Vite middleware/HMR close ownership;
- plugin host `exit`/`beforeExit` listener removal and tool-dispatcher teardown;
- draining fire-and-forget startup recovery, scheduler ticks, backups, plugin
  loading, or Feishu startup promises;
- transactional outbox, activity authorization, logging redaction, migration
  hardening, or architecture CI wiring;
- workspace runtime ownership or new run-cancellation behavior;
- Desktop packaging changes.

Those items require their own focused plans because they have separate race,
failure-injection, and product-proof surfaces.

## Task 1: Add The Internal RuntimeSupervisor

**Files:**

- Create: `server/src/runtime/runtime-supervisor.ts`
- Create: `server/src/__tests__/runtime-supervisor.test.ts`

- [x] **Step 1: Write failing lifecycle tests**

Add tests for reverse-order disposal, awaited async cleanup, concurrent
idempotency, failure continuation, named error reporting, registration rejection
after disposal begins, and startup rollback preserving the original error.

```ts
const events: string[] = [];
const supervisor = new RuntimeSupervisor();
supervisor.own("database", async () => events.push("database"));
supervisor.own("http", async () => events.push("http"));

await Promise.all([supervisor.dispose(), supervisor.dispose()]);

expect(events).toEqual(["http", "database"]);
```

```ts
const startupError = new Error("listen failed");
await expect(supervisedStart(supervisor, async () => {
  supervisor.own("database", closeDatabase);
  throw startupError;
})).rejects.toBe(startupError);
expect(closeDatabase).toHaveBeenCalledTimes(1);
```

- [x] **Step 2: Run the suite and verify RED**

Run:

```bash
pnpm exec vitest run server/src/__tests__/runtime-supervisor.test.ts
```

Expected: fail because `server/src/runtime/runtime-supervisor.ts` does not
exist.

- [x] **Step 3: Implement the minimal supervisor**

Implement this internal interface:

```ts
export type RuntimeDisposer = () => void | Promise<void>;

export class RuntimeSupervisor {
  constructor(options?: {
    onDisposeError?: (failure: { name: string; error: unknown }) => void;
  });
  own(name: string, dispose: RuntimeDisposer): void;
  dispose(): Promise<void>;
}

export async function supervisedStart<T>(
  supervisor: RuntimeSupervisor,
  start: () => Promise<T>,
): Promise<T>;
```

`dispose()` must pop entries from the internal stack, await every disposer,
report and swallow individual failures, and share one in-flight operation across
concurrent callers. `supervisedStart()` must dispose on failure and rethrow the
original error object.

- [x] **Step 4: Run the suite and verify GREEN**

Run the same Vitest command. Expected: all RuntimeSupervisor tests pass.

## Task 2: Give Live Events WebSocket An Explicit Close Handle

**Files:**

- Modify: `server/src/realtime/live-events-ws.ts`
- Create: `server/src/__tests__/live-events-ws.test.ts`

- [x] **Step 1: Lock current runtime behavior and write failing cleanup tests**

Use a real Node HTTP server and `ws` client in `local_trusted` mode. Prove the
existing event JSON still arrives, then require a returned handle whose close
operation:

- removes only the setup function's own HTTP `upgrade` listener;
- clears the heartbeat interval;
- unsubscribes and terminates active clients;
- closes the `WebSocketServer`;
- is safe under repeated and concurrent calls.

```ts
const initialUpgradeListeners = server.listenerCount("upgrade");
const runtime = setupLiveEventsWebSocketServer(server, fakeDb, {
  deploymentMode: "local_trusted",
});

expect(server.listenerCount("upgrade")).toBe(initialUpgradeListeners + 1);
await Promise.all([runtime.close(), runtime.close()]);
expect(server.listenerCount("upgrade")).toBe(initialUpgradeListeners);
```

- [x] **Step 2: Run the suite and verify RED**

Run:

```bash
pnpm exec vitest run server/src/__tests__/live-events-ws.test.ts
```

Expected: fail because the current function returns the raw WSS without the
required close contract or listener cleanup.

- [x] **Step 3: Implement the close handle**

Keep `setupLiveEventsWebSocketServer()` and all authorization/event behavior.
Name the upgrade callback so it can be removed. Return:

```ts
export interface LiveEventsWebSocketRuntime {
  close(): Promise<void>;
}
```

On close, mark the runtime closing, detach the upgrade listener, clear the ping
interval defensively, run each client subscription disposer once, terminate the
clients, clear the tracking maps, and await WSS close. Reject new authorization
completions after closing has begun.

- [x] **Step 4: Run the suite and verify GREEN**

Run the same Vitest command. Expected: current local-trusted event delivery and
all close cases pass.

## Task 3: Rewire startServer Through The Supervisor

**Files:**

- Modify: `server/src/index.ts`
- Create: `scripts/smoke/server-runtime-lifecycle.mjs`
- Create: `scripts/smoke/server-runtime-lifecycle-child.ts`

- [x] **Step 1: Add a failing programmatic lifecycle smoke**

The parent script creates a temporary `RUDDER_HOME`, selects a free API port,
and launches the TypeScript child with a hard deadline. The child must:

1. record baseline `SIGINT` and `SIGTERM` listener counts;
2. call `startServer()` with UI, heartbeat scheduling, and automatic backups
   disabled;
3. read `/api/health` and open a local-trusted Live Events WebSocket;
4. call `stop()` and `dispose()` concurrently;
5. observe the WebSocket close, removal of Rudder's signal handlers, and no
   signal-listener growth across repeated starts (the embedded PostgreSQL
   dependency keeps one process-global async exit hook);
6. confirm the owned runtime descriptor is gone;
7. bind the released API and embedded PostgreSQL ports;
8. start and stop the same isolated instance a second time;
9. exit naturally without `process.exit()`.

Run:

```bash
node scripts/smoke/server-runtime-lifecycle.mjs
```

Expected before integration: fail or time out because the DB client, WSS
heartbeat/upgrade listener, and signal listeners are not all released.

- [x] **Step 2: Add the supervised startup wrapper**

Keep the public function signature and move the current body behind a private
entrypoint without a large indentation rewrite:

```ts
export async function startServer(options: StartServerOptions = {}): Promise<StartedServer> {
  const supervisor = new RuntimeSupervisor({
    onDisposeError: ({ name, error }) => {
      logger.warn({ err: error, resource: name }, "Runtime resource cleanup failed");
    },
  });
  return supervisedStart(supervisor, () => startServerRuntime(options, supervisor));
}
```

- [x] **Step 3: Register process-owned resources**

Register guarded descriptor removal before later resources so it closes last.
Register owned embedded PostgreSQL, `db.$client.end({ timeout: 5 })`,
the app handle, WebSocket runtime, Feishu runtime/registry, and each scheduler
interval immediately after acquisition. Register an HTTP drain waiter when the
server is created and a non-blocking ingress-close trigger immediately after
successful `listen()`, then register named signal-listener removal.

Preserve the existing `stop()` and `dispose()` facade names:

```ts
const stop = () => {
  if (!shutdownEventSent) {
    shutdownEventSent = true;
    options.onEvent?.({ stage: "shutdown", message: "Stopping Rudder server" });
  }
  return supervisor.dispose();
};
```

- [x] **Step 4: Run focused unit and lifecycle proof**

Run:

```bash
pnpm exec vitest run \
  server/src/__tests__/runtime-supervisor.test.ts \
  server/src/__tests__/live-events-ws.test.ts
node scripts/smoke/server-runtime-lifecycle.mjs
```

Expected: all unit tests pass; the child starts, serves health and WebSocket,
stops concurrently, restarts, stops again, and exits naturally within the
deadline.

## Task 4: Compatibility, Verification, Review, And Git Handoff

**Files:**

- Modify: `doc/plans/2026-07-13-runtime-supervisor-resource-lifecycle.md`

- [x] **Step 1: Prove forbidden paths and public contracts are unchanged**

Run:

```bash
git diff --name-only -- doc/product packages/db/src/schema packages/db/src/migrations ui/src desktop/src packages/shared/src
```

Expected: no output.

- [x] **Step 2: Run repository validation**

Run:

```bash
pnpm lint
pnpm -r typecheck
pnpm test:run --maxWorkers=1
pnpm build
pnpm product-logic:check
pnpm architecture:audit
```

Record any existing baseline failures exactly and isolate every new failure.
Do not edit unrelated UI or test files to make the suite look green.

Desktop packaging is not required because no Desktop code or packaging path
changes. The programmatic start/stop/restart smoke is the terminal proof for the
affected server lifecycle.

- [x] **Step 3: Spawn the black-box verifier**

The verifier must not edit, stage, commit, or push. It must independently run
the focused tests and lifecycle smoke, inspect the public `StartedServer` shape,
confirm forbidden paths are untouched, and verify that the child exits naturally
without a forced process exit.

- [x] **Step 4: Run three final reviewer lenses**

- Functional trust: cleanup order, DB/embedded ownership, public compatibility,
  validation evidence, and git scope.
- Adversarial: double-close races, disposer failures, startup rollback, WS
  authorization completion after close, and accidentally stopping shared
  resources.
- Heuristic/product-systems: whether the supervisor is the smallest durable
  boundary and whether deferred Vite/plugin/task-drain work is honestly scoped.

Resolve every non-accept verdict before handoff.

- [x] **Step 5: Update evidence, commit, and push**

Update this plan to `status: completed`, add the validation/verifier/reviewer
evidence, and set `commit_refs` to the final Conventional Commit subject. Stage
only the plan, supervisor, lifecycle tests/smoke, WebSocket runtime, and
`server/src/index.ts`.

Commit with:

```bash
git commit -m "refactor: supervise server runtime resources"
```

Push `codex/runtime-supervisor-lifecycle` only after verifier and reviewer gates
pass.

## Success Criteria

- Normal stop, repeated stop, concurrent stop, and startup rollback use one
  internal disposal path.
- Every registered resource is disposed at most once in reverse order.
- One cleanup failure never skips later resources.
- Startup failure rethrows the original failure after best-effort rollback.
- The main DB client closes before owned embedded PostgreSQL stops.
- Live Events runtime shutdown removes the upgrade listener, heartbeat timer,
  subscriptions, and clients without changing normal event behavior.
- Programmatic stop removes Rudder's signal listeners, does not accumulate
  listeners across restarts, and permits same-process restart.
- The lifecycle smoke exits naturally and both API and DB ports can be rebound.
- Public API, `StartedServer`, schema, UI, runtime adapters, and product logic
  remain unchanged.

## Writer Validation Evidence

- Focused RED/GREEN proof:
  - `RuntimeSupervisor` tests failed before the implementation existed, then
    passed after the minimal supervisor was added.
  - Live Events cleanup tests failed against the former raw WebSocket server
    return value, then passed after explicit close ownership was added.
  - Final focused result: 14 tests passed across
    `runtime-supervisor.test.ts` and `live-events-ws.test.ts`.
  - Reviewer-driven RED/GREEN cases prove that a throwing cleanup reporter
    cannot interrupt later disposers or replace the original startup error, and
    that a pending authenticated WebSocket upgrade cannot block HTTP shutdown.
  - Final adversarial RED/GREEN cases prove external concurrent callers share
    the outer disposal promise, while disposer-internal synchronous and async
    reentry resolves as a no-op instead of self-awaiting. Nested `own()` remains
    rejected and strict awaited LIFO order is kept.
- Repository gates:
  - `pnpm lint`: passed across 1,897 files.
  - `pnpm -r typecheck`: passed across all 21 workspace projects.
  - `pnpm build`: passed. Existing CSS pseudo-element and bundle-size warnings
    remain advisory.
  - `pnpm product-logic:check`: 67 contracts valid.
  - `pnpm architecture:audit`: passed with the repository's existing
    warning-only hotspot and list-path inventory.
  - `git diff --check`: passed.
- Full test run:
  - Final `pnpm test:run --maxWorkers=1`: 493 files passed and 4 files failed;
    3,937 tests passed, 7 failed, and 2 skipped.
  - The two `Chat.attachment-preview.test.tsx` Side Panel/Library failures and
    all three `OnboardingWizard.runtime-config.test.tsx` failures reproduced in
    a detached clean worktree at
    `origin/main@b98d06d551a157d96c8c9d2fdb868785e606e5fa`; they are existing
    baseline failures outside this server-only slice.
  - On the earlier pre-removal base, the Instance Settings Langfuse-mode and Run
    Intelligence Langfuse-link failures both passed immediately when isolated.
    An earlier automation reactivation failure also passed in isolation and
    passed in the final full run. These were full-suite shared-state failures,
    not stable regressions.
  - After rebasing onto `origin/main@805178987db4280279795537941b675719d851d8`,
    the latest `pnpm test:run --maxWorkers=1` passed 500 files and failed one:
    3,978 tests passed, one failed, and two skipped. The only failure was an
    `issue-lifecycle-routes.test.ts` reopen-comment status assertion; that file
    does not import the changed server startup, WebSocket, or supervisor paths,
    and its full 67-test file passed immediately in isolation. No lifecycle
    test failed.
  - After the final reentry fix on
    `origin/main@bdeabe5738b0055998f1de5543f3cd41ad0e32b7`, the full suite
    again passed 500 files and failed one: 3,980 tests passed, one failed, and
    two skipped. The only failure was an `agent-permissions-routes.test.ts`
    deferred-wakeup mock assertion; the file does not import any changed path
    and passed all 14 tests immediately in isolation. All 14 lifecycle-focused
    tests passed in the full run.
- Terminal lifecycle proof:
  - `node scripts/smoke/server-runtime-lifecycle.mjs`: passed with
    `SERVER_RUNTIME_LIFECYCLE_OK`.
  - The child completed two start/health/WebSocket/concurrent-stop cycles,
    removed Rudder-owned signal listeners and the runtime descriptor, rebound
    the same API and embedded PostgreSQL ports, and exited naturally.
  - The third-party embedded PostgreSQL package retains one process-global
    async-exit signal hook; listener counts did not grow across restarts.
- Compatibility boundary:
  - No diff under `doc/product/`, `packages/db/`, `packages/shared/`, `ui/`,
    `desktop/`, `cli/`, or public `docs/`.
  - No API, schema, UI, runtime-adapter, product-contract, or business-state
    change was introduced.
- Initial independent verifier: `PASS`, superseded after final reviewers found
  additional shutdown races and the artifact changed.
  - Re-ran the focused tests: 2 files and 9 tests passed.
  - Re-ran the complete lifecycle smoke and independently observed both
    start/health/WebSocket/concurrent-stop cycles, port reuse, signal-listener
    stability, descriptor removal, and natural child exit.
  - Added a real startup rollback fault injection after embedded PostgreSQL and
    the main DB were initialized. The original startup error was preserved, the
    API and DB ports were immediately reusable, the child emitted
    `SERVER_STARTUP_ROLLBACK_OK`, and it exited naturally.
  - Confirmed the public `StartedServer` and `ManagedStartedServer` interface
    sections have no diff and all forbidden paths remain untouched.
  - Used only isolated temporary `RUDDER_HOME` directories; both were cleaned
    by the verification scripts and the verifier made no repository edits.

## Reviewer Reconciliation

The initial final-review round did not pass and was returned to implementation:

- Functional and heuristic reviewers found that registering one awaited HTTP
  disposer before WSS/Feishu/schedulers made LIFO stop those resources before
  HTTP ingress, contradicting the plan and leaving a partial-shutdown request
  window.
- Moving the single awaited HTTP disposer to the top then made the real
  lifecycle smoke time out because Node's HTTP close waited on the upgraded
  WebSocket before the supervisor could reach the WSS disposer.
- The reconciled implementation splits HTTP shutdown into a non-blocking
  ingress-close trigger after successful listen and an earlier drain waiter,
  preserving both ingress-first shutdown and WebSocket-safe completion.
- The adversarial reviewer reproduced a pending authenticated upgrade that
  blocked HTTP close and a throwing cleanup reporter that skipped later
  disposers and replaced the original startup error. Both now have regression
  tests and minimal fixes.
- Live Events cleanup now tracks and destroys pending raw upgrade sockets,
  ignores late authorization failures during close, and isolates per-client
  subscription cleanup before terminating the remaining clients.
- The Round 2 adversarial reviewer then reproduced synchronous disposer reentry
  before `disposeInFlight` was assigned. `dispose()` now assigns the shared
  promise before invoking any disposer by deferring execution through a resolved
  promise, and the focused suite includes the nested `dispose()` / rejected
  `own()` regression.

Because code changed after the initial verifier and reviewers, their verdicts
are evidence for the fixes but not the final handoff gate. A fresh verifier and
three fresh reviewer verdicts are required below.

Final independent verifier Round 2: `PASS`.

- Personally ran the focused suites: 2 files and 11 tests passed.
- Personally ran the real two-cycle lifecycle smoke and observed health,
  WebSocket close, concurrent stop/dispose, stable signal-listener counts,
  descriptor cleanup, same-port restart/rebind, and natural child exit.
- Personally reran the post-DB startup rollback injection and observed the
  original authenticated-mode error, immediate API/DB port reuse,
  `SERVER_STARTUP_ROLLBACK_OK`, and natural exit.
- Inspected the pending-auth test's real HTTP/WS actor path and confirmed the
  two-phase LIFO order from signal listener removal through descriptor cleanup.
- Confirmed public server handle shapes, forbidden paths, diff scope, and
  `git diff --check`; no repository mutation or substituted proof was used.

Round 3 writer evidence on the final implementation and latest main:

- Rebased without conflict from `b98d06d551a157d96c8c9d2fdb868785e606e5fa`
  onto `origin/main@805178987db4280279795537941b675719d851d8`; none of
  the 38 intervening commits changed the eight scoped files.
- `pnpm lint`: passed across 1,910 files.
- `pnpm -r typecheck`: all 21 workspace projects passed.
- `pnpm build`: passed with existing advisory CSS, bundle-size, peer dependency,
  and packaged-bin warnings.
- `pnpm product-logic:check`: 69 contracts valid.
- `pnpm architecture:audit`: passed with warning-only existing hotspot and
  list-path inventory.
- Focused suites: 2 files and 12 tests passed.
- Real two-cycle lifecycle smoke: `SERVER_RUNTIME_LIFECYCLE_OK`, including
  health, WebSocket close, concurrent stop/dispose, signal-listener stability,
  descriptor removal, same-port restart/rebind, and natural child exit.
- Full suite: 500 files passed, one unrelated order-dependent file failed;
  3,978 tests passed, one failed, and two skipped. The full failing file passed
  67/67 immediately in isolation.
- While the verifier was running, `origin/main` advanced once more to
  `bdeabe5738b0055998f1de5543f3cd41ad0e32b7` for a canary base version bump.
  That commit did not touch any scoped file. The artifact rebased without
  conflict and the focused 12/12 tests plus real lifecycle smoke both passed
  again on the new final base.

Independent verifier Round 3: `PASS`, superseded after a final reviewer found
another reentry deadlock and the artifact changed.

- Personally ran the focused suites: 2 files and 12 tests passed, including
  synchronous disposer reentry.
- Personally ran the real two-cycle lifecycle smoke and observed API/DB port
  reuse, health, WebSocket close, concurrent/repeated stop and dispose,
  descriptor and signal-listener cleanup, restart, and natural exit.
- Personally reran the post-DB startup rollback probe: the intended
  authenticated-mode startup error remained the original error, API and DB
  ports rebound immediately, `SERVER_STARTUP_ROLLBACK_OK` was emitted, and the
  child exited naturally.
- Confirmed the public `StartedServer` and `ManagedStartedServer` shapes,
  eight-file scope, forbidden paths, and `git diff --check` against the fixed
  verifier basis. The verifier created no repository changes and used no
  substituted terminal proof.
- The verifier's stale-base blocker was resolved by rebasing onto
  `bdeabe5738b0055998f1de5543f3cd41ad0e32b7` and rerunning focused tests plus
  lifecycle smoke as recorded above.

The Round 3 final-review gate did not pass and returned to implementation:

- Heuristic/product-systems review accepted the scoped boundary and evidence.
- Adversarial review reproduced a self-await deadlock when a disposer returned
  `supervisor.dispose()`. The outer loop awaited the disposer, while the nested
  call returned the outer loop's own promise, so older resources never ran.
- Two bounded RED tests reproduced both direct-return reentry and async reentry
  after an `await`; both timed out against the prior implementation.
- `RuntimeSupervisor` now uses `AsyncLocalStorage` to distinguish calls from the
  active disposer's async chain. Disposer-internal `dispose()` is an immediate
  no-op, while external concurrent callers still receive the shared outer
  promise and wait for complete cleanup.
- The focused suites now pass 14/14, including both deadlock regressions,
  external promise identity, rejected late ownership, strict LIFO, reporter
  isolation, pending authenticated upgrades, and Live Events cleanup.
- Functional review was interrupted because the artifact had already changed;
  all three lenses require a fresh final round after the next verifier.

Round 4 writer evidence on `bdeabe5738b0055998f1de5543f3cd41ad0e32b7`:

- `pnpm lint`: passed across 1,910 files.
- `pnpm -r typecheck`: all 21 workspace projects passed.
- `pnpm build`: passed with existing advisory warnings only.
- `pnpm product-logic:check`: 69 contracts valid.
- `pnpm architecture:audit`: passed with warning-only existing inventory.
- Focused suites: 2 files and 14 tests passed.
- Real two-cycle lifecycle smoke: `SERVER_RUNTIME_LIFECYCLE_OK`.
- Full suite: 500 files passed and one unrelated order-dependent file failed;
  3,980 tests passed, one failed, and two skipped. The full failing file passed
  14/14 immediately in isolation.

Round 5 writer evidence on `c351b07651eba6ee904ce84f687632e57c026a05`:

- Rebased onto the latest `origin/main`, including
  `adf7c816c refactor: remove Langfuse integration`. The overlapping
  `server/src/index.ts` lifecycle wiring was reconciled without restoring any
  removed Langfuse ownership, configuration, tests, or behavior.
- `pnpm lint`: passed across 1,898 files.
- `pnpm -r --aggregate-output typecheck`: all 21 workspace projects passed.
- `pnpm build`: passed with the repository's existing advisory CSS
  pseudo-element, bundle-size, peer-dependency, and packaged-bin warnings.
- `pnpm product-logic:check`: 69 contracts valid.
- `pnpm architecture:audit`: passed with warning-only existing hotspot and
  list-path inventory.
- Focused suites: 2 files and 14 tests passed.
- Real two-cycle lifecycle smoke: `SERVER_RUNTIME_LIFECYCLE_OK`.
- Full suite: 494 files passed and two order-dependent files failed; 3,926
  tests passed, two failed, and two skipped. The Feishu setup URL route file
  passed 10/10 immediately in isolation, and the chat routes file passed 94/94
  immediately in isolation. Neither failed file imports the changed startup,
  WebSocket, or supervisor paths.
- The branch and `origin/main` were aligned at `c351b07` when writer checks
  began. A final fetch and stale-base reconciliation remain required after the
  verifier and reviewer gates.

Round 5 verification and review did not pass the final handoff gate:

- The independent verifier passed focused 14/14, its direct-return,
  post-`await`, and external-concurrency probe, the real lifecycle smoke, and
  the post-DB startup rollback probe on `c351b07`.
- The adversarial reviewer then reproduced a detached async descendant that
  inherited the boolean disposer context after its originating disposer had
  completed. Its nested `dispose()` resolved before an older blocked resource,
  exposing a partial-shutdown race.
- The heuristic reviewer also found that the per-supervisor
  `AsyncLocalStorage` instance was never disabled, so same-process restarts
  could accumulate entries in Node's global async-context registry.
- Two RED tests reproduced both failures: the detached descendant received a
  different immediately resolved promise, and `disable()` was never called.
- The supervisor now stores a unique token for each disposer and treats
  reentry as internal only while that exact token remains active. Detached
  descendants return the shared outer disposal promise once their originating
  disposer has completed. The resource-drain `finally` block clears active
  tokens and disables the async context after cleanup.

Round 6 writer evidence on the revised `c351b07` artifact:

- Focused suites: 2 files and 16 tests passed, including detached-descendant
  waiting and async-context teardown.
- `pnpm lint`: passed across 1,898 files.
- `pnpm -r --aggregate-output typecheck`: all 21 workspace projects passed.
- `node scripts/smoke/server-runtime-lifecycle.mjs`: passed with
  `SERVER_RUNTIME_LIFECYCLE_OK` after two real start/health/WebSocket/stop and
  restart cycles, port reuse, descriptor/signal cleanup, and natural exit.
- `pnpm build`: passed with existing advisory CSS, bundle-size,
  peer-dependency, and packaged-bin warnings.
- `pnpm product-logic:check`: 69 contracts valid.
- `pnpm architecture:audit`: passed with warning-only existing hotspot and
  list-path inventory.
- Full suite: 492 files passed and four order-dependent files failed; 3,925
  tests passed, five failed, and two skipped. The four failing files passed
  completely in isolated processes: activity routes 8/8, organization skill
  routes 6/6, heartbeat retry routes 9/9, and sidebar badges 3/3. None imports
  the changed startup, WebSocket, or supervisor paths.
- The Round 5 verifier and reviewer verdicts are superseded because the
  supervisor and tests changed. A fresh verifier and all three reviewer lenses
  are required before completion.

Final independent verifier Round 6: `PASS`.

- Personally ran focused suites: 2 files and 16 tests passed.
- An independent bounded token probe proved direct-return and post-`await`
  active self-reentry, external concurrent promise identity, detached
  descendant promise identity and waiting, empty active-token state, cleared
  async context, and exactly one `disable()` call.
- Personally ran the real two-cycle lifecycle smoke and the post-DB startup
  rollback probe. Health, WebSocket shutdown, concurrent stop/dispose, restart,
  API/DB port reuse, original-error preservation, and natural exit all passed.
- Confirmed the public server handles, exact eight-file scope, forbidden paths,
  clean diffs, and absence of restored Langfuse code. No substituted terminal
  proof or repository mutation was used.

Final reviewer Round 6:

- Functional trust: `accept`. Independently reran focused 16/16 and the real
  two-cycle lifecycle smoke, then confirmed cleanup order, ownership guards,
  public compatibility, git scope, and unchanged product boundaries.
- Adversarial: `accept`. Independently reproduced the detached-descendant,
  active-reentry, external-concurrency, reporter-failure, and teardown probes;
  the Round 5 partial-shutdown attack no longer succeeds.
- Heuristic/product-systems: `accept`. Confirmed that per-disposer tokens plus
  the active set and final async-context teardown are the smallest durable
  boundary, and that deferred Vite/plugin/background/database/fitness work is
  still honestly scoped.
- Final fetch confirmed `HEAD == origin/main == c351b07` with ahead/behind
  `0/0` before the scoped commit.

## Rollback

Revert the single scoped commit. The old inline `stop()` sequence and raw WSS
setup return immediately resume; there is no persisted state, schema, API, UI,
or migration cleanup.

## Deferred Follow-On Slices

1. App/plugin lifecycle: Vite close ownership, plugin process hook removal,
   tool-dispatcher teardown, compare-and-clear global event bus, and plugin
   startup task drain.
2. Background task drain: heartbeat/chat recovery, scheduled backups, Feishu
   startup, and plugin loading tracked without changing ready-state semantics.
3. Database/migration hardening: strict migration-history validation and
   explicit pool configuration in a separate compatibility plan.
4. Architecture fitness: CI ratchets for newly introduced process resources and
   new/growing hotspot files.
