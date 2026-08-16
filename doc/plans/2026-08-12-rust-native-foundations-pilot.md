---
title: Rust Native Foundations Pilot
date: 2026-08-12
kind: implementation
status: blocked
area: agent_runtimes
entities:
  - native_runtime
  - local_app_runtime
  - workspace_backup
  - run_evidence
issue:
related_plans:
  - 2026-06-24-agent-run-scene-runtime-contract.md
  - 2026-07-20-thread-pressure-performance-coverage.md
  - 2026-08-03-openclaw-hermes-runtime-compatibility-refresh.md
  - 2026-08-10-experimental-computer-use.md
supersedes: []
related_code:
  - desktop/src/local-apps-runtime.ts
  - desktop/src/local-app-watchdog-runner.mjs
  - server/src/services/workspace-backups.ts
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - server/src/services/run-log-store.ts
  - cli/src/runtime/install.ts
  - packages/run-intelligence-core/src/transcript.ts
  - server/src/services/organization-workspace-browser.ts
commit_refs:
  - 1a76ec93e
  - 44e875564
  - a4452140d
  - 99fc7ace0
  - 21271318c
  - 97a28e80b
  - 0691c3850
  - 0d30c8acb
  - 6c363bf82
  - 474ae030e
  - 2a470a382
  - b707c9254
  - 88e257044
  - 22fbeedbc
  - 72005f4b3
  - d7f891d17
  - 2161b2b6b
  - 86a2f7fa6
  - 86f5d9953
  - dd88ffaca
  - bfab54182
  - d30138587
  - 2b4a25c13
  - 59b2ef7b5
  - cf46981e2
  - 72020b2da
  - db7cf955b
updated_at: 2026-08-16
---

# Rust Native Foundations Pilot

### Continuation status (2026-08-16)

The exact `72005f4` macOS arm64 packaged candidate was rechecked from the
portable ZIP with SHA-256
`43336d17fba1692d75d644b3c479894ac08bf193d077fe4dbffc0f6177695ada`.
The packaged account-gate scenario reached the real board URL and passed.
The packaged Local App scenario then stopped at the expected
`401 account_session_required` boundary because no hosted authenticated
fixture is available; the dev Local App scenario completed its lifecycle and
cleanup. These results do not count as hosted dogfood.

`rudder-evals` now exposes `run native-ab` (and the `native_ab` alias). It
strictly invokes the existing three-trial OSS producer and writes a complete
fail-closed `not_runnable` Packet V2 when producer, binary, identity, or
import prerequisites are absent. The normal and flood workloads both produced
six comparable formal observations and imported as `native_ab_pass`; the
protocol still sets `productPass: false`, so this is comparative evidence and
not a product promotion by itself. The normal workload p95 was Node -> Rust:
ready `235.7 -> 228.1 ms`, Stop admission `22.6 -> 50.9 ms`, terminal cleanup
`126.2 -> 170.6 ms`, and peak tree RSS `208.4 -> 164.6 MiB`. The flood
workload was ready `238.2 -> 225.6 ms`, Stop admission `12.7 -> 12.0 ms`,
terminal cleanup `75.5 -> 78.6 ms`, and peak tree RSS `224.8 -> 175.2 MiB`.
The normal lifecycle-tail regressions and the missing seven-day dogfood gate
keep Local App at `opt-in` rather than `accepted_default`.

## Executive Decision

### Continuation status (2026-08-15)

The current metadata wrapper is `db7cf955b06a6a86f64352cc93cf5366b298e27b`.
Its native/runtime paths are unchanged from the clean packaged source
`72005f4b37df05fbd987fb4c1051c8f21652ad23`; the wrapper contains only
metadata and unrelated descendant changes. The exact macOS arm64 packaged
candidate was rebuilt from that clean source. `desktop:dist`, server-package
verification, native staging/version checks, standalone server-package
verification, packaged Computer Use/account-gate/App Builder smoke, and
`unzip -t` passed. The portable ZIP SHA-256 is
`5544b24edd5fe15ec6e7ddda03da3faac023919a478002fe0bc802e40cef5866`; the
shell ZIP SHA-256 is
`f8b80973abd9f2dcf3c8b659990c0ef628f1c073dd091d54198d45f43b8b942f`; the
packaged app executable SHA-256 is
`b901c246042d1eb71ab0d098ca0331726b41eec8339ccc3ba8a0a46f9040577b`.
The staged product binaries report `0.7.7`; their hashes and the benchmark
sampler hash are recorded in the delivery packet.

The current backup comparator receipt is
`/private/tmp/rudder-native-backup-dd8-100sample-ext25.json` with receipt
SHA-256 `0dbecaa2f17b6c0e886f130fec0233b6df703f5938430944e57aa020aca50c29`.
It uses a deterministic 100 MiB/10,000-file fixture, 100 paired samples per
arm, 200/200 positive external sampler boundaries at 25 ms, and passes
manifest, entry, content, and recovery parity. It remains explicitly
`not_comparable`: arm order is fixed, warmups are absent, and no bootstrap
confidence interval is recorded. Node p95 elapsed/RSS are 15330.897 ms /
382025728 bytes; native p95 elapsed/RSS are 8323.525 ms / 389611520 bytes.
These are descriptive observations, not a promotion claim.

The candidate remains blocked for Local App promotion: no authorized hosted
authenticated fixture exists, so the real seven-day/100-cycle dogfood gate
cannot run. The foundation remains `accepted_default` only for the proven
macOS arm64 packaged capability tuple; Local App and streaming backup remain
`opt-in`, and the four dependent slices remain `not_admitted`. These are
evidence-scoped decisions, not a claim that the pilot is complete.

Release-version alignment is a hard gate. The normal Rudder product version
is the single version for every first-party Rust package, Cargo.lock entry,
staged binary, Desktop/server manifest, and release tag; Rust packages must
not use an independent `0.x` line. The `v0.7.7` release tag now resolves to
`acfb8e4c7dbc963fdb32280b8055ee0604d021b6` on `origin/main`, and its
native/runtime paths are unchanged from the `72005f4` artifact source. The
recorded packaged artifact was not rebuilt from that tag, so release preflight
and packaged acceptance remain separately scoped; release preflight validates
source metadata and Cargo.lock;
packaged verification additionally validates staged binary `--version`
outputs. A candidate is not release-ready until both scopes pass and the
release tag resolves to the same version.

Introduce a Rust native foundation through six approved, dependency-ordered
slices:

1. Local App process host;
2. streaming Workspace backup;
3. Agent Run process/I/O host;
4. runtime payload installer/extractor;
5. Run evidence offset indexer/parser; and
6. Workspace manifest/index watcher.

The pilot does not authorize a general backend rewrite. It creates two stable
native boundaries, proves them on real Rudder workflows, and uses measured
Node-versus-Rust evidence to decide whether each boundary should become the
default.

Implementation is sequential by dependency, not six parallel workstreams:

```text
Foundation
  +-- Local App process host
  |     +-- Agent Run process/I/O host
  |
  +-- Streaming Workspace backup
        +-- Runtime payload installer/extractor
        +-- Run evidence offset indexer/parser
        +-- Workspace manifest/index watcher

Each slice
  -> deterministic correctness and pressure benchmark
  -> explicit Rust opt-in
  -> exact packaged candidate acceptance
  -> rudder-evals native_ab comparison
  -> promotion or rollback decision
```

## User And Operator Outcome

The operator should observe the same Rudder product behavior while the native
candidate makes lower-level execution more bounded and recoverable:

- Local Apps start only after their listener is owned by the expected process
  tree and stop without leaving a descendant behind.
- Workspace backups no longer require all file content, base64, JSON, and ZIP
  output to coexist in JavaScript memory.
- Agent Runs remain stoppable under sustained output and preserve byte-exact
  evidence even when log persistence is slower than the child process.
- PostgreSQL runtime installation does not materialize the complete archive in
  the CLI process and cannot publish a partial generation.
- Run evidence can be paged and diagnosed without first constructing every
  representation of a large log.
- Workspace mention search can avoid repeated recursive cold scans once an
  admitted index/freshness contract is available, while ambiguous freshness
  still falls back to the live path.

No new user-facing workflow is introduced. Existing UI, API, organization
scope, activity, and terminal-state semantics remain authoritative.

## Current Evidence And Why These Boundaries

### Local App process lifecycle

The current Local App path uses a Node watchdog, platform-specific process
inspection, IPC messages, listener ownership retries, persisted descriptors,
and parent-side cleanup. The boundary is already process-shaped, but process
identity and cleanup semantics are distributed across
`desktop/src/local-apps-runtime.ts`, the watchdog runner, and platform helpers.

Rust is suitable because the stable job is operating-system lifecycle work:
spawn without a shell, identify an owned process tree, verify a loopback
listener, react to parent/control-channel loss, and prove terminal cleanup.
Rust does not own Local App registry, BrowserView partitioning, open paths, UI,
or product readiness.

### Workspace backup materialization

Workspace backup v1 currently:

- reads every included file into a Buffer;
- stores file content as base64 inside an in-memory artifact object;
- serializes the complete artifact as JSON;
- reads and parses the complete artifact for browse/restore; and
- builds a complete in-memory ZIP Buffer for download.

The current limits are 5 MiB per file and 100 MiB total file content. Base64
alone can expand 100 MiB to about 133 MiB before the original Buffers, object
graph, serialized JSON, parsed artifact, and generated ZIP are counted. This is
a structural memory risk, not a measured Rust speedup claim.

Rust is suitable because archive creation, hashing, safe extraction, and
staged restore have stable byte-oriented contracts. TypeScript remains the
owner of schedule, retention, database state, active-Run gates, and activity.

### Agent Run I/O

The current process adapter chains asynchronous log persistence in one growing
Promise sequence. The local log store calls `appendFile` for each chunk. A
directional local microbenchmark on 2026-08-12 wrote 10,000 approximately 4 KiB
chunks (40.63 MB): sequential `appendFile` took 5.41 seconds while one Node
`WriteStream` took 0.178 seconds. This proves the current write shape has a
large avoidable cost; it does not prove Rust is required or that production
Runs become 30 times faster.

The Rust slice is admitted only as a coarse process-plus-I/O boundary. A
standalone Rust log writer would add IPC without owning backpressure, Stop, or
process-tree correctness and is therefore out of scope.

### Runtime payload installation

The PostgreSQL runtime installer currently uses `response.arrayBuffer()` before
writing the archive. On 2026-08-12 the referenced PostgreSQL archives reported
347.8 MiB for macOS and 321.8 MiB for Windows. A fixed-buffer stream can remove
most archive-attributable peak allocation, although network and extraction may
still dominate end-to-end time.

This slice is included because it can reuse the backup archive/path/atomic
publish foundation. It is not justified by download speed alone.

### Run evidence

The run detail path can retain `logContent`, parsed `logChunks`, and a derived
`transcript` at the same time. Existing log byte paging and transcript paging
are important prerequisites, but filesystem loading and some full-detail paths
still materialize complete content.

Rust is suitable for stable framing, UTF-8 boundaries, offsets, hashes, and a
rebuildable sidecar index. Provider-specific Codex, OpenCode, Claude, Pi, or
other transcript meaning remains in TypeScript.

### Workspace path search

`listMentionableFiles` recursively traverses directories until it fills a
bounded result set. A query with few matches may still visit most of a large
workspace, after which TypeScript maps paths to Library entries.

Rust is suitable for a shared filesystem walker, event coalescing, and a
rebuildable path manifest. It is not admitted as a search rewrite until a
100,000-file fixture proves traversal is a material part of endpoint latency.

### Strongest safe Node comparator

Every Rust promotion comparison uses the strongest safe Node implementation
that preserves the same contract, not the known inefficient code path. The
pilot must first implement or fixture these comparators:

| Slice | Required Node comparator before Rust benefit is judged |
| --- | --- |
| Local App process host | current watchdog with the same listener-owner, PID-birth, process-tree, timeout, and cleanup assertions |
| Streaming Workspace backup | streaming Node ZIP create/download/restore with bounded buffers and the same safe path plus recoverable-swap rules |
| Agent Run process/I/O host | one `WriteStream`/bounded queue and explicit backpressure instead of sequential `appendFile` per chunk |
| Runtime payload installer | `fetch` body streamed to a partial file plus a streaming extractor, checksum, validation, and staged publish |
| Run evidence indexer/parser | bounded byte/event/transcript paging after `projection=full` is removed from product and eval workloads |
| Workspace manifest/index watcher | cached TypeScript manifest/watcher prototype plus removal of avoidable DB mapping/N+1 work |

The 5.41 second sequential-append versus 0.178 second `WriteStream`
microbenchmark admits log I/O optimization; it does not admit Rust by itself.
Likewise, comparing Rust streaming against Node full-buffer download or base64
backup would overstate language-specific value. If the optimized Node path
meets the correctness, reliability, RSS, and latency gates with lower lifecycle
cost, the Rust slice stays opt-in or becomes `not_admitted`.

## Goals

- Establish a reproducible Rust 2024 workspace, protocol, packaging path, and
  dependency policy inside `rudder-oss`.
- Keep every product decision and organization boundary in the existing
  TypeScript services during this pilot.
- Make native operations coarse-grained, versioned, bounded, cancellable, and
  independently observable.
- Preserve a Node baseline until the exact Rust candidate passes correctness,
  packaged acceptance, performance, and eval gates.
- Produce immutable baseline/candidate evidence in `rudder-evals`, not only
  local benchmark prose.
- Remove a Node implementation only after at least one stable release interval
  with a proven rollback path.

## Non-Goals

- Rewriting Express routes, Drizzle services, PostgreSQL schema, auth,
  organization scope, schedulers, or product state machines in Rust.
- Rewriting Goal, Chat, Issue, Review, Approval, Budget, Automation, Plugin, or
  UI behavior.
- Moving provider-specific transcript semantics into Rust.
- Replacing PostgreSQL or reimplementing PostgreSQL dump/restore semantics.
- Adding Apple Developer ID signing/notarization, Windows signing, or Linux
  AppImage packaging in this pilot.
- Requiring Cargo, a compiler, or build tools on an end-user machine.
- Claiming Windows/Linux runtime acceptance from cross-compilation or fixtures.
- Treating a faster microbenchmark as a Rudder product eval pass.

## Product Contract Boundary

This plan is intended to preserve current product behavior. It does not
authorize edits to `doc/product/**`.

Before implementing each slice, the implementer must list the affected current
contract IDs and classify the work as either contract-preserving or a proposed
product-logic delta. Likely affected domains include Execution, Agents,
Library and Context, and Identity and Access. If implementation requires a
semantic change to user-visible startup, Run terminal state, backup/restore,
or evidence behavior, stop and propose the concrete Product Logic Registry
delta for explicit user approval.

The current acceptance packet must explicitly cover these contracts:

| Contract | Relevant slice and preserved boundary |
| --- | --- |
| `DESKTOP.LOCAL.APPS.001` | Local App direct Start, one runtime generation, listener ownership, explicit Stop, and Desktop-shutdown cleanup |
| `APP.BUILDER.001` | guarded verified-source handoff and exact managed Local App launch |
| `WORKSPACE.BACKUP.001` | organization scope, canonical tree identity, browse/download/restore, safety backup, and active-Run gates |
| `RUN.CHAT.AGENT.001` | exact generation/attempt/control fencing, Stop cutoff, recovery, and terminal reconciliation |
| `RUN.EXECUTION.001` | adapter ownership, process-loss behavior, result persistence, and no direct Rust DB mutation |
| `RUN.RESULT.001` | raw evidence, bounded live output, visible cutoff, transcript/result projection, digest, and terminal evidence |
| `RUN.ADMISSION.001` | issue execution ownership is not released or duplicated by native process recovery |
| `SERVER.LIFECYCLE.001` | normal Server shutdown does not newly promise cancellation or draining of already-started Agent Runs |
| `LIBRARY.FILES.001` | protected paths, organization root binding, stable references, and mentionable-file eligibility |

`DESKTOP.LOCAL.APPS.001` already authorizes Local App cleanup during Desktop
shutdown. `SERVER.LIFECYCLE.001` does not authorize treating normal Server
shutdown or Agent Run command-pipe EOF as user Stop/cancellation. A watcher
that can return a stale mention result, a reattach-and-continue Agent Run, or a
normal-shutdown Run cancellation is not declared contract-preserving by this
plan; it requires a concrete Product Logic delta and explicit approval first.

## Architecture

### Repository layout

Create one Cargo workspace with product binaries, one benchmark-only sampler,
and narrowly shared crates:

```text
native/
  Cargo.toml
  Cargo.lock
  rust-toolchain.toml
  deny.toml
  crates/
    native-protocol/
    path-policy/
    process-core/
    archive-core/
    run-evidence-core/
    workspace-index-core/
  bins/
    rudder-process-host/
    rudder-native/
    rudder-process-tree-sampler/ # benchmark-only; never a product runtime
    rudder-update-helper/        # packaged Desktop update helper
```

`rudder-process-host` is long-lived only relative to one accepted child
lifecycle. Start exactly one host for one Local App runtime generation or one
Agent Run attempt, and exit it after that owned lifecycle becomes terminal. Do
not reuse a host across definitions, Runs, attempts, organizations, or the
Desktop and Server boundaries. `rudder-native` executes one bounded data
operation per invocation. Do not introduce a general native daemon or a TCP
listener.

Shared crates are admitted only when two approved slices already need the same
behavior. Slice-specific logic stays with its binary until reuse is real.

### Protocol transport

Control frames and child bytes must use separate channels. A managed
`rudder-process-host` invocation uses these logical channels, mapped to
inherited anonymous pipes/handles on each platform:

| Logical channel | Unix mapping | Direction | Content |
| --- | --- | --- | --- |
| command | fd 0 | TypeScript -> host | byte-limited JSONL commands |
| lifecycle | fd 3 | host -> TypeScript | byte-limited JSONL handshake, progress, control acknowledgement, and exactly one terminal frame |
| child stdout | fd 4 | host -> TypeScript | raw child stdout bytes only |
| child stderr | fd 5 | host -> TypeScript | raw child stderr bytes only |
| child stdin payload | fd 6 when needed | TypeScript -> host | raw bounded payload, then EOF |

Windows uses equivalent inherited anonymous pipe handles; protocol schemas
name logical channels rather than assuming numeric file descriptors. Managed
mode leaves the host's fd 1 empty. Host fd 2 is diagnostic-only, bounded, and
redacted; child output never enters it. One-shot `rudder-native` operations use
fd 0/fd 3 for command/result and additional data pipes or validated paths for
large content.

The host records a monotonic acquisition sequence, stream, byte offset, length,
and digest in its owned spool/index so stdout/stderr interleave can be replayed
without putting raw bytes inside lifecycle JSON. The fd 4/fd 5 streams remain
byte-exact per stream; the spool metadata is authoritative for cross-stream
arrival order. Large content never becomes base64 inside the protocol.

Every binary supports:

```text
--version
--protocol-version
--capabilities
```

Every protocol message has:

```ts
type NativeProtocolVersion = {
  major: 1;
  minor: number;
};

type NativeEnvelope<T> = {
  protocolVersion: NativeProtocolVersion;
  requestId: string;
  operation: string;
  payload: T;
};

type NativeTerminal = {
  protocolVersion: NativeProtocolVersion;
  requestId: string;
  status: "succeeded" | "failed" | "cancelled";
  errorCode?: string;
  message?: string;
  metrics: {
    elapsedMs: number;
    bytesRead: number;
    bytesWritten: number;
    peakBufferedBytes: number;
  };
};
```

Phase 0 freezes `major=1`, the initial minor, feature negotiation, frame/error
codes, and compatibility rules. A different major is rejected. Same-major
minor compatibility is allowed only when both sides explicitly negotiate the
required capability set; a sender cannot rely on an unknown field changing
semantics. The exact schemas must live beside the Rust protocol types and have
bidirectional TypeScript/Rust fixture tests. Missing/unknown required
capabilities, unsupported protocol versions, oversized frames, duplicate
request IDs, and messages after a terminal response fail closed. Closing a
command pipe is a typed `control_eof` input to the lifecycle state machine; it
is not universally equivalent to Stop or cancellation.

### Process host identity and persistence

Each accepted host writes an owner descriptor under the already authorized
instance/runtime root. The descriptor contains no secret and is useful only
when combined with filesystem ownership and product-layer authority:

```ts
type NativeProcessOwnerDescriptor = {
  protocolVersion: NativeProtocolVersion;
  operationId: string;
  ownerKind: "local_app_generation" | "agent_run_attempt";
  opaqueOwnerToken: string;
  hostPid: number;
  hostStartedAt: string;
  childPid: number;
  childStartedAt: string;
  platformOwnerIdentity: string;
  spoolPath: string;
  terminalReceiptPath: string;
};
```

The descriptor is published atomically only after the host and child identity
are known. Inspection or termination after caller loss must revalidate PID
birth/start identity and process group/job ownership through a bounded recovery
mode of `rudder-process-host`; PID existence alone is never authority. Terminal
receipts and byte counts/hashes are written atomically and are idempotently
reconcilable by TypeScript after restart.

### Authority boundary

TypeScript remains the authority for:

- organization, user, Agent, and Run identity;
- product generation/attempt identity, current control version, and opaque
  owner-token minting/validation;
- feature eligibility and activation mode;
- database claims and status transitions;
- active-Run gates and product-visible error mapping;
- executable allowlisting and inherited-environment policy;
- retention, schedule, and activity logging.

Rust independently validates:

- path containment and canonicalization;
- symlink and unsupported-file policy;
- OS process birth identity, process group/job membership, and exact equality
  of the opaque owner token that TypeScript authorized;
- archive entry names, sizes, counts, compression ratios, and checksums;
- protocol limits and terminal-state uniqueness.

No model-controlled tool parameter may directly select a native executable,
PID, process group, arbitrary absolute path, output directory, or protocol
capability.

Rust never interprets the opaque owner token as proof of an organization, Run,
or product generation and cannot determine from it whether a database control
version is current. It only binds and echoes the token with independently
proven OS ownership; TypeScript performs every product-generation fence.

### Error and exit contract

Reserve stable process exit codes:

- `0`: terminal success already emitted;
- `1`: bounded operation failure already emitted;
- `2`: protocol/capability mismatch;
- `3`: invalid or unsafe input;
- `4`: integrity failure;
- `130`: explicit cancellation or contract-authorized parent termination.

The TypeScript caller maps machine error codes to existing public errors. Raw
paths, environment values, secrets, command output, and archive content are
not copied into public messages. Agent Run `control_eof` is not assigned exit
code `130` merely because the Server pipe closed.

## Packaging And Activation

### Build matrix

CI builds release binaries for:

- `aarch64-apple-darwin`;
- `x86_64-apple-darwin`;
- `x86_64-pc-windows-msvc`; and
- `x86_64-unknown-linux-gnu`.

macOS arm64 is the only initial real packaged acceptance platform. The other
targets require successful compilation, unit tests that are platform
independent, protocol fixtures, archive fixtures, and process-platform tests.
They remain `compiled_unverified` until real acceptance exists.

### Desktop staging

Stage binaries before Electron packaging and copy them into a stable resources
layout, following the existing PostgreSQL resource pattern:

```text
Rudder.app/Contents/Resources/native/<target>/rudder-process-host
Rudder.app/Contents/Resources/native/<target>/rudder-native
```

The packaged verifier must:

- resolve the binary from the isolated packaged App, not the worktree;
- verify executable mode, target architecture, version, capability list, and
  SHA-256;
- run a no-network protocol fixture from a copied temporary App;
- prove ZIP/archive publication preserves executable mode where relevant.

### Release version alignment

Every Rudder-owned Rust crate and binary inherits one version from
`native/Cargo.toml` through `[workspace.package]`. That workspace version
must equal the normal Rudder release version used by the public packages and
Desktop artifact; Rust packages do not maintain an independent `0.x` line.
Each first-party `native/**/Cargo.toml` must therefore use
`version.workspace = true`; a literal crate or binary version is a release
workflow error. The first-party package entries in `native/Cargo.lock`, the
staged binary `--version` output, the Desktop/server package manifests, and
the release tag must resolve to that same product version (including an
intentional canary suffix when the release is a canary).

Both normal next-version preparation and canary/stable release packaging update
the Cargo workspace through the same release package-map command that updates
the JavaScript packages. `set-version` and `set-publish-version` are the only
supported version-preparation paths; they must update the Cargo workspace and
regenerate `native/Cargo.lock` alongside the JavaScript package manifests.
Release and packaged verification fail closed when the Cargo workspace or
lockfile version is absent or differs from the Desktop/server version.
Acceptance packets record the synchronized product version and every checked
version source in addition to binary hashes and protocol versions; protocol
compatibility remains independent from the product release version.

The current portable macOS `rudder start` path attempts to recursively remove
quarantine from `Rudder.app`, but it only warns if that command fails. Therefore
the initial claim is limited to the exact unsigned portable-alpha artifact
installed through `rudder start` on the accepted macOS arm64 fixture, with
observed successful quarantine removal and actual helper execution from the
installed App. This does not claim stable/manual-copy/arbitrary-install-path or
notarized distribution. End users do not need Cargo or an Apple developer
account for that tested path. Formal signing/notarization remains a later
release concern.

### Activation state

Activation state is keyed by capability, target triple, binary SHA-256, and
protocol major/minor, not only by capability name. Each exact tuple has an
independent state:

```text
disabled
compiled_unverified
explicit_opt_in
accepted_default
legacy_removed
```

Environment/instance flags may select the candidate during development, but
the effective capability, target, binary hash, protocol version, state, and
fallback decision must appear in health/diagnostic evidence. macOS arm64
acceptance cannot promote macOS x64, Windows x64, or Linux x64 beyond
`compiled_unverified`. A missing or incompatible binary may fall back to Node
only before Rust accepts the operation.

After a process start is accepted, do not start a Node duplicate. After a data
operation creates staging output, complete, clean that exact staging root, or
return failure; do not run both implementations against the same target.

## Delivery Plan

### Slice 0: Native foundation

#### Build

- Add the Cargo workspace, pinned toolchain, formatting, Clippy, tests,
  dependency/license checks, and release profiles.
- Add protocol schemas and cross-language golden fixtures.
- Add a cross-platform inherited-pipe adapter whose public API uses logical
  channel names and whose tests verify fd/handle closure independently.
- Add target-aware binary resolution and capability handshake in TypeScript.
- Add Desktop staging and packaged verification.
- Make all Rust workspace packages inherit and verify the normal Rudder release
  version through the existing release version workflow.
- Add per-capability activation and diagnostics without changing user-visible
  behavior.
- Record binary name, version, target, SHA-256, protocol, capability, and
  activation source in the acceptance packet.

#### Reasoning

Do not implement six ad hoc binaries or six independent JSON contracts. The
first slice earns one reproducible supply chain and one narrow protocol before
it owns a product operation.

#### Gate

- All four targets compile in CI.
- Protocol fixtures pass in both languages. Target-native CI runs the inherited
  pipe/handle fixture on macOS x64, Windows x64, and Linux x64; macOS arm64 runs
  it both directly and from the packaged App. A platform without a runnable
  target-native fixture remains `compiled_unverified` even if cross-compilation
  succeeds.
- The macOS arm64 binary runs from an isolated packaged App copy. A packaged
  inherited-pipe fixture sends JSONL commands on the command channel, observes
  lifecycle and terminal frames only on the lifecycle channel, and receives
  byte-exact fixtures containing newlines, NUL, invalid UTF-8, and JSON-looking
  text independently on child stdout and stderr channels.
- The fixture proves command EOF, lifecycle EOF, child stdout EOF, and child
  stderr EOF cannot be mistaken for each other, and that a log flood cannot
  block Stop acknowledgement on the lifecycle channel.
- The packaged acceptance records that `rudder start` quarantine removal
  succeeded and then executes the hashed helper from the installed App path.
- Missing, wrong-architecture, wrong-version, oversized-frame, and corrupt
  binary cases fail before side effects.
- Normal, canary, and stable version preparation keep Cargo metadata aligned
  with the matching Rudder Desktop/public package version.

### Slice 1: Local App process host

#### Ownership

Rust owns:

- one host process for exactly one accepted Local App runtime generation;
- shell-free spawn of the approved executable and argv;
- sanitized environment received from TypeScript;
- opaque owner token plus PID birth/process group/job identity;
- bounded stdout/stderr relay;
- loopback listener ownership verification;
- Stop escalation and proof that the owned tree is dead;
- parent/control-pipe loss cleanup; and
- one terminal lifecycle event.

TypeScript retains Local App definition validation, registry persistence,
origin/open path, Browser partition, UI view, and state transition mapping.

#### Lifecycle protocol

```text
handshake
  -> start request
  -> accepted(opaque owner token)
  -> spawned(pid + platform owner identity)
  -> listener_verified(port + opaque owner token + OS identity)
  -> running
  -> stop | child_exit | parent_eof
  -> terminating
  -> stopped(proven dead) | cleanup_failed
```

The host must never report `running` from a successful TCP connect alone. The
listener must belong to the expected process tree. An unverifiable persisted
owner remains `orphaned_unverified`; it is not killed by PID guesswork.
TypeScript alone maps the echoed opaque token to the current Local App product
generation and decides whether that generation may transition to `running`.

#### Failure semantics

- Start timeout: terminate the accepted owner and return a terminal failure.
- Child exits before listener verification: preserve bounded stderr and the
  real exit status.
- Listener owned by another process: terminate only the accepted owner and
  report `listener_owner_mismatch`.
- Parent EOF/Desktop exit: stop admission immediately, then terminate the
  accepted owner within the hard cleanup deadline.
- Stop timeout: escalate according to platform policy and report failure if
  death still cannot be proven.

#### Acceptance

- Real packaged macOS arm64 App Builder Local App starts, is visibly usable,
  and stops with no surviving descendant or listener.
- Cold install and warm restart both pass.
- Parent crash, child crash, port collision, wrong listener owner, repeated
  Stop, concurrent start, stale persisted descriptor, and log flood pass.
- Node and Rust public runtime views are semantically equivalent for the same
  fixture sequence.
- During a 10 MB/s log flood, Stop admission is observed within 250 ms and the
  owned tree is terminal within the existing bounded cleanup policy.

### Slice 2: Streaming Workspace backup

#### Artifact v2

Write new backups as a canonical ZIP artifact instead of JSON with base64 file
data. Reserve an internal manifest entry:

```text
.rudder-backup/manifest-v2.json
workspace-root/<files...>
```

The manifest contains version, org/instance identity, creation time, canonical
relative paths, kind, byte size, mtime, mode, per-file SHA-256, tree SHA-256,
warnings, and policy version. It does not contain file bytes.

ZIP is selected because the existing public download is ZIP and the central
directory supports bounded list/read operations. The implementation may use
ZIP64 only when required by explicit future limits; the current 5 MiB per-file
and 100 MiB total limits remain unchanged in this pilot.

#### Create path

```text
TypeScript claims DB row
  -> Rust walks validated organization root
  -> stream file -> SHA-256 + CRC + archive entry
  -> write manifest
  -> fsync file and containing directory where supported
  -> verify archive/index/tree hash
  -> atomic rename temp artifact to final artifact
  -> TypeScript records succeeded metadata
```

The walker preserves current skip names, temporary-file policy, symlink
rejection, file/total byte limits, warning cap, content-based tree identity,
and organization-root containment.

#### Browse, download, and restore

- List reads the central directory and manifest without inflating file data.
- Text preview streams at most the existing 200 KB preview budget.
- Download streams the canonical artifact; it does not rebuild another ZIP in
  memory.
- Restore verifies the archive and each selected entry while writing to a
  private same-filesystem staging root, then performs the existing active-Run
  recheck and the recoverable directory-swap protocol below.
- Sparse recovery restores only missing files and never overwrites a conflicting
  current file.

TypeScript continues to own pre-restore backup, active-Run checks, DB status,
retention, scheduling, and activity records.

#### Cross-platform restore commit

Directory replacement is recoverable but is not described as one atomic rename
because both POSIX and Windows require more than one namespace operation when a
workspace already exists. Under the organization restore lock:

1. Create and fully verify `staging` beside the workspace on the same volume.
2. Write and fsync a restore receipt containing operation ID, phase, expected
   live/staging tree hashes, and exact `workspace`, `rollback`, and `staging`
   roots. Recheck active Runs immediately before the first rename.
3. Rename `workspace -> rollback`; never delete the live workspace first.
4. Rename `staging -> workspace`, then fsync the parent directory where the OS
   supports it.
5. Verify the published workspace tree, mark the receipt `committed`, reconcile
   TypeScript product state, and only then remove `rollback`.

On Windows, both renames use same-volume directory moves with bounded retries
for transient sharing violations. If a handle prevents the first rename, no
namespace change occurs and restore fails. If the second rename fails, restore
immediately renames `rollback -> workspace`; a failed rollback leaves the
receipt and both exact roots for startup recovery and reports a blocking
`restore_recovery_required` state. POSIX follows the same receipt/state machine
even when individual renames are atomic.

Startup recovery reads only validated owned receipts. It completes or rolls
back from the recorded phase and tree hashes; it never chooses by newest mtime,
deletes an unrecognized directory, or exposes an empty replacement workspace.
Cancellation is accepted before step 3. After step 3 the operation must finish
commit or rollback before returning. Peak-disk measurement includes
`workspace + staging + rollback`; the safety tradeoff is explicit.

#### Compatibility

- Existing v1 JSON artifacts remain readable, downloadable, restorable, and
  prunable.
- New writes become v2 only under explicit opt-in until acceptance.
- No eager rewrite of historical v1 artifacts.
- A future migration may transcode v1 to v2 only as a separately resumable,
  integrity-checked operation.

#### Acceptance

- Fixtures at 0 B, 10 MiB, 100 MiB, 10,000 small files, Unicode paths, mode
  variations, excluded paths, oversized files, symlinks, and active mutation.
- Malformed central directory, duplicate path, absolute path, `..`, case
  collision, symlink entry, checksum mismatch, truncated archive, oversized
  expansion, and cancellation fail closed.
- Inject process death before/after each receipt and rename step on APFS and the
  available Windows CI filesystem fixture; recovery yields either the exact old
  tree or exact restored tree, never an empty/mixed tree. Sharing violations,
  parent fsync unavailability, and rollback failure remain explicit.
- v1 and v2 produce the same eligible path set, file bytes, tree hash, browse
  results, sparse recovery result, and restored workspace hash.
- Report the legacy v1 full-materialization footprint as risk evidence, but use
  the streaming Node ZIP/restore comparator for language attribution. For a
  100 MiB included workspace, Rust promotion requires at least 30% lower
  combined process-tree RSS, at least 20% create/restore p95 improvement, or
  closure of a reproduced integrity/recovery defect versus that optimized Node
  path; undeclared total latency may not regress more than 10%.

### Slice 3: Runtime payload installer/extractor

#### Design

Add a `payload-install` operation to `rudder-native`:

```text
validated URL or local archive
  -> private partial file
  -> streaming SHA-256
  -> expected length/checksum verification
  -> safe extraction into generation staging
  -> expected binary/version probes
  -> fsync + atomic generation publish
```

Release metadata must pin expected archive SHA-256 per platform/version. A
versioned URL without a pinned digest is insufficient for automatic publish.
Redirect count, HTTPS policy, timeout, byte ceiling, and final host policy are
explicit.

TypeScript retains the installation lock, live-runtime protection, selected
PostgreSQL version, generation reconciliation, and user-facing progress. Rust
emits bounded phase progress without archive paths or response bodies.

#### Acceptance

- macOS 347.8 MiB and Windows 321.8 MiB production-shaped archive fixtures,
  plus small deterministic archives in CI.
- Cold download, warm cache, interrupted download, corrupt checksum, archive
  traversal, duplicate/case-colliding paths, disk full, extraction failure,
  invalid binary version, publish interruption, and live-generation protection.
- No partial generation becomes selectable after any injected failure.
- The current full-buffer path's expected 280-350 MiB avoidable allocation is
  structural risk evidence, not the language comparator. Rust promotion
  requires at least 30% lower combined process-tree RSS, at least 20% install
  p95 improvement, or closure of a reproduced publish/recovery defect versus
  the optimized Node streaming download/extractor on the exact candidate.
- End-to-end cold install may be promoted with 0-15% latency improvement if
  memory/reliability gates pass; network-bound speed is not a required claim.

### Slice 4: Agent Run process/I/O host

#### Admission condition

Begin only after the Local App host has passed packaged acceptance and a stable
dogfood gate: at least seven consecutive days and 100 accepted packaged
start/Stop or parent-loss cycles, with zero unresolved ownership, duplicate
listener, descendant-leak, or cleanup P1. Reuse `process-core`; do not fork a
second process supervision implementation.

Before implementation, freeze a contract-parity packet for
`RUN.CHAT.AGENT.001`, `RUN.EXECUTION.001`, `RUN.RESULT.001`,
`RUN.ADMISSION.001`, and `SERVER.LIFECYCLE.001`. In particular, normal Server
`stop()` does not acquire new authority to cancel already-started Agent Runs.
Reattaching and continuing one attempt after Server restart is deferred because
it would change current recovery behavior; propose that Product Logic delta
separately if later evidence justifies it.

#### Rust ownership

- create one host for exactly one authorized Agent Run attempt and never reuse
  it for a retry or another Run;
- spawn the adapter command without a shell;
- record process identity/start epoch before reporting accepted execution;
- preserve raw stdout/stderr bytes and arrival ordering metadata;
- write a byte-exact framed spool through a bounded memory queue;
- expose explicit high-water, spill, dropped-byte, and consumer-lag metrics;
- honor timeout and exact-attempt termination commands after TypeScript has
  completed the corresponding product fence;
- treat Server/control EOF as control loss, not as user Stop or cancellation;
- finalize byte count and SHA-256 exactly once.

TypeScript retains adapter selection, managed home, credentials, stdin
construction, provider semantic parsing, session continuity, usage/cost,
heartbeat Run state, transcript events, terminal effects, and issue/chat
follow-up.

#### Control loss and recovery

The Local App parent-EOF rule does not apply to Agent Runs. The Agent Run host
state machine is:

```text
authorized_attempt(opaque owner token)
  -> child_started(OS identity persisted)
  -> running
  -> child_terminal | exact_stop_command | timeout | control_eof

control_eof
  -> detached_capture(raw bytes continue to bounded spool)
  -> child_terminal_receipt | recovery_owner_termination
```

`control_eof` immediately closes the live TypeScript projection channel but
does not synthesize `Stop`, `cancelled`, a final assistant result, or a new Run
owner. The host may outlive normal Server shutdown long enough for the existing
lease/process-loss recovery owner to decide the outcome. It preserves raw bytes,
arrival sequence, child exit, and digest in the protected receipt.

The detached state is finite even when the Server never returns. Before child
spawn, TypeScript persists and passes these exact resource authorities:

- `attemptDeadline`: the earlier of the configured runtime deadline and the
  current five-minute execution-lease expiry; while control is healthy,
  TypeScript renews the lease deadline every 60 seconds, matching the existing
  execution lease. `control_eof` prevents further renewal, so an otherwise
  unbounded runtime has at most the remaining lease window while detached.
- `maxDetachedSpoolBytes`: a per-attempt total spool ceiling, initially 2 GiB,
  including a reserved 32 MiB termination tail. The exact configured value and
  available-disk preflight are recorded in the attempt descriptor and cannot be
  raised after `control_eof`.

At `attemptDeadline`, or when detached spool reaches
`maxDetachedSpoolBytes - 32 MiB`, the host stops accepting new work, sends the
contract-authorized TERM signal only to the verified child tree, escalates
within the existing force-kill grace, and writes a terminal
`control_lost_deadline` or `control_lost_spool_limit` receipt. The receipt
contains the opaque owner token, OS identity proof, termination outcome, last
persisted sequence, byte counts/hash, spool completeness, and any explicit
unpersisted-tail marker. Crossing the hard spool ceiling makes evidence
`partial` and the attempt ineligible for success; it is never reported as zero
dropped bytes. The host then exits. On the next startup, TypeScript maps the
receipt through the current `process_lost`/`control_lost` and bounded retry
policy; the host never writes product state or fabricates Stop/cancelled.

After restart, TypeScript claims the existing recovery lease and validates the
opaque attempt token plus host/child birth identities. Then it follows current
product semantics:

- if an exact Stop was already durably accepted, terminate the verified tree,
  acknowledge process exit, and complete the already-fenced terminal effects;
- otherwise, when the execution lease is stale, terminate only the verified
  tree and use the current `process_lost`/`control_lost` failure and bounded
  retry policy;
- if process identity cannot be proven, do not guess-kill it; preserve an
  explicit detached/orphaned-unverified result and block duplicate ownership;
- if the child became terminal while detached, keep its receipt as diagnostic
  evidence, but do not promote it to a successful product result unless a
  separately approved recovery contract defines that reconciliation.

Normal Server `stop()` itself does not send a new termination command to an
already-started Agent Run. The recovery inspector/terminator is a bounded mode
of `rudder-process-host`, not a second lifecycle owner, and must prove the exact
recorded OS identity before acting.

#### Raw evidence versus visible output cutoff

Rust owns byte preservation; TypeScript owns user-visible admission. Stop uses
this order:

1. TypeScript durably commits the visible sequence/body-hash cutoff for the
   exact generation, attempt, and control version.
2. TypeScript sends an exact-attempt Stop command with the opaque owner token
   and accepted control version.
3. Rust acknowledges that command on the lifecycle channel, terminates the
   verified process tree, and finalizes the raw spool/receipt.
4. TypeScript may retain bytes acquired after the cutoff as diagnostic raw
   evidence, marked with arrival sequence and completeness, but must not project
   them into Chat body, transcript-visible continuation, or result summary.

Therefore post-cutoff diagnostic bytes count as persisted evidence, not as
`droppedBytes`. Provider cancellation acknowledgement remains non-terminal;
terminal product state still waits for the existing reconciliation rules.

#### Backpressure policy

The process host must not allow an unbounded Promise or message queue. The
default policy is:

1. continuously drain the child OS stdout/stderr pipes into bounded in-memory
   frames and a byte-exact framed spool;
2. treat the spool sequence/offset/hash as the evidence source of truth;
3. copy raw bytes to fd 4/fd 5 while the live consumer keeps up; if a live pipe
   reaches its high-water mark, stop enqueueing live copies, emit an explicit
   `live_gap` with spool ranges, and let TypeScript catch up from bounded spool
   reads instead of blocking child drainage;
4. notify TypeScript with committed offsets and bounded live excerpts;
5. prioritize Stop/control frames over log delivery;
6. never silently drop persisted bytes; raw-pipe gaps are explicit and do not
   count as evidence loss when their spool ranges verify;
7. enforce the persisted detached deadline and spool-limit terminal edges even
   when no recovery owner ever starts;
8. if disk persistence fails, stop accepting output, terminate the child, and
   fail the Run with a machine-readable evidence error.

#### Acceptance

- Synthetic output at 1, 10, and 50 MB/s; 10 MB, 100 MB, and 1 GB total;
  stdout/stderr interleave; Unicode split boundaries; invalid UTF-8; a single
  oversized line; slow disk; slow TypeScript consumer; abort; timeout; child
  crash; parent crash; and disk full.
- Byte count/hash and terminal process result match the optimized Node
  `WriteStream`/bounded-backpressure baseline where it completes correctly.
- Zero unreported dropped bytes; post-cutoff raw diagnostic bytes remain
  hash/offset-addressable while zero post-cutoff bytes enter Chat, visible
  transcript continuation, or result summary.
- Normal Server shutdown, abrupt Server crash, accepted-Stop-before-crash,
  command-sent-before-crash, stale lease, child-terminal-while-detached,
  unverified PID replacement, and restart recovery all preserve exact ownership
  and the current `process_lost`/`control_lost` versus stopped classification.
- With the Server permanently absent, an infinite-output child terminates at
  the earlier detached deadline/spool threshold, uses no more than the declared
  spool ceiling plus filesystem metadata, leaves no verified descendant, and
  produces the exact non-success receipt for later reconciliation.
- Stop admission p95 below 250 ms under pressure; process-tree terminal proof
  remains within the existing hard deadline.
- Under the fixed flood workload, peak RSS is at least 30% lower or a reproduced
  unbounded-growth/Stop reliability defect is closed.
- Ordinary model-dominated Run duration is expected to improve only 0-5% and
  is not used as the main promotion claim.

### Slice 5: Run evidence offset indexer/parser

#### Output contract first

Before enabling the Rust parser, remove any production dependency on returning
complete `logContent + logChunks + transcript` in one response. Preserve the
existing summary, log byte paging, event paging, and transcript paging
contracts. Full export, when explicitly requested, must have a separate byte
budget and streaming artifact path.

#### Index format

Build a versioned, rebuildable sidecar index beside the immutable Run log. It
contains only stable facts:

- source log SHA-256 and byte length;
- index format and parser version;
- NDJSON record byte ranges;
- validated timestamp/stream where present;
- UTF-8 validity/error location;
- optional generic event-type tokens that do not encode provider semantics.

The index never becomes the only copy of evidence. A missing, corrupt, stale,
or version-mismatched index is discarded and rebuilt from the Run log.

#### Read path

Rust returns bounded record pages or streams a bounded export. TypeScript maps
records through the existing provider parser and redaction policy. No raw home
path, secret, or unredacted provider payload is added to diagnostics.

#### Acceptance

- 1, 10, 100, and 500 MiB logs with small/large chunks, Unicode splits,
  invalid UTF-8, long lines, 1% malformed NDJSON, incomplete terminal record,
  concurrent finalization, stale index, and corrupt index.
- Index rebuild and paged reads preserve byte offsets and source hash.
- TypeScript and Rust paths produce the same ordered, redacted transcript page,
  error anchors, diagnosis inputs, and output hashes for the supported corpus.
- The pre-index full-materialization path is reported only as eliminated-risk
  evidence. For 100 MiB or larger logs, Rust promotion requires at least 30%
  lower combined process-tree RSS, at least 20% detail p95 improvement, or
  closure of a reproduced offset/corruption/recovery defect versus the bounded
  TypeScript paging/index comparator, without returning a larger response.
- A full-response benchmark is reported separately and cannot be used to claim
  the paged user path improved or to feed `native_ab`.

### Slice 6: Workspace manifest/index watcher

#### Admission condition

Run a baseline first with 1,000, 100,000, and 1,000,000 path fixtures. Record
filesystem traversal time separately from Library DB mapping. Do not implement
the Rust index if DB mapping or response decoration is the dominant cost and
cannot be removed by this boundary.

#### Design

Reuse the backup path policy and walker to build a compact, rebuildable path
manifest under the Rudder instance data directory, never inside the user
workspace. The manifest records path, kind, normalized search key, size, mtime,
and generation. It does not index file content in this pilot.

The watcher:

- uses platform filesystem events behind one Rust interface;
- subscribes before the initial scan and records an event-loop watermark so
  events observed during the scan are applied before publishing that snapshot;
- debounces and coalesces path changes;
- increments a generation only after a durable manifest update;
- marks the index dirty on event overflow, root replacement, permission change,
  or unrecognized event;
- exposes `building`, `catching_up`, `dirty`, and
  `indexed_at_generation` states plus the observed event watermark and age;
- performs a full rescan after a dirty state before publishing another indexed
  generation; and
- stops when the owning Rudder process exits.

Queries return bounded path candidates and index freshness. TypeScript applies
organization scope, protected Library policy, current root binding, result
limits, and Library entry ID decoration.

An event-loop query barrier proves only that events already delivered to the
watcher were applied; it cannot prove that the OS has delivered every mutation
that occurred before the query. Therefore this plan does not use the term
`verified_current`. During `explicit_opt_in`, the response is compared against
the current live TypeScript traversal and any mismatch marks the index dirty
and returns the live result. Promotion to `accepted_default` requires one of:

1. a bounded verification algorithm that preserves the existing effective
   mention freshness contract and demonstrates a benefit over live traversal;
   or
2. an explicitly approved `LIBRARY.FILES.001` delta defining snapshot age,
   visible freshness, query barrier, retry/fallback, and newly created/deleted
   file behavior.

Without one of those gates, this slice remains diagnostic/opt-in even when its
benchmark is fast.

#### Acceptance

- 1,000, 100,000, and 1,000,000 paths; cold and warm query; common and sparse
  substring; Unicode/case; rename storm; create/delete; root replacement;
  permission error; event overflow; symlink loop; protected path; and restart.
- A result is never labeled `verified_current`; generation, observed watermark,
  state, and age are explicit, and dirty/catching-up states use the live
  TypeScript result.
- Index rebuild yields the same eligible path set and ordering as the current
  TypeScript traversal for the declared policy version.
- At 100,000 paths, Rust must improve cold sparse-query p95 by at least 20%,
  reduce combined process-tree CPU/RSS at least 30%, or close a reproduced
  watcher/rebuild correctness defect versus the cached TypeScript watcher plus
  DB/N+1-fixed comparator. Typical small-workspace performance may not regress
  more than 10%.
- If the baseline does not show material traversal cost, close this slice as
  `not_admitted` with evidence rather than shipping an unused native service.

## Cross-Slice Data And Compatibility Rules

### Stable source of truth

- Run logs and workspace files remain the source artifacts.
- Sidecar indexes and manifests are rebuildable acceleration structures.
- PostgreSQL rows remain the source of product state.
- Rust never mutates product status directly.

### Atomicity

All data operations use a private, uniquely owned staging path. The operation
validates and syncs output before entering one commit state machine. A new file
artifact or new versioned generation uses one same-filesystem atomic rename.
Replacement of an existing directory uses the receipt-backed two-rename
restore protocol above and is described as recoverable, not globally atomic.
Startup cleanup may remove only staging paths whose owner marker, operation ID,
receipt phase, and dead process identity all match. Broad temp cleanup is
forbidden.

### Concurrency

TypeScript acquires product/database locks before invoking Rust. Rust also
creates an operation-owner marker and refuses a conflicting writer for the same
target generation. Duplicate request IDs are idempotent only before side
effects; after acceptance the caller must observe the original operation
instead of starting another.

### Observability

Every operation reports bounded structured metrics:

- phase and terminal status;
- bytes read/written;
- files/records visited and included;
- elapsed time by phase;
- peak buffered bytes;
- queue high-water/spill bytes for process I/O;
- index generation/freshness;
- error code without secret/path content.

Metrics are supporting evidence. They do not replace the public workflow or
the immutable eval packet.

## Benchmark Plan

### Measurement identity

Every comparison records:

- `rudder-oss` commit and dirty diff fingerprint;
- optimized Node comparator commit/path fingerprint and Rust activation flags;
- Rust binary target, version, protocol, SHA-256, and build profile;
- Desktop/server/runtime build identity;
- machine, OS, architecture, power mode, and filesystem;
- instance, organization, workspace/data fixture manifest and hash;
- warmups, measured iterations, cache state, concurrency, and operation order.

### Sampling

- Deterministic micro/service benchmarks use at least 3 warmups followed by
  randomized paired blocks. Record the random seed, block/order sequence, cache
  state, and every raw observation.
- A latency p95 promotion claim requires at least 100 measured operations per
  arm and a reported bootstrap 95% confidence interval for the paired delta.
  Twenty observations may be used for directional planning but their empirical
  p95 is effectively a tail maximum and cannot satisfy a promotion gate.
- A benefit threshold passes only when the point estimate reaches the declared
  threshold (for example p95 improvement >=20% or RSS reduction >=30%) and the
  paired 95% confidence-interval lower bound is above 0%. A non-regression
  threshold passes only when its point estimate and 95% confidence-interval
  upper bound are both within the allowed 10% regression. An interval crossing
  0 for benefit, or crossing 10% for non-regression, is inconclusive and cannot
  promote the slice on that metric.
- Large 1 GB or destructive failure injection: enough repetitions to expose
  variance, with the lower count declared; report median/range and individual
  failures rather than inventing a p95 when 100 operations are impractical.
- Live Agent evals: follow the owning case repetition policy and report trial
  variance; do not manufacture p95 from a tiny sample.

### Metrics

Use exact names:

- process RSS and JavaScript heap;
- Rust process RSS where separate;
- p50/p95/max elapsed time;
- CPU time;
- event-loop delay;
- bytes read/written and response bytes;
- queue high-water, spill bytes, dropped bytes;
- Stop admission and terminal cleanup latency;
- archive/index size and rebuild time;
- correctness, hash, state, and forbidden-behavior result.

When Rust moves memory into a helper process, report combined process-tree RSS
as well as per-process RSS. Do not call lower Node heap a system memory win if
the Rust child consumed the same or more memory.

## Rudder Evals A/B Plan

### New explicit mode

Add an explicit `native_ab` mode to `rudder-evals`; do not coerce this work into
`host_ab`, `probe_preflight`, `shadow_live`, or `live_eval`.

`native_ab` is comparative evidence and always has `productPass: false`. It
groups all case/arm/trial observations in one campaign Run and uses the existing
Experiment, Observation, artifact, registry, API, report, and Dashboard flow.

### Current `rudder-evals` gap and implementation work

The 2026-08-12 inspection of `rudder-evals` found zero `native_ab` occurrences
outside these proposal/plan artifacts. The inspected worktree was not an
immutable candidate (`HEAD 1b2a23b` plus an uncommitted Rust rewrite), so these
facts are a gap inventory, not an acceptance lease:

| Required stage | Current state | Required work |
| --- | --- | --- |
| native case/cohort definitions | missing | add lifecycle, workspace-integrity, pressure, and protected-regression schemas/cases |
| isolated/counterbalanced runner | missing | start two exact-source Rudder instances, verify effective flags/health, randomize recorded arm order, and tear down exact roots |
| immutable packet identity | partial | add baseline/product/bundle/Node/Rust binary/protocol/capability, instance/org/data/workspace, arm-order, metric-distribution, and correctness identities |
| native-aware ingestor | missing | accept `native_ab` explicitly and fail closed; unknown mode must never downgrade to `probe_preflight` |
| registry model | partial | persist native campaign/arm/trial metrics and comparable/not-comparable reasons without changing product-pass counts |
| API and artifacts | present generically | prove native campaign, observations, reports, artifacts, and `/static-dashboard` route round-trip |
| Dashboard comparison | partial | replace hard-coded `c0`/`c5` assumptions with `node_baseline`/`rust_candidate`; show correctness, process-tree RSS, latency distribution, package cost, and failures |

Implement this in dependency order:

1. Add `native_ab` plus `native_ab_pass`, `native_ab_fail`, and
   `native_ab_not_comparable` to the domain/schema/validation contract. Derive
   `productPass: false` for every native classification.
2. Add native case/cohort definitions and the arm manifest. Do not alias
   `host_ab`; host conditions and implementation-language arms are different
   causal questions.
3. Implement the isolated two-instance runner and record the seed/order,
   effective capability tuple, health identity, fixture hashes, and teardown.
4. Extend Packet V2 and checksums, then make ingestion reject missing identity
   or unknown modes rather than infer a safer-looking mode.
5. Extend registry tables/projections, API payloads, report generation, and the
   native-specific Dashboard comparison.
6. Add schema, runner, ingest, registry, API, Dashboard, and product-pass
   regression tests, then run one sealed rehearsal packet through the full
   flow before any Rust slice may use `native_ab` as promotion evidence.

Before Slice 1 or Slice 2 promotion, record this work as its own dated
`rudder-evals/doc/plans/` implementation plan against a clean, frozen eval
candidate. It is a Phase 0E dependency, not work deferred to the final
portfolio campaign.

### Arms

Run two isolated instances from the same `rudder-oss` implementation commit:

- `node_baseline`: all six capability flags select the retained Node path;
- `rust_candidate`: the selected accepted slice or final six-slice portfolio
  selects the exact Rust binaries.

Lock the following across arms:

- Rudder source and UI bundle;
- database schema and seeded data snapshot;
- Agent runtime, model, reasoning effort, prompt, skills, tools, and managed
  home policy;
- case/scorer/judge versions;
- workspace files and run-log fixtures;
- network policy, timeouts, budget, and machine.

Counterbalance arm order and use separate instance roots, ports, PostgreSQL
data, organizations, workspaces, and binary logs. Never point both arms at one
mutable workspace.

### Eval cohorts

1. **Blocking behavior cohort**: the current V1 blocking live cases
   `create_issue_by_chat`, `skills_question_in_issue`, and
   `tools_question_in_issue`.
2. **Runtime lifecycle cohort**: Local App start/use/Stop, Agent Run output and
   Stop, parent loss, and recovery.
3. **Workspace integrity cohort**: backup, browse, download, sparse recovery,
   restore, and indexed mention search.
4. **Pressure cohort**: large logs, high output rate, large archives, high file
   counts, slow disk/consumer, and injected interruption.
5. **Protected regressions**: organization isolation, secret redaction,
   evidence placement, terminal-state uniqueness, and no post-Stop output.

The lifecycle/workspace/pressure cohorts may begin as deterministic or
`shadow_live` cases, but the final selected Rust default must also run the
blocking `live_eval` suite independently after `native_ab`.

No native eval runner may request a product `projection=full`. Slice 5 remains
blocked until product and eval workloads use bounded summary/byte/event/
transcript paging. Any packet produced through a full-materialization path is
classified non-comparable for the evidence-index promotion claim.

### Packet identity

Each immutable packet records:

- baseline and candidate refs;
- product commit and bundle hash;
- Node path fingerprint;
- Rust binary hashes/protocol/capabilities;
- instance/org/data/workspace identities;
- effective runtime/model/reasoning effort;
- case/scorer versions and repetition index;
- performance metrics and correctness sentinels;
- exact failure taxonomy and whether the result is comparable.

The required flow is:

```text
case definitions
  -> native_ab runner
  -> immutable packet
  -> ingestor
  -> registry
  -> API
  -> Dashboard
```

A standalone Markdown report is incomplete.

### Promotion gates

For each slice and the final portfolio:

- candidate hard-state pass rate is not below the comparable baseline;
- every blocking live case passes the candidate's independent `live_eval`;
- zero new forbidden behavior, organization leak, secret exposure, missing
  evidence, duplicate owner, or invalid terminal transition;
- correctness outputs are identical where byte/state parity is required;
- at least one declared performance/reliability threshold for the slice is met;
- performance benefits and non-regression limits satisfy the point-estimate and
  confidence-interval decision rule in the Benchmark Plan; deterministic
  reliability-defect closure may satisfy the benefit gate only when the frozen
  reproducer passes every required repetition with no new hard-state failure;
- no undeclared metric regresses more than 10% or has a 95% confidence-interval
  upper bound above 10% without an accepted explanation;
- result variance and non-comparable trials remain visible;
- reviewer and verifier accept the same exact candidate after eval evidence is
  sealed.

Failure to show a benefit does not justify changing the threshold. The slice
stays opt-in, returns to Node default, or is removed.

### Portfolio comparison after all six slices

After every slice has an individual receipt, run a final all-Node versus
all-Rust portfolio campaign. It must measure both resource totals and the real
Agent work loop because isolated wins may interact through process count,
caches, disk I/O, startup, or failure recovery.

Report:

- blocking and shadow/live case deltas;
- accepted-task and terminal-state parity;
- total process-tree RSS/CPU and Desktop/server RSS separately;
- time to Local App ready, first Run output, Run terminal state, backup
  completion, restore completion, install completion, and mention-search result;
- Stop/cancel/restart recovery distributions;
- new binary/package size and cold-start cost;
- failures by taxonomy, not one composite score.

This final campaign decides whether the native foundation as a whole is worth
maintaining. It does not automatically authorize removing all Node paths.

## Test Matrix

### Rust unit and property tests

- protocol encode/decode and frame limits;
- path containment, Unicode normalization, separators, reserved names, and
  symlink handling;
- process identity/generation and stop escalation;
- archive round-trip, CRC/SHA, duplicate/collision/traversal/zip-bomb rejection;
- NDJSON byte offsets, invalid UTF-8, malformed lines, and index rebuild;
- watcher coalescing, overflow, generation, and rescan;
- cancellation and exactly-one terminal response.

Use property/fuzz tests for protocol framing, archive entry paths, NDJSON
framing, and manifest/index parsers. Persist every discovered regression as a
small deterministic fixture.

### Cross-language contract tests

- TypeScript request -> Rust parse;
- Rust event -> TypeScript parse;
- golden error codes and exit mapping;
- older compatible minor protocol fixture;
- unsupported major protocol rejection;
- binary capability mismatch and downgrade refusal after operation acceptance.

### Rudder integration and E2E

- Existing Local App/App Builder E2E with Rust opt-in and Node baseline.
- Workspace backup routes/service tests plus real create/browse/download/
  restore E2E.
- Agent Run real-runtime output/Stop/evidence workflow.
- Run Intelligence API/CLI paging and diagnosis workflow.
- Workspace mention selection from the real UI/API with indexed and fallback
  paths.
- Packaged Desktop boot, profile isolation, migrations, startup, and shutdown.

Because this is feature/runtime work, unit or smoke tests do not replace the
real public workflow E2E.

### Repository gates

Before handoff of each implementation candidate:

```sh
cargo fmt --manifest-path native/Cargo.toml --all --check
cargo clippy --manifest-path native/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml --all-targets
pnpm exec vitest run scripts/release-package-map.test.mjs
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
pnpm product-logic:check
pnpm desktop:verify
```

Run the relevant feature E2E and `rudder-evals` campaign in addition to these
gates. If machine load or unrelated dirty work invalidates a full-suite run,
preserve the exact failure and rerun in an isolated worktree/runtime; do not
reinterpret it as green.

## Security And Privacy

- Pin Rust dependencies in `Cargo.lock`; run license/advisory policy and retain
  an auditable dependency inventory.
- No network listener is added by the native layer.
- Do not pass secrets in argv. Environment inheritance remains allowlisted and
  operation diagnostics remain redacted.
- Native helpers must never follow workspace symlinks or extract links/device
  files/FIFOs.
- Archive and index parsers apply byte, file-count, path-length, nesting,
  compression-ratio, and elapsed-time budgets before allocation.
- Temporary roots use restrictive permissions, owner markers, unique operation
  IDs, and exact cleanup.
- Binary hashes and protocol versions are evidence, not authorization; the
  TypeScript product layer still performs identity and permission checks.
- Run logs, workspace files, archive bytes, and secret-bearing environment
  values are not added to telemetry or eval reports.

## Rollback Plan

### Before operation acceptance

If the binary is missing, incompatible, corrupt, or fails handshake, record one
bounded diagnostic and select the retained Node path when that capability is
still in explicit opt-in/default-with-fallback state.

### After operation acceptance

- Process operation: terminate or prove the Rust-owned tree state; never spawn
  a Node duplicate for the same generation.
- Data operation before publish: remove only the exact owned staging root and
  leave the prior artifact/generation untouched.
- Data operation after publish: treat the published artifact as immutable and
  reconcile product metadata; do not overwrite it with a second Node result.
- Index failure: discard the rebuildable index and use bounded source reads or
  the Node path; never discard the source log/workspace.

### Default rollback

Changing a capability from `accepted_default` back to Node requires:

- a named regression or missing acceptance receipt;
- the exact capability flag and affected versions;
- proof no Rust-owned process or staging operation remains;
- retention of the failed Rust artifact/log for diagnosis without secrets;
- a new baseline receipt after rollback.

## Delivery Sequence And Decision Gates

| Phase | Deliverable | Dependency | Exit decision |
| --- | --- | --- | --- |
| 0A | Cargo workspace, protocol, packaging, per-target activation | none | Can every target run protocol fixtures and can the isolated macOS App execute the exact helper? |
| 0B | optimized Node comparator harnesses | current Node paths | Are language-neutral streaming/backpressure fixes measured first? |
| 0E | `rudder-evals native_ab` schema-to-Dashboard foundation | frozen eval candidate | Does one sealed rehearsal round-trip with `productPass: false`? |
| 1A | Local App process host | 0A + relevant 0B comparator | Process semantics and packaged Local App PASS |
| 1B | Streaming Workspace backup v2 | 0A + relevant 0B comparator | Parity plus RSS/reliability gate PASS |
| 2A | Runtime payload installer/extractor | 1B archive core | Memory/atomic publish gate PASS |
| 2B | Agent Run process/I/O host | 1A stable dogfood | Stop/evidence/backpressure gate PASS |
| 3A | Run evidence indexer/parser | 2B log format and output contract | Paged detail parity/benefit PASS |
| 3B | Workspace manifest/index watcher | 1B walker, comparator benchmark, and freshness contract gate | Search benefit PASS, opt-in only, or `not_admitted` |
| 4 | Final `native_ab` portfolio and candidate `live_eval` | all admitted slices | Promote, keep opt-in, or remove per slice |

Do not promote Phase 1A/1B without 0E. Do not begin Phase 2B merely because
Phase 1A compiles. Do not begin Phase 3A until `projection=full` has been removed
from the default detail path and eval workloads. Do not implement Phase 3B if
its admission benchmark points to database mapping rather than traversal, and
do not make it default without the freshness gate above.

## Estimated Effort

These are planning ranges, not delivery commitments:

| Slice | Incremental engineering range |
| --- | ---: |
| Foundation and packaging | 1-2 weeks |
| Optimized Node comparators and shared benchmark sampler | 1-2 weeks |
| `native_ab` data model, runner, ingest, API, and Dashboard | 2-4 weeks |
| Local App process host | 2-3 weeks |
| Streaming Workspace backup | 2-4 weeks |
| Runtime payload installer/extractor | 1-2 weeks after archive core |
| Agent Run process/I/O host | 3-5 weeks after process core |
| Run evidence indexer/parser | 2-3 weeks after output contract |
| Workspace manifest/index watcher | 2-4 weeks if admitted |
| Final eval campaign and evidence reconciliation | 1-2 weeks |

Sequential total: approximately 17-31 engineering weeks, with decision gates
that may stop or defer a slice. This is implementation effort, not a portfolio
delivery date. It excludes the seven-day Local App dogfood gate, release
calendar/at-least-one-stable-release intervals before `legacy_removed`, waiting
for cross-platform machines, and any separately approved Product Logic work.
The plan should not reserve the full range before Phase 1 proves the native
foundation.

## Definition Of Done

The pilot is complete only when:

1. Every admitted slice has an exact source/binary/build/runtime acceptance
   packet.
2. Every Rudder-owned Rust package reports the same version as the normal
   Rudder release represented by that candidate.
3. macOS arm64 packaged public workflows pass; other platforms are labeled no
   stronger than their real evidence.
4. Node/Rust correctness and pressure benchmarks use comparable workloads and
   report process-tree RSS, latency, bytes, and reliability.
5. `rudder-evals` stores the final `native_ab` campaign through immutable
   packets, registry, API, reports, and Dashboard.
6. The selected Rust candidate independently passes the blocking `live_eval`
   cases and relevant real-runtime/Desktop acceptance.
7. No new organization, permission, secret, path, evidence, terminal-state, or
   recovery regression remains.
8. Each promoted slice meets its declared performance or reliability gate;
   unsupported benefit claims are removed.
9. Rollback has been exercised against the exact packaged candidate.
10. Reviewer acceptance and verifier PASS apply to the same unchanged
   candidate.
11. Product Logic Registry changes, if any became necessary, are proposed and
    explicitly approved separately before editing `doc/product/**`.

## Phase-Gated Implementation Decisions

- Select and pin the Rust ZIP implementation only after archive path, ZIP64,
  streaming central-directory, and fuzzing requirements are proven.
- Phase 0B uses one external process-tree sampler for both arms: monotonic wall
  time plus platform process APIs (`proc_pidinfo` on macOS, `/proc` on Linux,
  and Job Object/GetProcessMemoryInfo on Windows) at a fixed recorded interval.
  JavaScript heap and Rust allocator metrics are secondary diagnostics, not the
  cross-arm RSS source. Calibrate and report sampler overhead.
- Phase 0A freezes the exact protocol schema, initial minor, and stable error
  namespace before side-effecting code. Required categories include protocol/
  capability mismatch, unsafe input, integrity, I/O/resource exhaustion,
  process ownership, control loss, cancellation, and internal failure; public
  messages stay sanitized.
- The Local App -> Agent Run dogfood gate is seven consecutive days plus 100
  accepted lifecycle cycles with the zero-P1 conditions stated in Slice 4.
- Phase 0E first creates the separate dated `rudder-evals` implementation plan,
  then changes schema, runner, packet, ingest, registry, API, and Dashboard in
  the dependency order specified above.

These choices do not change the approved six-slice scope. They are bounded
implementation decisions whose evidence must be reviewed before the relevant
slice starts.
