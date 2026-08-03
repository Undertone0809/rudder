---
title: OpenClaw and Hermes Runtime Compatibility Refresh
date: 2026-08-03
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - openclaw_gateway
  - hermes_gateway
  - runtime_compatibility
issue:
related_plans:
  - 2026-06-24-agent-run-scene-runtime-contract.md
  - 2026-06-27-agent-custom-integrations.md
supersedes: []
related_code:
  - packages/agent-runtimes/openclaw-gateway/src/server/execute.ts
  - server/src/agent-runtimes/registry.ts
  - ui/src/agent-runtimes/registry.ts
  - ui/src/components/AgentConfigForm.advanced.tsx
  - ui/src/components/NewAgentDialog.tsx
  - ui/src/pages/NewAgent.tsx
  - ui/src/components/OnboardingWizard.tsx
  - scripts/smoke/openclaw-docker-ui.sh
commit_refs:
  - 5fb9c771c
updated_at: 2026-08-04
---

# OpenClaw and Hermes Runtime Compatibility Refresh

## Executive Decision

Rudder should restore current, first-class support for users who already run
OpenClaw or Hermes, using each upstream project's current control plane rather
than treating both products as local command-line tools.

| Runtime | Product decision | Compatibility decision |
| --- | --- | --- |
| OpenClaw | Keep `openclaw_gateway` and upgrade the first-party adapter. | Support the current Gateway protocol, including protocol v4 handshake semantics, capability validation, device pairing, and run-scoped native cancellation. |
| Hermes | Add `hermes_gateway` as the primary Hermes integration for the locked `0.19.1` API Server. | Use capability discovery, Runs, SSE events, approvals, Stop, and Sessions APIs. Rudder owns the canonical transcript and projects bounded tool/approval context into the text-only Runs surface; this is explicitly synthetic, not native or lossless. Do not make ACP or CLI output parsing the primary integration. |
| Legacy Hermes | Keep `hermes_local` temporarily and label it `Legacy`. | Freeze its current configuration semantics. Do not silently reinterpret a CLI-backed Agent as an API Server connection. |

The V1 user promise is deliberately narrow: a user who already has a
compatible, authenticated OpenClaw Gateway or Hermes API Server, or explicitly
chooses Rudder's managed local lifecycle, can connect it to Rudder, complete
Issue and Chat work, continue a provider-supported
workstream session, stop an in-flight run, respond to supported approvals, and
inspect normalized run evidence. Hermes V1 uses a Rudder-owned canonical
workstream transcript and a bounded `RUDDER_TOOL_CONTEXT_V1` projection for
the text-only Runs surface. Within the declared bounds, ordinary tool calls,
tool results, structured content, and approvals continue without a forced
reset. The continuity mode is recorded as `synthetic_tool_continuity`, never
`native` or `lossless`.

Rudder does not install, upgrade, or rewrite either upstream runtime in V1.
An explicit `rudder_managed_local` connection may start and supervise the
locked local server command; attach mode never starts or controls it. Rudder
also does not import provider credentials, skills, memory databases, or
bulk/synchronize historical conversations. Provider sessions are correlation
targets only; Rudder-originated history is canonical and any migration or
reset is explicit and auditable.
Upstream runtimes execute tools on their own hosts; Rudder remains the
orchestration, policy, review, and evidence system.

## Evidence Snapshot

This proposal was researched on 2026-08-03.

### OpenClaw is implemented but protocol-stale

Rudder has a first-party `openclaw_gateway` adapter that opens a WebSocket,
performs device authentication, calls `agent` and `agent.wait`, consumes Agent
events, and normalizes results. The integration is real, but its compatibility
claim is stale:

- Rudder hard-codes `minProtocol` and `maxProtocol` to `3`.
- OpenClaw `v2026.7.1`, released on 2026-07-13, sets the current protocol and
  general client minimum to `4`. Its v3 allowance applies to node/probe roles,
  not the operator execution client Rudder implements.
- The stable reference client still signs with its own `Date.now()` value, but
  current unreleased OpenClaw `main` requires the server challenge timestamp as
  `device.signedAt`. Rudder needs an explicit stable-versus-forward
  compatibility rule instead of another hard-coded timestamp assumption.
- Rudder does not call `sessions.abort` or `chat.abort` when Stop is accepted.
- The stock smoke harness defaults to OpenClaw `v2026.3.2` and disables device
  authentication, so it does not prove current secure compatibility.
- OpenClaw is exposed by some New Agent paths, while other UI availability
  lists still classify it as `Coming soon`.

### Hermes is built on a stale compatibility package

Rudder currently registers `hermes_local` through
`hermes-paperclip-adapter@0.3.0`, last published on 2026-03-31. The package
spawns `hermes chat`, forces non-interactive `--yolo` behavior, parses human
stdout with regular expressions, carries Paperclip-era prompt and environment
names, and cannot reliably map Rudder Stop or approval semantics. Its published
build also lacks later fixes for runtime config and Rudder auth-token injection.

Hermes Agent `0.19.1`, released as `v2026.7.30` on 2026-07-30, exposes a
machine-readable API Server intended for external clients. Its surface includes
`GET /v1/capabilities`, asynchronous Runs, SSE run events, run approval and
Stop endpoints, session resources, health, and model discovery. This is a
better product boundary for connecting an already-running Hermes Agent than a
per-run CLI subprocess or ACP editor bridge.

Hermes is also absent from the standard New Agent picker even though
`hermes_local` exists in shared constants and the server registry. Rudder's
current UI therefore overstates OpenClaw unavailability and understates Hermes
technical debt at the same time.

## Product Goal

Enable an operator to connect an existing OpenClaw or Hermes Agent to Rudder
and complete a trustworthy end-to-end work loop with setup diagnostics,
session continuity, governed runtime control, and reviewable evidence.

This contributes to Rudder's north-star metric only when the external runtime
actually completes the assignment, execution, review, and evidence path. A
successful TCP connection or one-off prompt is not a completed work loop.

## Users And Jobs To Be Done

### Existing OpenClaw operator

"I already run an OpenClaw Gateway. Let me pair Rudder as a least-privilege
client, and tell me exactly whether the URL, protocol, device, token, or scopes
need attention."

### Existing Hermes operator

"I already run Hermes with my models, tools, and sessions. Let Rudder connect
to that server without copying my provider keys or pretending its workspace is
on the Rudder host."

### Reviewer or administrator

"Show me which external runtime and version did the work, which remote session
continued, which approvals and tools were involved, whether evidence is
complete, and whether Stop reached a real terminal state."

## Goals

- Make OpenClaw and Hermes selectable from every standard Agent creation path.
- Detect compatibility through an authenticated protocol handshake, not only
  executable, port, or version-string checks.
- Support Issue Runs and Chat turns with provider-proven per-workstream
  continuity: full mapped-session continuity for OpenClaw and bounded
  `synthetic_tool_continuity` for Hermes `0.19.1`.
- Map provider-native approvals and Stop into Rudder's durable control model.
- Normalize runtime identity, lifecycle, transcript, usage, and error evidence.
- Preserve organization boundaries and prevent credential leakage or unsafe
  endpoint access.
- Continuously test current upstream stable releases before claiming support.

## Non-Goals

- Automatic OpenClaw or Hermes installation, upgrade, or config edits. Starting
  a locked local command is allowed only through an explicit managed lifecycle
  choice; attach mode never starts or controls an existing process.
- Managing model-provider subscriptions or importing provider credentials.
- Mirroring upstream skills, memory stores, jobs, cron, channels, plugins,
  subagents, or bulk/synchronized historical conversations into Rudder.
- ACP-based Hermes hosting, CLI stdout scraping, or a new generic arbitrary
  process adapter as the primary Hermes path.
- Rudder-hosted execution of tools that the external runtime advertises as
  server-side execution.
- Support promises for unreleased upstream `main`, beta, or release-candidate
  builds.
- Automatic migration of existing `hermes_local` Agents.

## Success Criteria

The feature is ready when all of the following are true:

- A user can create and test OpenClaw and Hermes Agents from every standard New
  Agent surface without editing raw adapter JSON.
- Preflight distinguishes ready, unreachable, authentication required, pairing
  required, permission/scope required, incompatible protocol, unsupported
  version, and unverified version states.
- Stock OpenClaw `v2026.7.1` and stock Hermes Agent `0.19.1` each complete one
  Issue workflow and one Chat turn through the real UI and backend.
- A second turn in the same Issue workstream or Chat conversation proves prior
  context was supplied. OpenClaw reuses its mapped provider session; Hermes
  reuses its mapped Sessions API record and sends the bounded, hash-linked
  `RUDDER_TOOL_CONTEXT_V1` projection from the canonical Rudder transcript.
  Projection is atomic and never silently drops causal events.
- Stop freezes Rudder-visible output, calls the exact upstream run/session
  cancellation endpoint, and records the verified terminal outcome.
- Hermes approval requests can be resolved through Rudder without using
  `--yolo`; unsupported approval states fail closed.
- Run evidence identifies the adapter version, upstream version, negotiated
  protocol/capabilities, upstream run/session, terminal state, and evidence
  completeness without exposing secrets.
- Existing `openclaw_gateway` Agents remain compatible or enter an actionable
  upgrade/pairing state. Existing `hermes_local` Agents remain explicitly
  Legacy until an operator migrates them.
- `hermes_gateway` creation, Agent Detail, Run evidence, and the compatibility
  matrix display the `synthetic_tool_continuity` boundary and never imply that
  the provider itself offers native or lossless replay.
- Latest and previous-supported upstream releases run in a scheduled
  compatibility matrix; an untested new release is labeled `Unverified`, not
  automatically `Supported`.

Initial operational targets after release are:

- at least 90% of users with a supported, already-authenticated runtime pass
  preflight without manual JSON editing;
- at least 95% of accepted Stop requests reach a verified upstream terminal
  state within 3 seconds on a healthy local connection;
- at least 95% of eligible second-turn acceptance runs retain the expected
  provider session and, for Hermes, a complete bounded canonical projection;
- zero runtime secrets in API responses, transcripts, activity payloads, or
  persisted diagnostic logs.

## Common Product Requirements

### C1. External runtime connection record

Both integrations use a normalized, organization-scoped connection model:

- runtime type and adapter version;
- connection mode: `rudder_managed_local` or `attach_existing_local`;
- endpoint and deployment classification;
- secret reference, never a plaintext secret in general config JSON;
- last capability snapshot, upstream version, protocol version, and test time;
- readiness status and machine-readable remediation code;
- endpoint host, server-reported execution mode when exposed (otherwise an
  explicit `Not exposed` value), operator-supplied host label,
  verified instance identity when available, and the workspace claim plus its
  verification status.

Managed mode records the exact provider process identity and start epoch that
Rudder owns, plus the resolved workspace binding. Attach mode records the
observed process identity/CWD or provider selector used to prove the binding.
One managed process identity/start epoch has one lifecycle owner; an attached
Agent may observe and use it but cannot stop, restart, or rebind that owner.

A managed launch is a versioned launch contract, not an arbitrary shell
command: it names the locked executable/package, immutable argument template,
expected upstream version, resolved workspace, and an explicit child-environment
allowlist. Secret references are resolved only for the child process, never
serialized into the Agent config or inherited wholesale from the Rudder
server. Rudder records the launch contract digest, PID/start epoch, and
redacted stdout/stderr diagnostics before advertising the process as managed.

Provider run IDs and session IDs belong to Run/workstream mappings, not static
Agent config. Multiple Agents in one organization may point to one server, but
they must not share provider sessions unless an explicit future product
contract allows it.

### C2. One upstream trust domain per organization

OpenClaw operator credentials and the Hermes API Server bearer key authorize a
trusted upstream control plane; neither upstream offers hostile multi-tenant
isolation on Rudder's organization boundary. V1 therefore enforces:

- one endpoint/credential tuple belongs to exactly one Rudder organization;
- a secret reference already bound to one organization cannot be attached to
  another organization, even when both organizations are visible to one board
  operator;
- provider run/session IDs are accepted only through Rudder's opaque mapping,
  never as arbitrary IDs supplied by a client or copied from another Agent;
- cross-organization endpoint/secret reuse fails preflight and execution.

Operators who need multiple organization trust domains must run separate
upstream instances or use separate, upstream-isolated credentials whose
isolation is proven before Rudder accepts them.

### C3. Honest upstream workspace declaration

V1 does not synchronize or checkout repositories onto the upstream host. The
operator must pre-provision each runtime in the intended workspace, and Rudder
must never pass a Rudder-host checkout path to a remote runtime.

Workspace verification is provider-specific. Rudder may label a workspace
`Verified` only when the locked upstream contract exposes both a deterministic
workspace selector/identity and a bounded, non-model-mediated access probe.
When those controls exist, Rudder verifies repository identity, required
read/write access, and realpath containment through that control-plane API and
stores only an opaque binding/fingerprint in general logs.

Stock Hermes `0.19.1` does not expose a workspace selector, stable workspace
identity, or deterministic filesystem probe through its capabilities, Runs, or
Sessions APIs. The operator may record a host/workspace claim for orientation,
but that claim is never launch proof. In `attach_existing_local`, Rudder must
independently bind the observed process/CWD (or a locked provider selector) to
the intended workspace; otherwise the connection is `unknown` and execution
is blocked. In `rudder_managed_local`, Rudder verifies the binding from its own
launch record before marking the connection ready.

The locked OpenClaw stable operator protocol likewise does not expose a
deterministic workspace identity plus bounded filesystem probe that Rudder can
use to establish the execution checkout. OpenClaw follows the same managed
versus attached binding rule. Gateway device authentication, version
negotiation, and session continuity prove control-plane identity, not filesystem
identity.

Same-host, different-path E2E proves that Rudder never substitutes its local
checkout path, and that UI/evidence distinguish managed binding, attached proof,
and an unverified workspace claim.
Filesystem isolation remains the trusted upstream operator's responsibility.

### C4. Authenticated, capability-aware preflight

The existing environment-test surface remains `pass`, `warn`, or `fail`, but
checks use stable codes and sanitized detected facts. Required common codes are:

- `runtime_unreachable`
- `runtime_auth_required`
- `runtime_pairing_required`
- `runtime_permission_required`
- `runtime_protocol_incompatible`
- `runtime_upgrade_required`
- `runtime_version_unverified`
- `runtime_capability_missing`
- `runtime_endpoint_blocked`
- `runtime_workspace_unverified`
- `runtime_workspace_identity_unverified`
- `runtime_trust_domain_conflict`

For OpenClaw and Hermes, an attached connection without independent process/CWD
or provider-selector proof fails with `runtime_workspace_unverified`. A
provider-reported or operator-declared workspace claim without Rudder launch
binding is `runtime_workspace_identity_unverified` and cannot authorize
workspace-dependent execution. Neither code may render a `Verified` workspace
badge.

Preflight must perform the cheapest authenticated handshake that proves the
same path used for execution. A present executable, open port, unauthenticated
health endpoint, or parsable version string cannot produce `pass` by itself.

### C5. Honest capability projection

The registry and UI expose only capabilities proven for the tested connection:

- Issue execution and Chat execution;
- session create and continuation;
- structured or normalized transcript events;
- approval response support;
- Stop type: native remote, process fallback, or unavailable;
- Steer type: native or Rudder `interrupt_continue` fallback;
- model discovery and usage/cost availability;
- evidence completeness guarantees.

The UI must not claim native Steer, native Stop acknowledgement, skills sync,
or lossless replay when the upstream connection cannot prove it.

### C6. Workstream-scoped session continuity

Rudder maintains separate provider session mappings for:

- each Agent and Chat conversation;
- each Agent and Issue workstream;
- each retry/continuation policy boundary defined by the Run contract.

Mappings are organization- and Agent-scoped. If an upstream session is absent,
Rudder records `runtime_session_missing`. It may create a replacement only when
policy allows and must emit a visible `session_reset` evidence marker.

For Hermes, the mapped Sessions API record is correlation and memory scope; the
Rudder canonical transcript remains authoritative for Issue, reviewer, and
direct Chat workstreams. All three surfaces use the same bounded
`synthetic_tool_continuity` projection and evidence rules.

### C7. Stop ordering and terminal reconciliation

When Rudder accepts Stop, it first commits the immutable visible-output cutoff
required by `RUN.CHAT.AGENT.001`. It then requests provider-native cancellation
for the exact upstream run/session and waits for the upstream terminal state.

Evidence records `cancelRequestedAt`, target identifiers, transport,
acknowledgement, terminal state, `cancelCompletedAt`, timeout, and fallback.
Late provider output may be preserved as hidden diagnostic evidence but cannot
mutate the visible Chat answer after the cutoff.

This requires a runtime-kernel control lifecycle, not only adapter code. For a
running external Run, accepting Stop records a durable cancellation intent and
projects `Stopping` while the Run remains nonterminal. The kernel must retain a
runtime control handle and provider run/session identifiers after upstream
acceptance. It invokes provider cancellation before any terminal `cancelled`
transition, and only the reconciler writes the terminal Run state. Queued Runs
that never reached a provider may still be cancelled immediately.

The cancellation intent includes a stable action ID, Rudder attempt epoch,
control version, target provider IDs, and a leased outbox delivery record. The
adapter registers its in-process control handle immediately after persisting
upstream acceptance and unregisters it only after terminal reconciliation.
Dispatch and terminal writes compare the attempt epoch/control version so a
late worker or an old handle cannot cancel or finalize a newer attempt.

After process restart, the outbox worker reacquires the lease and reconstructs
control from the persisted provider IDs and re-registers an attempt-fenced
adapter handle before dispatch. It may repeat the same provider Stop action
where the locked API is idempotent, then resumes status reconciliation; it
never resubmits the underlying Run. If the adapter cannot reconstruct control,
Rudder records `control_lost`, preserves the visible cutoff, and reconciles to
the real provider terminal state or `cancel_unverified`. Handle loss by itself
is never a successful cancellation outcome. A new attempt cannot claim, reuse,
or unregister an older attempt's control action.

`ctx.abortSignal` is only the local notification that freezes delivery and
wakes this fenced control path. It is not provider cancellation evidence.

### C8. Evidence completeness

Each Run records:

- `upstreamRuntime`, upstream version, and Rudder adapter version;
- transport, negotiated protocol, and capability snapshot hash;
- upstream run and session identifiers;
- assistant, reasoning, tool, tool-result, approval, and lifecycle events where
  the upstream supplies them;
- model, usage, and cost when supplied;
- terminal status, sanitized error classification, and cancellation outcome;
- session reset or migration markers;
- `complete`, `partial`, or `terminal_only` event-evidence completeness.

Human stdout/stderr is diagnostic evidence only. It must not be the primary
session, result, or usage parser for the new Hermes path.

All provider frames, tool arguments/results, approval payloads, errors, and
diagnostics pass through redaction before persistence. Raw unredacted SSE or
WebSocket frames may exist only in bounded in-memory processing and must not be
written to Run logs, transcripts, activity records, or failure artifacts.

### C9. Workstream parity and provider-native skills boundary

Issue, reviewer, and direct Chat Runs use the same external-runtime readiness,
workspace binding, session mapping, Stop reconciliation, transcript, and
evidence contracts. A provider-specific capability may narrow a surface, but
it cannot silently switch to a different continuity or cancellation policy.
Provider-native skills, tools, memories, and plugins may remain active on the
upstream host, but they remain unmanaged and separately identified; a connected
runtime never imports or reports them as Rudder-enabled skills or usage.

## OpenClaw Requirements

### O1. Protocol v4 handshake

The adapter must move frame parsing, version constants, signature construction,
and error handling behind a versioned protocol module. For OpenClaw
`v2026.7.1` it must:

- advertise a client range that includes protocol v4;
- include the challenge nonce in the signed device payload;
- use the locked `v2026.7.1` signing algorithm (`Date.now()` plus the challenge
  nonce) for the stable compatibility target;
- validate `hello-ok`, authentication, scopes, events, and policy;
- classify incompatible protocol ranges before execution;
- follow bounded server-provided retry timing for retryable startup states.

The unreleased OpenClaw `main` challenge-timestamp algorithm is a separate
`Unverified` forward fixture. Rudder selects signing rules from the locked
version/schema contract, never merely because a challenge payload contains
`ts`.

`hello-ok.features.methods` is a conservative positive-discovery surface, not
a complete list of callable RPC methods. Execution and cancellation methods
still require positive support in the locked version/schema matrix plus exact
stock E2E. A missing method cannot be waived by a side-effecting "safe probe";
the affected capability fails preflight or is advertised unavailable.

The first released support matrix is v4-only unless a previous stock release
passes the full same E2E suite. Node/probe support for v3 does not imply that a
general operator client may claim v3 support.

If OpenClaw does not publish a suitable stable protocol package, Rudder may
vendor only the required schemas from the locked stable tag, recording its tag,
source SHA, and license. Rudder must not depend on a floating beta package or
continue hand-writing unversioned frames.

### O2. Device pairing and least privilege

Rudder reuses a stable device private key and stores any issued device token
through the secret boundary. A broad bootstrap token may be used only after an
operator explicitly confirms the pairing transition. The steady-state Chat
connection requests `operator.write` (which includes read access) and adds
`operator.approvals` only when OpenClaw approvals are enabled. Agent execution,
wait/events, session inspection, and run-scoped abort request only their locked
minimum scopes. `operator.admin` and `operator.pairing` are not steady-state
defaults.

The setup UI presents pairing as a named remediation action. It never asks the
user to edit a device-key JSON payload or echoes tokens after save. Pairing
request ID/reason, requested and approved scopes, acting operator, and the
bootstrap-to-device credential transition are durable activity evidence.

OpenClaw approval events are supported only when the locked matrix proves the
requested/resolved event contract and the user opted into approval scope.
Requested, approved, denied, and timed-out states map to Rudder approvals and
fail closed. Rudder never silently broadens the connection to
`operator.admin` to make approval handling work.

### O3. Scene-specific execution, idempotency, and session mapping

Side-effecting OpenClaw calls use Rudder-derived idempotency keys. A retry of
the same Rudder attempt cannot create duplicate upstream work.

Issue work uses the versioned Agent execution surface. Chat work uses the
versioned Chat surface when the support matrix proves `chat.send`, Chat events,
`chat.history`, and `chat.abort` together. `chat.send` receives a stable
idempotency key; the adapter correlates events by upstream `runId` and sequence,
and round-trips the session identity returned by `chat.history`.

Before submitting work, Rudder persists the idempotency key and resolved
session key. As soon as upstream accepts, it persists the upstream run ID. If
the WebSocket drops after acceptance, Rudder reconnects without resubmitting,
uses `agent.wait` for Agent work or Chat history/in-flight state for Chat, and
reconciles by run ID. Unrecoverable event gaps are marked `partial`.

The existing configurable session-key strategy remains available, with Issue
workstream and Chat conversation identities as defaults. Advanced fixed or
per-run modes remain explicit. The adapter records the resolved session key and
upstream run ID in the Run mapping, never in user-visible logs.

### O4. Native Stop

Stop selects the method that matches the execution surface and locked upstream
contract. Chat calls `chat.abort` with the exact `sessionKey` and `runId`.
Agent/session execution may call `sessions.abort` only after stock E2E proves
its exact run-scoped semantics for the supported version. It must not issue a
global session abort when a run ID is known.

If the tested server lacks run-scoped cancellation, the adapter advertises Stop
as unavailable or fallback-only before execution. A generic WebSocket close is
not a successful native Stop acknowledgement.

### O5. Current secure compatibility proof

The stock harness must default to the current locked stable release with device
authentication enabled. Pairing reuse, protocol v4, session continuation, and
native Stop are release gates. A separate previous-supported job may exercise a
bounded older release; it cannot weaken the current secure defaults.

### O6. Local lifecycle and workspace binding

OpenClaw uses the same V1 lifecycle modes as Hermes. In
`rudder_managed_local`, Rudder starts and supervises only the recorded Gateway
process identity/start epoch and binds it to the resolved workspace. In
`attach_existing_local`, Rudder may use an already-running loopback Gateway
only after independent process/CWD or provider-selector proof; it never
restarts, terminates, or rebinds an unrelated process. A shared Gateway may be
attached by additional Agents, but only its single managed lifecycle owner may
control it. Managed Start-and-connect uses the same versioned executable,
immutable argument, upstream-version, workspace, and child-environment
allowlist contract; arbitrary shell fragments and inherited environment dumps
are not accepted.

## Hermes Requirements

### H1. Add a first-party `hermes_gateway` adapter

Create a Rudder-owned Hermes API Server adapter and expose it through server,
shared, CLI, and UI registries. New Hermes Agents use `hermes_gateway`.

Keep `hermes_local` as a Legacy runtime during migration. Do not change its
configuration semantics in place and do not make new Agents depend on
`hermes-paperclip-adapter`. The external package may be removed only after the
legacy retirement policy and rollback window are complete.

### H2. Local lifecycle and workspace binding

V1 supports only loopback Hermes API Servers and makes lifecycle ownership
explicit. An Agent chooses one of:

- `rudder_managed_local`: Rudder starts and supervises the locked server
  command, records process identity/start epoch, and binds the process to the
  resolved workspace before execution;
- `attach_existing_local`: the operator points Rudder at an already-running
  loopback server, and Rudder independently proves process identity/CWD (or a
  locked provider selector) before allowing workspace-dependent work.

An attach record never upgrades, restarts, terminates, or rebinds a process
owned by another managed Agent. A managed process identity and start epoch have
one lifecycle owner; additional Agents attach read-only to that ownership
record. Required config is the loopback API Server URL, a secret reference for
the Hermes bearer key, the connection mode, and an optional model route
override validated by discovery. An operator-supplied execution-host or
workspace label is orientation metadata only and never substitutes for the
binding proof. The managed UI action is `Start and connect`; it selects only a
stored launch contract and never accepts free-form executable paths, shell
fragments, or unrestricted environment overrides.

The setup UI states that tools and workspace access occur on the Hermes server
host, displays endpoint host separately from provider-reported execution mode,
and shows `unknown`/blocked when an attached workspace cannot be proven. V1
does not install, upgrade, or silently mutate an existing Hermes installation.

### H3. Capability discovery is authoritative

Before execution, Rudder authenticates and calls `GET /health/detailed` plus
`GET /v1/capabilities`. Detailed health supplies the upstream version; the
capability response supplies runtime mode, endpoint map, and feature flags.
Rudder validates both rather than assuming all Hermes versions share one route
set. A missing or unparseable exact version is
`runtime_version_unverified` and cannot be labeled `Supported`.

V1 requires the discovered equivalents of:

- `POST /v1/runs`;
- `GET /v1/runs/{run_id}`;
- `GET /v1/runs/{run_id}/events`;
- `POST /v1/runs/{run_id}/approval`;
- `POST /v1/runs/{run_id}/stop`;
- session create/read resources under `/api/sessions` plus
  `GET /api/sessions/{session_id}/messages`;
- server-side tool execution declaration;
- bearer authentication.

Feature-name parsing must recognize the upstream
`run_approval_response` capability. The endpoint map is the final authority
when a feature label and route naming differ.

### H4. Runs and synthetic tool continuity

Rudder creates one opaque Hermes Sessions API mapping per Agent/workstream and
persists only provider IDs returned by the authenticated adapter. Passing that
ID as `/v1/runs.session_id` is correlation, not proof that the provider
hydrated history. Rudder's canonical transcript is the authority for every
Rudder-originated Issue, reviewer, and Chat workstream.

Before each Run, Rudder builds the versioned `RUDDER_TOOL_CONTEXT_V1`
projection from the canonical transcript. The projection is quoted, escaped,
redacted, hash-linked, and carries the ordered causal relationship between
assistant/tool calls, tool results, structured content, approvals, and their
decisions. It is supplied through the text-only Runs history surface together
with the new input. The run records `continuityMode:
synthetic_tool_continuity`; it must never be labeled native or lossless.

The projection is atomic and bounded at 200 events, 64 KiB UTF-8 per event,
512 KiB UTF-8 aggregate, and a conservative 32,000-token estimate. It records
the source transcript hash, projection version, redaction/compaction metadata,
ordered inclusion and omission ranges, and final projection digest. It must
retain causally required tool/approval pairs. Unsafe, corrupt, unredactable,
or over-budget history fails before provider submission with an actionable
projection error; Rudder never truncates, silently drops, stringifies raw
objects, or starts an empty replacement session to make the turn pass.

Within those bounds, ordinary tool calls, tool results, structured content, and
approval events do not force a session reset. A later turn is blocked only when
the projection cannot be safely constructed or the mapped provider session is
missing/conflicted. Any reset or migration is an explicit, visible evidence
marker, never an implicit consequence of a tool-bearing turn.

The Runs API does not provide a proven idempotency key. Rudder never retries a
submission whose outcome is unknown. If no provider run ID is recoverable, the
attempt is `submission_indeterminate` and requires explicit operator recovery.
Provider session rotation is unsupported without a versioned effective-session
contract; Rudder records `runtime_session_rotation_unverifiable` and blocks
continuation rather than guessing or adopting a replacement.

Rudder does not inject a short-lived Rudder JWT into a prompt or transcript.
Issue checkout, context delivery, result persistence, and review orchestration
remain on the Rudder server side. A future Hermes-initiated Rudder MCP/API mode
requires a separately configured least-privilege credential and explicit
product contract.

### H5. SSE persistence and reconciliation

Rudder consumes the discovered run-events SSE endpoint, redacts each accepted
frame, assigns a local arrival ordinal and sanitized-frame fingerprint, and persists
the sanitized event before projecting it into the live transcript. Two
identical deltas remain two events. Deduplication is allowed only when upstream
supplies a stable event ID/sequence; content equality alone is not a dedupe key.

The current upstream transport buffer expires after five minutes when orphaned,
and terminal run status is retained for a limited period. Therefore Rudder must:

- subscribe immediately after run creation;
- persist every accepted event locally;
- reconcile final output and terminal state through the run-status endpoint;
- after SSE disconnect, assume event replay is unavailable, because the
  provider may delete the stream queue and return `404` on resubscribe;
- mark a disconnect gap as `partial` when intermediate events cannot be
  recovered;
- never claim lossless replay from the current protocol.

### H6. Approvals

Hermes approval events become durable Rudder approval actions. V1 exposes only
the `once` and `deny` choices, correlates every decision to the exact run and
approval request, and calls the run approval endpoint only after authorization
and capability validation. `session`, `always`, `all`, `resolve_all`, bulk
grant flags, and unknown choice/expansion fields are rejected fail-closed as
ordinary approval responses; expanding authority requires a separately named,
auditable runtime-policy change with explicit authorization.

The old `--yolo` behavior is not carried forward. Auto-approval is allowed only
when an explicit Rudder/runtime policy already permits the `once` action and
the outbound payload contains no broadening field.
Unknown, expired, malformed, or unrenderable requests fail closed. Approval
waits have a bounded deadline and survive a Rudder UI refresh.

### H7. Native Stop and honest Steer

Rudder freezes visible output, calls the exact run Stop endpoint, and treats the
initial Hermes `stopping` response as acknowledgement only. The Run becomes
cancelled only after status polling or terminal evidence reports `cancelled`.
A timeout becomes `cancel_unverified`; Rudder does not rewrite it as success.

Implementation includes the shared runtime kernel. Today
`cancelRunInternal` transitions `running` Runs to terminal `cancelled` before it
terminates the active execution. The Hermes/OpenClaw work must replace that
ordering for externally controlled Runs. The Run remains `running` while a
separately persisted cancellation control state moves through `requested` and
`acknowledged`; the UI projects this as `Stopping`. The kernel retains the
adapter control handle in-process and persists the provider run/session IDs so
restart recovery can resume reconciliation. It requests native cancellation,
then lets terminal reconciliation perform the one terminal Run transition.
`ctx.abortSignal` freezes local delivery and wakes the adapter control path; it
is not proof that the provider cancelled.

If Hermes reports `cancelled`, Rudder transitions to `cancelled`. If it reports
`completed` or `failed` after the request, Rudder records that real terminal
state plus `stop_raced`; the visible-output cutoff remains immutable. If status
retention expires without proof, reconciliation transitions the Run to `failed`
with error code `cancel_unverified`, never `cancelled`.

Stop is idempotent at the Rudder state-machine boundary. A repeat Stop after a
known provider terminal state is a no-op. A Stop `404` is a no-op only when
Rudder has already reconciled a terminal status; otherwise Rudder polls while
status retention permits and ends `cancel_unverified` if the provider state has
expired or cannot be proved.

Hermes initially advertises Rudder's `interrupt_continue` Steer fallback.
Native Stop does not by itself prove native mid-turn redirect semantics.

## Security And Deployment Requirements

External runtime endpoints are remote code-execution control planes. Connection
testing and execution use the same endpoint policy.

- Secrets are stored by reference, redacted from logs, omitted from read APIs,
  and never copied into transcripts or activity payloads.
- V1 accepts loopback-only OpenClaw and Hermes endpoints. OpenClaw uses
  `wss://` and Hermes uses `https://` for loopback TLS; plaintext is allowed
  only for explicitly configured loopback under `local_trusted`.
- Remote connectors, relays, and deployment-aware egress allowlists are future
  extension points, not V1 authorization to reach arbitrary private hosts.
- URL validation blocks metadata and link-local addresses, unsafe redirects,
  userinfo credentials, protocol downgrades, and DNS rebinding. Redirects are
  disabled by default for authenticated requests.
- Both preflight and execution revalidate the resolved destination under the
  same SSRF policy.
- Hermes connections require a non-empty strong bearer secret even if a future
  upstream build advertises optional auth.
- Runtime config, capability snapshots, session mappings, and mutations remain
  organization- and Agent-scoped. Mutations write activity evidence with actor
  and organization.
- An upstream endpoint/credential tuple is a single-organization trust domain;
  both preflight and execution reject cross-organization reuse.
- OpenClaw private keys/device tokens and Hermes bearer keys never share the
  Rudder Agent identity-token namespace.
- Rudder never imports provider keys, upstream credential files, skills,
  memories, or unrestricted environment dumps.
- Managed child processes receive only the versioned launch-contract
  environment allowlist and ephemeral secret-reference values. Secrets and
  launch arguments are redacted before diagnostics, and inherited server
  environment variables are excluded by default.
- Tool execution host, workspace semantics, endpoint host, and last tested time
  remain visible to the operator.

## User Experience

### Create or reconnect OpenClaw

1. The user chooses `OpenClaw` in any New Agent surface.
2. Rudder asks for loopback Gateway URL, protected connection credential,
   lifecycle mode, and an optional operator-supplied execution-host/workspace
   label. It explains that labels are orientation metadata, not binding proof.
3. `Test connection` performs v4 negotiation and authenticated capability
   validation.
4. If pairing is required, the UI shows the pending-device action and retest
   state; the user never edits key JSON.
5. Agent Detail displays upstream version, protocol, scopes, last tested time,
   connection status, endpoint host, execution mode as `Not exposed` when the
   Gateway does not report one, lifecycle owner, and the managed/attached
   workspace binding state. An attached connection without independent proof is
   visibly blocked.
6. Issue and Chat work stream into the normal Rudder Run view. Later turns
   continue the mapped session.
7. Stop freezes visible output and aborts only the active upstream run.

### Create or reconnect Hermes

1. The user chooses `Hermes` in any New Agent surface.
2. The form asks for a loopback API Server URL, bearer secret, lifecycle mode,
   and an optional execution-host/workspace label. It separately shows endpoint
   host and server-reported execution mode.
3. `Test connection` authenticates, reads capabilities/endpoints, and verifies
   Runs, events, approvals, Stop, and Sessions support.
4. Missing auth, unsupported versions, unsafe endpoints, or missing features
   produce one actionable remediation state.
5. Agent Detail displays the `synthetic_tool_continuity` boundary for stock
   `0.19.1` before the first Run.
6. Issue and Chat work create or continue an isolated Hermes workstream. Each
   eligible Run projects the canonical Rudder transcript through bounded
   `RUDDER_TOOL_CONTEXT_V1` into the text-only Runs surface, records the source
   hash/digest, and streams events into the normal Rudder Run view. Tool-call,
   tool-result, structured, and approval events continue within bounds; unsafe
   or over-budget projection is visibly blocked rather than reset silently.
7. Approval requests appear as Rudder actions. Stop remains `Stopping` until
   the provider reports a terminal state.
8. Any SSE gap is visible as partial evidence; final output/status are
   reconciled when possible.

### Migrate a Legacy Hermes Agent

1. Agent Detail labels `hermes_local` as `Legacy` and offers `Migrate to Hermes
   API`, without blocking existing history access.
2. The user supplies the new endpoint and secret reference.
3. Rudder validates capabilities and the selected lifecycle/workspace binding.
4. Only after a successful test may the user atomically switch the Agent to
   `hermes_gateway`. Historical Rudder Runs remain attached to the same Agent.
5. If no provider session can be mapped, the migration records a visible
   continuity reset. It never claims an old CLI session was resumed or imports
   provider history as Rudder continuity.

No automatic migration runs in the background. A failed test leaves the Agent
unchanged.

## Rollout Plan

### Slice 1: compatibility contract and harness

- Add normalized connection, capability, readiness, and evidence-completeness
  types.
- Add the runtime-kernel cancellation-intent/control-handle lifecycle needed to
  reconcile provider terminal state before marking an active Run cancelled.
- Add deployment-aware endpoint validation and secret references.
- Create locked current/previous upstream fixtures and black-box harnesses under
  the planned `tests/fixtures/external-runtimes/` directory and planned
  `tests/e2e/openclaw-hermes-runtime-compatibility.spec.ts`.
- Add `scripts/compatibility/openclaw-hermes-matrix.mjs` as the scheduled
  current/previous-stable and prerelease-filtered drift job. Update
  `scripts/smoke/openclaw-docker-ui.sh` to default to OpenClaw `v2026.7.1`
  with device authentication enabled; a `v2026.3.2` default is not release
  evidence.
- Capture failing baselines for OpenClaw v4 and legacy Hermes CLI behavior.

### Slice 2: OpenClaw recovery

- Implement the versioned v4 handshake and schema boundary.
- Add least-privilege pairing/token lifecycle, capability checks, idempotency,
  and run-scoped Stop.
- Align all UI availability/onboarding surfaces.
- Replace the stale, device-auth-disabled stock default with current secure E2E.

### Slice 3: Hermes API Server integration

- Add the first-party `hermes_gateway` adapter.
- Implement capability discovery, Runs, SSE persistence/reconciliation,
  Sessions mapping, canonical transcript projection, approvals, Stop, and
  normalized results.
- Add the standard creation/detail UI and execution-host disclosure.
- Add stock `0.19.1` black-box E2E.

### Slice 4: Legacy migration and drift operations

- Label `hermes_local` Legacy and add explicit tested migration.
- Remove the external Paperclip adapter only after the published deprecation
  window and rollback criteria are satisfied.
- Run scheduled latest-stable checks and deduplicate maintenance issues.

## Acceptance And Test Plan

### Automated contract tests

- OpenClaw stable v4 and forward-fixture challenge signing, incompatible ranges,
  malformed frames, explicit pairing/scopes/credential transition, approval
  requested/resolved/denied/timeout, device-token persistence, retry budget,
  event deduplication, idempotency, post-accept disconnect recovery, and
  run-scoped abort.
- Hermes capability and endpoint discovery, auth failure, missing feature,
  version missing/mismatch, unsafe endpoint, Runs start/status/indeterminate
  submission, Sessions mapping/missing, `RUDDER_TOOL_CONTEXT_V1` projection,
  canonical transcript hashing, tool/result/structured/approval continuity,
  projection redaction and size-bound refusal, unprovable rotation refusal,
  duplicate SSE delta, disconnect/404 gap, terminal reconciliation, `once` /
  `deny` approval allowlist, rejection of `session` / `always` / `all` /
  `resolve_all` and broadening flags, duplicate and
  post-complete Stop, Stop acknowledgement versus terminal cancellation, and
  expired upstream state.
- Secret redaction, endpoint SSRF/redirect/DNS-rebinding defense, organization
  isolation, same endpoint/secret cross-organization rejection, Agent session
  isolation, opaque Hermes session-key derivation, and secret-shaped provider
  events redacted before persistence.
- Loopback managed-process binding, attach-process/CWD proof, lifecycle-owner
  fencing, versioned launch contract, child-environment allowlist, redacted
  launch diagnostics, blocked unproven attachments, and no Rudder-local path
  reuse.
- Legacy Hermes migration success, failure rollback, and visible session reset.
- Shared Chat cutoff, late-output fencing, Issue result normalization, and
  evidence completeness for both adapters.
- Cancellation action-ID deduplication, outbox retry, attempt-epoch/control-
  version fencing, handle registration/unregistration, and restart recovery
  while Stop is `requested` or `acknowledged`.

### Required black-box E2E

Run against clean stock upstream releases, not only mocks.

Before runtime-specific execution, run the creation-surface matrix separately
for OpenClaw and Hermes through every standard surface: `NewAgentDialog`,
`NewAgent`, and `OnboardingWizard`. Each surface must list the runtime as an
ordinary selectable option, expose the same connection-mode/configuration and
Test connection flow, persist the same normalized record, and render the same
readiness remediation. Hermes must not be absent or marked `Coming soon` on
any one of the surfaces.

OpenClaw current stable:

1. Prepare the locked stock release with device authentication enabled, then
   create an Agent in `rudder_managed_local` mode and use the visible
   `Start and connect` action. Assert the versioned launch-contract digest,
   child-environment allowlist, process identity/start epoch, and redacted
   diagnostics are persisted. Repeat with a pre-started Gateway in
   `attach_existing_local` mode and prove independent CWD/selector binding is
   required while an unproven attachment is blocked.
2. Complete device pairing through the visible Rudder UI.
3. Assert through a WS frame proxy that Issue uses `agent`/`agent.wait`, while
   Chat uses `chat.history`/`chat.send` with the expected session ID and
   idempotency key.
4. Complete an assigned Issue and one Chat turn in a loopback-bound workspace
   path different from the Rudder checkout; continue each workstream and assert
   the same upstream session. For managed mode, assert the recorded process
   identity/start epoch owns the binding. For attach mode, assert independent
   CWD/selector proof is required and an unproven attachment is blocked.
5. Route the same Agent through a reviewer workflow. Exercise reviewer
   assignment, `approve`, `request_changes`, and blocked/unauthorized decisions
   through the visible UI, and assert each decision plus linked Run/result
   evidence is persisted under the same external attempt and organization.
6. Drop the WS connection after upstream acceptance, assert no duplicate
   submission, and reconcile the exact run with partial evidence when needed.
7. Exercise OpenClaw approval requested/resolved, deny, and timeout with
   explicit approval scope and without steady-state administrator scope.
8. Start a long Chat run, press Stop, and assert the frame is exactly
   `chat.abort {sessionKey, runId}`, never a global session close; separately
   prove the selected Issue cancellation method.
9. Assert immutable visible output and terminal evidence, then restart/reconnect
   and prove the paired device identity remains usable.
10. Restart Rudder while Stop is `requested` or `acknowledged`; prove the leased
   action re-registers control for the same attempt/run, never targets a newer
   attempt, and ends in the provider terminal state or honest `control_lost` /
   `cancel_unverified` evidence.

Hermes Agent `0.19.1`:

1. Prepare a clean, authenticated API Server with a strong test bearer key, then
   create an Agent in `rudder_managed_local` mode and use the visible `Start
   and connect` action. Assert the versioned launch-contract digest,
   child-environment allowlist, process identity/start epoch, and redacted
   diagnostics are persisted. Repeat with a pre-started loopback server in
   `attach_existing_local` mode and prove an unproven attachment is blocked.
2. Use a dedicated loopback workspace path different from the Rudder checkout,
   and verify the distinction
   between operator labels, endpoint host, and server execution mode. Assert
   that managed mode is ready only after Rudder's launch binding, while attach
   mode is blocked without independent process/CWD or selector proof.
3. Complete an assigned Issue and one Chat turn through the Runs API.
4. Route the same Agent through a reviewer workflow and exercise reviewer
   assignment, `approve`, `request_changes`, and blocked/unauthorized decisions
   through the visible UI with persisted Run/result evidence.
5. Continue each workstream and inspect the outbound Runs request to prove it
   contains the bounded `RUDDER_TOOL_CONTEXT_V1` projection derived from the
   canonical Rudder transcript; assert that reusing only `session_id` fails the
   continuity assertion. Verify the source hash, projection digest, redaction,
   and causal pairing metadata.
6. Exercise a permitted tool, structured result, and governed approval
   request; prove the continuation mode remains `synthetic_tool_continuity`
   without a session reset. The visible approval UI exposes only `once` and
   `deny`; payloads containing `session`, `always`, `all`, or `resolve_all` are
   rejected and never sent upstream.
7. Submit a Run whose `202` response is lost; assert Rudder does not retry and
   records `submission_indeterminate` when no provider run ID is recoverable.
8. Send two identical SSE deltas and preserve both; then disconnect, handle the
   expected resubscribe `404`, reconcile terminal status, and mark the gap
   `partial`.
9. Press Stop, assert `stopping` is not terminal, then test duplicate Stop,
   stop-after-complete, provider `404`, status expiry, final `cancelled`, and
   honest `cancel_unverified` paths. Restart Rudder after the upstream
   `stopping` acknowledgement and prove the leased action resumes against the
   same provider run without duplicate execution or premature cancellation.
10. Simulate a compression/rotation mismatch that exposes no effective session
   ID; prove Rudder refuses to guess or replace the mapping, records
   `runtime_session_rotation_unverifiable`, and requires an explicit reset.
11. Emit secret-shaped tool, approval, error, and SSE payloads and prove only
    redacted forms persist.
12. Restart the Hermes server and prove the mapped session remains correlation
    evidence while the Rudder canonical transcript remains authoritative.
13. Build projections at each configured event/byte/token bound and above it.
    Prove the at-limit projection is accepted atomically and the over-limit,
    unsafe, or unredactable projection fails before submission without
    persisting or sending a truncated prefix.

Legacy Hermes migration:

1. Open an existing `hermes_local` Agent and assert the visible `Legacy` label,
   unchanged CLI configuration, and intact historical Runs.
2. Start the migration flow, validate a new `hermes_gateway` connection, and
   atomically switch only after the test succeeds; assert historical Runs stay
   attached to the Agent and any continuity reset is explicit.
3. Repeat with an unreachable or incompatible API Server and assert the Agent
   remains `hermes_local`, its configuration is unchanged, and no provider
   session is claimed as resumed.

Failure-shaped UI coverage includes incompatible OpenClaw protocol, pairing
required, missing OpenClaw scope, unsafe remote plaintext, unreachable
endpoint, Hermes auth failure, missing Hermes capability, unsafe endpoint,
missing session, denied/expired approval, unsupported `session` / `always` /
`all` / `resolve_all` approval expansion, SSE expiry, projection overflow,
unproven attached workspace, and
Stop timeout. Both managed and attached lifecycle modes are covered, including
the single-owner rule and the blocked `runtime_workspace_unverified` state.
An organization-boundary E2E creates a second organization and proves the same
OpenClaw or Hermes endpoint/credential tuple cannot be attached, queried,
approved, stopped, or session-addressed across that boundary.

The E2E must inspect visible UI state and persisted Run/result evidence. Mock
protocol tests do not satisfy acceptance.

### Repository gates

- focused adapter, server, shared, and UI suites;
- `pnpm product-logic:check`;
- `pnpm lint`;
- `pnpm -r typecheck`;
- `pnpm test:run`;
- `pnpm build`;
- after the planned `tests/e2e/openclaw-hermes-runtime-compatibility.spec.ts`
  and `scripts/compatibility/openclaw-hermes-matrix.mjs` artifacts are created:
  `pnpm test:e2e -- tests/e2e/openclaw-hermes-runtime-compatibility.spec.ts`,
  `node scripts/compatibility/openclaw-hermes-matrix.mjs --channel=stable`,
  and scheduled `--channel=drift` / `--channel=prerelease-filter` jobs;
- rendered browser verification and screenshots for all changed setup, status,
  approval, migration, and Stop states.

These compatibility paths and fixtures are proposal deliverables, not claims
that the current repository already contains runnable feature tests. The
implementation is not Review Ready until Slice 1 creates them and the commands
pass against the locked stock runtimes.

## Compatibility Policy And Operations

Every released Rudder build publishes a tested compatibility matrix with exact
upstream versions, transport/protocol, test date, and known limitations.

The release gate locks current stable and, when retained, one previous-supported
stable release. Both must pass deterministic protocol tests and real black-box
E2E. A scheduled drift job resolves the newest non-prerelease stable channel,
explicitly excluding beta, RC, dev, and upstream `main`, then runs the same
suite. Channel-filter tests prove a newer prerelease cannot become `Supported`
or replace the release-gate target. Failure opens or updates one maintenance
issue and changes the
dashboard state to `Unverified` for versions not in the released matrix; it does
not silently expand or revoke compatibility for already-tested versions.

Per-Run metrics may include version, readiness code, handshake duration,
continuation success, session reset, approval duration, Stop acknowledgement
and terminal latency, fallback rate, and evidence completeness. Metrics exclude
prompt content, transcript text, credentials, and local paths.

## Product Logic Alignment

The user-authorized Product Logic update is already synchronized in
`5fb9c771c` and this PRD is constrained by those contracts:

- `AGENT.RUNTIME.ADAPTERS.001`: loopback-only external readiness,
  `rudder_managed_local` / `attach_existing_local` lifecycle ownership,
  capability snapshots, honest Stop/Steer projection, `openclaw_gateway`,
  `hermes_gateway`, and Legacy `hermes_local` semantics.
- `AGENT.IDENTITY.CONFIG.001`: secret-reference storage, organization trust
  domains, process/start-epoch ownership, workspace binding, and
  organization/Agent/workstream provider mappings.
- `RUN.EXECUTION.001`: supported version/capability evidence, provider attempt
  identity, idempotency or explicit indeterminate submission, workspace binding,
  canonical Hermes transcript, and bounded `RUDDER_TOOL_CONTEXT_V1`
  `synthetic_tool_continuity` projection. The projection is atomic and records
  its version, source transcript hash, final sanitized digest, causal tool /
  approval pairs, ordered inclusion/omission ranges, redaction/compaction
  metadata, and the 200-event, 64 KiB/event, 512 KiB aggregate, and 32,000-token
  bounds.
- `RUN.RESULT.001`: normalized upstream runtime/version, transport, session,
  approval, cancellation, continuity metadata, and evidence completeness.
- `RUN.CHAT.AGENT.001`: provider-native run-scoped cancellation when advertised,
  V1 Hermes `once` / `deny` approval handling, and immutable visible-output
  cutoff with terminal reconciliation.
- `AGENT.SKILLS.001`: provider-native skills/tools/memory remain active on the
  upstream host but unmanaged and separate from Rudder's skill projection.

Implementation must remain aligned with these synchronized contracts; any
future semantic change requires a new explicit Product Logic authorization.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Fast upstream release cadence breaks an adapter between Rudder releases. | Locked compatibility matrix, capability discovery, scheduled stock-runtime E2E, and `Unverified` state for unknown versions. |
| A Hermes API endpoint grants remote tool execution. | Strong bearer secret, TLS/loopback rules, SSRF and DNS-rebinding controls, no redirects by default, and visible execution host/workspace. |
| One full-control upstream credential is reused across Rudder organizations. | Bind each endpoint/credential tuple to one organization trust domain and reject cross-organization reuse. |
| The upstream workspace differs from Rudder's assumed checkout. | Never send Rudder-local paths; require managed launch binding or independent attached process/CWD or provider-selector proof, and block unproven attachments. |
| A lost Hermes Run-creation response causes duplicate side effects. | Do not auto-retry an unknown submission; record `submission_indeterminate` until upstream adds proven idempotency. |
| SSE disconnect loses intermediate Hermes events. | Persist accepted events, reconcile terminal status/output, mark gaps `partial`, and do not claim lossless replay. |
| Stop acknowledgement is confused with terminal cancellation. | Separate `stopping`, `cancelled`, timeout, and fallback evidence; freeze visible output first. |
| Existing Hermes Agents are silently broken by transport replacement. | New `hermes_gateway` ID, Legacy label, explicit tested migration, atomic switch, and no automatic conversion. |
| Provider sessions leak across Agents or organizations. | Workstream-scoped mappings, organization/Agent keys, opaque session-key derivation, and isolation E2E. |
| Hermes Runs flatten prior structured tool messages. | Preserve the canonical Rudder transcript and use bounded, redacted `RUDDER_TOOL_CONTEXT_V1` synthetic projection with causal pairing; fail closed on unsafe or over-budget projection without labeling it native or lossless. |
| OpenClaw schema distribution remains unstable. | Lock schemas to an exact stable tag/SHA and license; avoid floating prerelease packages. |

## Decisions Deferred Beyond V1

- Cross-host or remote Hermes/OpenClaw connectors, relays, and deployment-aware
  egress beyond V1 loopback-only connections.
- Verified Hermes workspace selection/identity/probing when upstream publishes a
  deterministic control-plane contract.
- Hermes Runs session-rotation continuity when upstream returns a versioned,
  effective replacement session ID.
- Native or lossless Hermes history replay when upstream publishes a versioned
  representation contract; V1 synthetic projection remains the only supported
  continuity mode.
- Native Hermes mid-turn Steer if a versioned API contract emerges.
- First-class remote Agent-initiated Rudder API/MCP credentials.
- OpenClaw or Hermes skill synchronization and memory import.
- Jobs, cron, channel, voice, plugin, and upstream subagent management.

## Source Snapshot

External facts were checked on 2026-08-03 against primary release, protocol,
and implementation sources:

The locked stable source commits were OpenClaw
`2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4` and Hermes
`cc4cab2f592e60a197e796506de9168f74baf3ea`. Forward-looking OpenClaw
timestamp evidence is isolated to unreleased commit
`d02101d7ceb6a8e9d34c5674479c1abaa467f7ed` and is not a support claim.

1. [OpenClaw v2026.7.1 release](https://github.com/openclaw/openclaw/releases/tag/v2026.7.1)
2. [OpenClaw gateway protocol version constants](https://github.com/openclaw/openclaw/blob/v2026.7.1/packages/gateway-protocol/src/version.ts)
3. [OpenClaw Gateway protocol](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/gateway/protocol.md)
4. [OpenClaw Agent request schema](https://github.com/openclaw/openclaw/blob/v2026.7.1/packages/gateway-protocol/src/schema/agent.ts)
5. [OpenClaw stable reference client](https://github.com/openclaw/openclaw/blob/v2026.7.1/packages/gateway-client/src/client.ts)
6. [OpenClaw unreleased client snapshot at the locked forward commit](https://github.com/openclaw/openclaw/blob/d02101d7ceb6a8e9d34c5674479c1abaa467f7ed/packages/gateway-client/src/client.ts)
7. [OpenClaw stable Chat schemas](https://github.com/openclaw/openclaw/blob/v2026.7.1/packages/gateway-protocol/src/schema/logs-chat.ts)
8. [OpenClaw stable operator scopes](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/gateway/operator-scopes.md)
9. [Hermes Agent v0.19.1 release](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.7.30)
10. [Hermes v0.19.1 project metadata](https://github.com/NousResearch/hermes-agent/blob/v2026.7.30/pyproject.toml)
11. [Hermes API Server implementation](https://github.com/NousResearch/hermes-agent/blob/v2026.7.30/gateway/platforms/api_server.py)
12. [hermes-paperclip-adapter npm metadata](https://registry.npmjs.org/hermes-paperclip-adapter)

Repository evidence is anchored in the `related_code` paths, the current
runtime registries and UI pickers, and the current
`AGENT.RUNTIME.ADAPTERS.001`, `AGENT.IDENTITY.CONFIG.001`,
`RUN.EXECUTION.001`, `RUN.RESULT.001`, `RUN.CHAT.AGENT.001`, and
`AGENT.SKILLS.001` contracts.
