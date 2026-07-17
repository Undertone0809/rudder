---
title: Server Runtime Lifecycle
domain: control-plane
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - CONTROL.SERVER.LIFECYCLE.001
related_code:
  - server/src/index.ts
  - server/src/app.ts
  - server/src/bootstrap/create-http-app.ts
  - server/src/bootstrap/plugin-host-runtime.ts
  - server/src/routes/chat-background-runtime.ts
  - server/src/services/plugin-dev-watcher.ts
  - server/src/runtime/runtime-supervisor.ts
  - server/src/realtime/live-events-ws.ts
related_tests:
  - server/src/__tests__/app-lifecycle.test.ts
  - server/src/__tests__/chat-background-runtime.test.ts
  - server/src/__tests__/http-app-vite-lifecycle.test.ts
  - server/src/__tests__/plugin-dev-watcher.test.ts
  - server/src/__tests__/plugin-host-runtime-lifecycle.test.ts
  - server/src/__tests__/runtime-supervisor.test.ts
  - server/src/__tests__/live-events-ws.test.ts
  - scripts/smoke/server-runtime-lifecycle.mjs
  - scripts/smoke/server-runtime-lifecycle-child.ts
related_plans:
  - doc/plans/2026-07-13-runtime-supervisor-resource-lifecycle.md
  - doc/plans/2026-07-17-safe-change-throughput-architecture-optimization.md
edit_policy: user_confirmed_only
---

# Server Runtime Lifecycle

## CONTROL.SERVER.LIFECYCLE.001

## Contract Summary

Rudder must release resources explicitly registered with the server lifecycle
owner through one consistent, awaited lifecycle when startup fails or the
running server stops. Normal, repeated, and concurrent stop requests must
converge on the same cleanup rather than racing independent shutdown paths.

This contract protects runtime availability and restartability. It does not
change API responses, persisted business data, agent execution semantics, or UI
behavior.

## Intent / User Job

An operator or Desktop host must be able to start, stop, and programmatically
restart a Rudder server without lifecycle-owned listeners, WebSocket clients,
database connections, owned embedded PostgreSQL processes, or runtime
descriptors leaking and preventing the next start or keeping the old process
alive.

## Why / Design Reasoning

The server acquires resources across process, network, database, scheduler, and
integration boundaries. Independent cleanup branches make shutdown order depend
on the trigger, so startup rollback can miss resources and repeated stops can
race each other.

Rudder therefore uses one ownership-aware lifecycle for startup rollback and
running-server shutdown. Cleanup runs in a safe reverse-acquisition order,
continues after an individual cleanup failure, and never replaces the original
startup error with a secondary cleanup error.

## Actors / Objects / State

- Actors: local operator, Desktop host, process signal handler, and test or
  embedding code that starts and stops the server programmatically.
- Lifecycle-owned runtime objects: HTTP listener, Vite middleware/HMR runtime,
  Live Events WebSocket runtime, Chat recovery/projector/queue timers and
  tracked queue work, scheduler intervals, integration and plugin host
  runtimes, application handle, database client pool, optional embedded
  PostgreSQL instance, runtime descriptor, and process signal listeners.
- Ownership state: whether the current process acquired a resource and, for
  embedded PostgreSQL, whether this process started that database instance.
- Lifecycle state: accepting new work, disposal in flight, or disposal
  completed.

## Entry Points / Inputs

- `startServer()` acquires server resources and returns a `stop()` operation.
- A startup exception after partial acquisition triggers rollback for resources
  already registered with the lifecycle owner.
- A caller invokes `stop()`, including repeated or concurrent invocations.
- `SIGINT` or `SIGTERM` invokes the same stop operation before process exit.

## Product Logic Flow

1. As each resource enters explicit server lifecycle ownership, the server
   registers its cleanup with the lifecycle owner.
2. Application construction immediately registers the plugin host, then the
   HTTP application and any owned Vite middleware/HMR runtime. A later
   application-start failure rolls those resources back in reverse acquisition
   order.
3. Plugin discovery and tool-dispatcher warm-up do not block HTTP readiness,
   but remain tracked startup work. Plugin shutdown prevents a new start,
   removes its process listeners, stops new scheduler and watcher work, awaits
   tracked startup work, and then completes dispatcher and plugin teardown
   exactly once.
4. The HTTP application owns one Chat background runtime. It schedules Chat
   control recovery, terminal projection, queue drains, queue lease renewal,
   and claimed queue execution. Application close rejects new scheduled work,
   clears owned timers, aborts owned queue execution, and awaits tracked work
   before releasing the runtime.
5. After the HTTP listener starts, shutdown first stops new HTTP ingress.
6. Scheduler and integration activity is detached, active and pending Live
   Events WebSocket work is closed, and the HTTP server is allowed to drain.
7. The application handle, including owned Chat and Vite runtimes, and database client
   pool close after network work no longer depends on them.
8. Embedded PostgreSQL stops only when the current process started it; an
   externally managed or already-running PostgreSQL service remains running.
9. The current process removes only the runtime descriptor it owns.
10. Startup failure follows the same cleanup path and then rethrows the original
   startup error.

Cleanup of registered resources is awaited, idempotent, and failure-isolated:
one resource failure is reported but does not skip later cleanup work.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Normal stop | Server is running, its active HTTP requests can drain, and `stop()` or a process signal requests shutdown | New ingress stops, registered resources close in safe order, and shutdown completes | Lifecycle-owned listeners, timers, DB resources, or descriptors remain solely because shutdown used a particular entry point | Lifecycle smoke and focused supervisor tests |
| Repeated or concurrent stop | Disposal is already running or completed | Every caller observes the same in-flight or completed cleanup | A second cleanup races the first, closes a resource twice, or emits duplicate shutdown lifecycle events | `runtime-supervisor.test.ts` and lifecycle smoke |
| Startup failure | Startup throws after acquiring and registering one or more resources | Registered resources are released and the original startup error is returned to the caller | Registered cleanup is skipped, or a cleanup error replaces the startup failure | `runtime-supervisor.test.ts` |
| Application startup failure | HTTP app construction or prompt plugin-host startup fails after the plugin runtime is owned | The app-local supervisor closes acquired resources once in reverse order and returns the original error | Plugin process listeners or an acquired Vite runtime survive the failed app creation | `app-lifecycle.test.ts` |
| Deferred plugin warm-up | Plugin discovery or tool-dispatcher initialization remains in flight after the HTTP app is ready | Readiness is not delayed; close stops new scheduler, watcher, and listener work, then waits for tracked startup work before final dispatcher and worker teardown | Shutdown races startup work or accumulates process listeners across same-process restarts | `plugin-host-runtime-lifecycle.test.ts` |
| Chat background work | Chat recovery, terminal projection, queue drain, lease renewal, or a claimed server-owned continuation is scheduled or running | HTTP application close stops new claims and timers, aborts owned queue execution, and waits for tracked work before completing | A stopped application leaves an old Chat worker claiming work beside a same-process replacement | `chat-background-runtime.test.ts` and `http-app-vite-lifecycle.test.ts` |
| Active or pending WebSocket work | Live Events clients are connected or authenticated upgrade authorization is pending | Subscriptions, heartbeat work, clients, pending upgrade sockets, and the owned upgrade listener close without blocking HTTP shutdown | A pending upgrade keeps the HTTP listener or process alive | `live-events-ws.test.ts` |
| Shared PostgreSQL | The server uses an external or previously running PostgreSQL instance | Rudder closes its client pool but leaves the shared database service running | The current server process stops a database service it does not own | Ownership guard in `server/src/index.ts`; lifecycle smoke proves the owned embedded case |
| Cleanup failure | One resource disposer throws or its error reporter fails | Remaining resources still close; startup rollback preserves its original error | One failure aborts the rest of cleanup | `runtime-supervisor.test.ts` |
| Programmatic restart | A server is stopped and started again in the same isolated child process with the same runtime home and configured ports | The API becomes healthy again, required ports are reusable, and the child process exits naturally after the final stop | A stale listener, pool, timer, descriptor, or owned PostgreSQL process blocks restart or process exit | `server-runtime-lifecycle.mjs` |

## Actor-Visible Input

There is no new API, CLI, UI, or agent prompt input. Existing callers continue
to use `startServer()`, the returned `stop()` operation, and normal process
signals.

## Operator-Visible Output

- Normal API and UI behavior remains unchanged while the server is running.
- Startup and shutdown lifecycle events remain available to existing hosts.
- Cleanup failures are logged with the owned resource name while cleanup
  continues.
- A successful stop permits the same isolated instance to start again without
  manual port or process cleanup.

## Persisted Evidence

This lifecycle does not create new product records. The owned local runtime
descriptor is removed during cleanup; business records and shared PostgreSQL
state remain intact. Test evidence comes from focused lifecycle suites and the
real child-process restart smoke.

## Canonical Scenarios

1. Programmatic stop and restart:
   - Trigger: an embedding host calls `stop()` and starts the same isolated
     instance again.
   - Expected state/action: the first server instance releases its
     lifecycle-owned resources and the replacement instance reaches a healthy
     API state in the same test process using the same ports.
   - Visible output: both starts report healthy API responses and the stopped
     child exits naturally.
   - Evidence: `scripts/smoke/server-runtime-lifecycle.mjs`.
2. Startup rollback:
   - Trigger: startup throws after one or more process resources were acquired
     and registered with the lifecycle owner.
   - Expected state/action: acquired-and-registered resources close once and
     the caller receives the original startup error.
   - Visible output: the startup attempt fails with its original cause rather
     than a cleanup error.
   - Evidence: `server/src/__tests__/runtime-supervisor.test.ts`.
3. Pending authenticated WebSocket upgrade:
   - Trigger: shutdown begins while a Live Events upgrade is still awaiting
     authorization.
   - Expected state/action: the pending socket is destroyed and HTTP shutdown
     completes.
   - Visible output: the client closes and the server does not hang.
   - Evidence: `server/src/__tests__/live-events-ws.test.ts`.
4. Shared database exclusion:
   - Trigger: Rudder stops while connected to PostgreSQL it did not start.
   - Expected state/action: its client pool closes but the PostgreSQL service is
     not stopped.
   - Visible output: Rudder exits without disrupting the shared database.
   - Evidence: the ownership guard in `server/src/index.ts`; no dedicated
     black-box shared-database stop test exists yet.

## Invariants / Non-Goals

- Shutdown and startup rollback share one cleanup semantic.
- Cleanup is safe under repeated and concurrent calls and continues after an
  individual resource failure.
- HTTP stops accepting new work before dependent network and database resources
  are released.
- The HTTP drain is awaited without a forced-request cancellation or timeout.
  A non-terminating active HTTP request may therefore delay later cleanup and
  completion of `stop()`; time-bounded drain is not promised by this contract.
- Pending authenticated Live Events upgrades must not block shutdown.
- Rudder must not stop PostgreSQL unless the current process started the owned
  embedded instance.
- Startup failure must preserve the original error object.
- Plugin discovery and tool-dispatcher warm-up must not delay HTTP readiness;
  lifecycle close must wait for their tracked startup work before teardown.
- Plugin watcher close marks the watcher closed before async package-path
  resolution can finish, prevents post-close watches, and awaits every owned
  filesystem-watcher close handle.
- Plugin-host cleanup is failure-isolated within the host boundary: one watcher,
  loader, dispatcher, host-service, or log-flush failure must not skip later
  owned cleanup.
- An owned Vite middleware/HMR runtime and plugin-host process listeners must be
  closed during normal shutdown and application-start rollback so same-process
  restart can reuse the same ports and listener baseline.
- Chat background scheduling must have one owner per HTTP application. Close
  must reject new work before clearing timers, aborting owned queue execution,
  and awaiting already tracked work; repeated close calls share one promise.
- This contract does not promise cancellation or draining of already-started
  agent runs, non-Chat asynchronous recovery tasks, in-flight plugin tool calls
  or scheduled job executions, backups, or workspace operations beyond the
  resources explicitly owned by the server lifecycle.
- This contract does not change API, persistence, organization scoping, runtime
  provider, or UI business logic.

## Drift Boundaries

Update this contract when a change alters server startup, shutdown, restart,
resource ownership, cleanup ordering guarantees, WebSocket shutdown behavior,
database process ownership, signal handling, or the externally callable
`startServer()` / `stop()` lifecycle.

Internal class names, registration helpers, logging implementation, and the
exact resource stack may change without a contract update when the observable
guarantees and ownership boundaries above remain true.

## Traceability

Related plans:

- `doc/plans/2026-07-13-runtime-supervisor-resource-lifecycle.md`
- `doc/plans/2026-07-17-safe-change-throughput-architecture-optimization.md`

Related code:

- `server/src/index.ts`
- `server/src/app.ts`
- `server/src/bootstrap/create-http-app.ts`
- `server/src/bootstrap/plugin-host-runtime.ts`
- `server/src/routes/chat-background-runtime.ts`
- `server/src/services/plugin-dev-watcher.ts`
- `server/src/runtime/runtime-supervisor.ts`
- `server/src/realtime/live-events-ws.ts`

Related tests:

- `server/src/__tests__/app-lifecycle.test.ts`
- `server/src/__tests__/chat-background-runtime.test.ts`
- `server/src/__tests__/http-app-vite-lifecycle.test.ts`
- `server/src/__tests__/plugin-dev-watcher.test.ts`
- `server/src/__tests__/plugin-host-runtime-lifecycle.test.ts`
- `server/src/__tests__/runtime-supervisor.test.ts`
- `server/src/__tests__/live-events-ws.test.ts`
- `scripts/smoke/server-runtime-lifecycle.mjs`
- `scripts/smoke/server-runtime-lifecycle-child.ts`

Known gaps:

- Non-Chat fire-and-forget recovery, in-flight scheduler ticks or backup work,
  in-flight plugin tool calls or job executions, Feishu startup work, and
  workspace runtime cancellation remain outside this lifecycle owner.
- Active HTTP requests are drained without a timeout or forced cancellation, so
  a non-terminating request can delay later resource cleanup and restart.
- External/shared PostgreSQL exclusion is enforced by the server ownership
  guard but does not yet have a dedicated black-box shared-database stop test.
