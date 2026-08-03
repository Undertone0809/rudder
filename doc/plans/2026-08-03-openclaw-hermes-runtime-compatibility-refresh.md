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
commit_refs: []
updated_at: 2026-08-03
---

# OpenClaw and Hermes Runtime Compatibility Refresh

## Executive Decision

Rudder should restore current, first-class support for users who already run
OpenClaw or Hermes, using each upstream project's current control plane rather
than treating both products as local command-line tools.

| Runtime | Product decision | Compatibility decision |
| --- | --- | --- |
| OpenClaw | Keep `openclaw_gateway` and upgrade the first-party adapter. | Support the current Gateway protocol, including protocol v4 handshake semantics, capability validation, device pairing, and run-scoped native cancellation. |
| Hermes | Add `hermes_gateway` as the primary Hermes integration and make it a first-class local runtime after the acceptance matrix passes. | Use capability discovery, Runs, SSE events, approvals, Stop, and Sessions APIs. Rudder owns a canonical rich workstream transcript and projects tool-bearing history through the versioned `RUDDER_TOOL_CONTEXT_V1` envelope when the upstream Runs API accepts only text. Do not make ACP or CLI output parsing the primary integration. |
| Legacy Hermes | Keep `hermes_local` temporarily and label it `Legacy`. | Freeze its current configuration semantics. Do not silently reinterpret a CLI-backed Agent as an API Server connection. |

The V1 user promise is deliberately focused: after adding a locally installed
OpenClaw or Hermes Agent to an organization, a user can assign it an Issue,
select it as an Issue reviewer, or start a direct Chat without learning a
second workspace or session model. Each path supports multi-turn work including
ordinary tool calls, approval decisions, Stop, and normalized evidence.

Rudder supports two local ownership modes. `rudder_managed_local` starts and
supervises an already-installed supported runtime in the resolved Rudder
workspace. `attach_existing_local` detects and connects to an already-running
loopback runtime without upgrading or taking ownership of it. Setup first
auto-detects an existing compatible runtime, then offers a one-action local
start when a supported executable is installed. Rudder does not install or
upgrade upstream software in V1, and it does not import provider credentials,
skills, memory databases, or existing historical conversations.
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

"I already use OpenClaw. Find it locally, pair Rudder as a least-privilege
client, and let me assign work or chat without hand-editing runtime config."

### Existing Hermes operator

"I already use Hermes with my models and tools. Connect it locally, place new
Rudder work in the right workspace, and preserve tool context across turns
without copying my provider keys."

### Reviewer or administrator

"Show me which external runtime and version did the work, which upstream session
continued, which approvals and tools were involved, whether evidence is
complete, and whether Stop reached a real terminal state."

## Goals

- Make OpenClaw and Hermes selectable from every standard Agent creation path.
- Auto-detect compatible loopback runtimes and start an installed runtime from
  Rudder with one action when managed startup is supported.
- Detect compatibility through an authenticated protocol handshake, not only
  executable, port, or version-string checks.
- Support Issue assignee, Issue reviewer, and direct Chat workflows.
- Preserve per-workstream multi-turn continuity after ordinary tool and approval
  events. OpenClaw uses mapped provider sessions; Hermes uses a Rudder-owned
  canonical transcript and a versioned synthetic projection when native history
  cannot represent the required records.
- Resolve a first-class execution workspace without creating a separate Library
  mental model or requiring routine path attestation.
- Map provider-native approvals and Stop into Rudder's durable control model.
- Normalize runtime identity, lifecycle, transcript, usage, and error evidence.
- Preserve organization boundaries and prevent credential leakage or unsafe
  endpoint access.
- Continuously test current upstream stable releases before claiming support.

## Non-Goals

- Automatic installation or upgrade of OpenClaw or Hermes.
- Managing model-provider subscriptions or importing provider credentials.
- Mirroring upstream skills, memory stores, jobs, cron, channels, plugins,
  subagents, or existing historical conversations into Rudder.
- ACP-based Hermes hosting, CLI stdout scraping, or a new generic arbitrary
  process adapter as the primary Hermes path.
- Rudder-hosted execution of tools that the external runtime advertises as
  server-side execution.
- Support promises for unreleased upstream `main`, beta, or release-candidate
  builds.
- Automatic migration of existing `hermes_local` Agents.
- LAN, public Internet, or cross-host runtime connections. V1 accepts loopback
  or an equivalent local IPC transport only.
- Upstream jobs, cron, channels, voice, plugin, subagent, or administration
  parity beyond Issue assignee, Issue reviewer, and direct Chat workflows.

## Success Criteria

The feature is ready when all of the following are true:

- A user can create and test OpenClaw and Hermes Agents from every standard New
  Agent surface without editing raw adapter JSON.
- Preflight distinguishes ready, unreachable, authentication required, pairing
  required, permission/scope required, incompatible protocol, unsupported
  version, and unverified version states.
- Stock OpenClaw `v2026.7.1` and stock Hermes Agent `0.19.1` each complete an
  assigned Issue, an Issue review, and a direct multi-turn Chat through the real
  UI and backend.
- A later turn in the same Issue workstream or Chat conversation correctly uses
  a prior tool result without unnecessary tool re-execution. OpenClaw reuses its
  mapped provider session. Hermes sends a bounded projection of Rudder's
  canonical rich transcript, including `RUDDER_TOOL_CONTEXT_V1` records, and
  labels the evidence `synthetic_tool_continuity` rather than native or
  lossless continuity.
- A reviewer Run produces a durable `approve`, `request_changes`, or `blocked`
  decision with the same runtime, transcript, tool, approval, and result
  evidence expected from built-in Agents.
- Stop freezes Rudder-visible output, calls the exact upstream run/session
  cancellation endpoint, and records the verified terminal outcome.
- Hermes approval requests can be resolved through Rudder without using
  `--yolo`; unsupported approval states fail closed.
- Hermes approval UI exposes only `once` and `deny` in V1. `session` and
  `always` grants require a separately named, audited runtime-policy change
  with explicit authorization; they are not ordinary approval decisions.
- Run evidence identifies the adapter version, upstream version, negotiated
  protocol/capabilities, upstream run/session, terminal state, and evidence
  completeness without exposing secrets.
- Existing `openclaw_gateway` Agents remain compatible or enter an actionable
  upgrade/pairing state. Existing `hermes_local` Agents remain explicitly
  Legacy until an operator migrates them.
- Agent setup auto-detects an already-running loopback runtime, or offers a
  one-action managed start when the executable is installed. Missing installs
  and unsupported process ownership produce actionable setup, not raw JSON.
- Managed Issue, reviewer, and Chat Runs start in the resolved Rudder workspace.
  Attached runtimes must prove the selected binding or offer a one-action
  managed restart before workspace-dependent work proceeds.
- LAN and public endpoints fail consistently with
  `runtime_endpoint_nonlocal` in both preflight and execution.
- Latest and previous-supported upstream releases run in a scheduled
  compatibility matrix; an untested new release is labeled `Unverified`, not
  automatically `Supported`.

Initial operational targets after release are:

- at least 90% of users with a supported local installation complete setup
  without manual JSON editing or terminal process startup;
- at least 95% of accepted Stop requests reach a verified upstream terminal
  state within 3 seconds on a healthy local connection;
- at least 95% of eligible second-turn acceptance runs retain the expected
  provider session or complete bounded synthetic Hermes context;
- zero runtime secrets in API responses, transcripts, activity payloads, or
  persisted diagnostic logs.

## Common Product Requirements

### C1. External runtime connection record

Both integrations use a normalized, organization-scoped connection model:

- runtime type and adapter version;
- transport, loopback endpoint, and local ownership mode;
- managed-process identity and lifecycle state when Rudder owns the process;
- secret reference, never a plaintext secret in general config JSON;
- last capability snapshot, upstream version, protocol version, and test time;
- readiness status and machine-readable remediation code;
- endpoint host, server-reported execution mode when exposed (otherwise an
  explicit `Not exposed` value), operator-supplied host label,
  verified instance identity when available, provider workspace identity when
  exposed, and a separate Rudder-owned launch/workspace binding with its
  verification status.

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

### C3. First-class local workspace resolution

OpenClaw and Hermes use the same workspace policy as other Rudder Agents. For
Issue assignee and reviewer work, Rudder resolves the Issue/project workspace,
then the organization workspace, then agent home. For direct Chat, an explicitly
selected project workspace wins; otherwise Rudder uses the organization
workspace and falls back to agent home. Agent home stores provider/runtime state
and is not presented as a second project workspace. Library remains the
organization's context and artifact surface; it is not an execution cwd.

In `rudder_managed_local`, Rudder creates or verifies the normal run workspace,
starts the installed runtime with that resolved cwd or provider workspace
selector, and stores a binding fingerprint on the Run. This is the default for
workspace-dependent Issue and reviewer work because Rudder controls the binding
without asking the user to understand provider-specific cwd behavior.

A managed runtime instance is keyed by organization, Agent, provider, and
workspace binding. Rudder never reuses a cwd-bound process for another
workspace merely because its port is reachable. Workstreams pin the instance
identity used for their Runs. When the selected workspace changes, Rudder
creates or rebinds a compatible managed instance and records the transition;
when the provider cannot isolate concurrent workstreams, the kernel serializes
them instead of mixing cwd or session state.

Each managed process identity and start epoch has exactly one lifecycle owner.
Additional Agents may attach to a shared reachable gateway, but attach records
cannot stop, restart, or rebind the managed owner. A second managed claim for
the same process identity is rejected.

In `attach_existing_local`, Rudder may mark the binding ready only when it can
prove that the attached process will execute in the selected workspace through
one of these deterministic paths:

- a versioned provider workspace selector plus bounded access probe;
- a Rudder-created process identity whose startup cwd is still verifiable; or
- a local OS process inspection path supported by the current platform and
  matched to the authenticated runtime instance.

A model response is never workspace proof. If the attached process cannot prove
the binding, workspace-dependent Issue/reviewer work fails preflight with
`runtime_workspace_binding_required`. The primary remediation is one action to
restart the installed runtime under `rudder_managed_local` in the already
resolved workspace; the user is not asked to create a Library directory or
manually attest an opaque path. Direct Chat may proceed only when its declared
capabilities do not require filesystem workspace access; tool-enabled Chat uses
the same verified binding rule.

Hermes capability discovery reports where provider tools execute when the
upstream exposes that fact, but it does not attest `terminal.cwd`. Attached
Hermes therefore remains unknown/blocked for workspace-dependent work until
Rudder has independent process/CWD or provider-selector evidence. Managed
launches may pass from Rudder-owned process and CWD evidence.

An attached instance is eligible only for its proven workspace unless the
locked provider contract supports a deterministic per-Run workspace selector.
Attaching one process must never silently make every project workspace appear
available.

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
- `runtime_endpoint_nonlocal`
- `runtime_installation_missing`
- `runtime_start_failed`
- `runtime_workspace_binding_required`
- `runtime_trust_domain_conflict`

Preflight and execution apply the same endpoint and workspace checks. A prior
successful test cannot make a now-nonlocal endpoint or stale process binding
ready.

Preflight must perform the cheapest authenticated handshake that proves the
same path used for execution. A present executable, open port, unauthenticated
health endpoint, or parsable version string cannot produce `pass` by itself.

### C5. Honest capability projection

The registry and UI expose only capabilities proven for the tested connection:

- Issue assignee, Issue reviewer, and direct Chat execution;
- local ownership mode, managed start/stop, and workspace binding;
- session create and continuation;
- structured or normalized transcript events;
- approval response support;
- Stop type: provider-native, managed-process fallback, or unavailable;
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

For Hermes, the provider session is correlation evidence rather than the sole
continuity authority. The Rudder workstream transcript is authoritative and may
continue across a provider-session rebound when the same organization, Agent,
workstream, workspace binding, and transcript hash are proven. Such a rebound
is explicit evidence and cannot join unrelated provider history.

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
- continuity mode (`native_session` or `synthetic_tool_continuity`), transcript
  projection version, source hash, bounds, redaction, and compaction metadata;
- `complete`, `partial`, or `terminal_only` event-evidence completeness.

Human stdout/stderr is diagnostic evidence only. It must not be the primary
session, result, or usage parser for the new Hermes path.

All provider frames, tool arguments/results, approval payloads, errors, and
diagnostics pass through redaction before persistence. Raw unredacted SSE or
WebSocket frames may exist only in bounded in-memory processing and must not be
written to Run logs, transcripts, activity records, or failure artifacts.

### C9. Issue, reviewer, and Chat parity

An OpenClaw or Hermes Agent that passes preflight participates in the existing
Rudder work loop as a normal Agent for the three V1 surfaces:

- assigning an actionable Issue wakes and executes the Agent under the existing
  assignment, checkout, organization, and workspace rules;
- selecting it as reviewer routes reviewable Issue state to that Agent, and the
  Run must persist one normalized `approve`, `request_changes`, or `blocked`
  decision plus review evidence before the workflow advances;
- direct Chat creates a first-class Chat Run with the normal queue, Stop,
  approval, transcript, result, and conversation attribution behavior.

Runtime type does not bypass existing permission, lease, review, or activity
contracts. Unsupported upstream features outside these surfaces are hidden or
disabled rather than exposed as controls that fail after selection.

Rudder supplies a scene-specific work manifest containing the organization,
Agent role, Issue/review identity, resolved workspace, bounded context, and the
allowed completion actions. Because a persistent external API Server must not
receive a broad board credential, V1 accepts server-mediated completion intents
from the adapter result and applies them only after revalidating organization,
current assignee/reviewer relationship, Issue state, execution lease, and
required comment evidence. A stale reviewer result or reassignment fails
closed; free-form prose alone never becomes an approval or Issue mutation.

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

### O6. Local discovery and lifecycle

OpenClaw follows the common two-mode local lifecycle. Rudder scans supported
loopback Gateway endpoints and installed executable paths. An attached Gateway
remains externally owned and is never stopped or upgraded by Rudder. When no
compatible Gateway is ready and the installed OpenClaw version exposes a locked
supported Gateway launch contract, `Start and connect` creates a managed
organization/Agent/workspace-bound instance and persists its process identity.

Managed restart preserves the Rudder device identity and secret references but
repeats authenticated handshake, capability, and workspace-binding validation.
Rudder stops only a process whose identity and start epoch match its ownership
record. A port collision or different process fails with an actionable state;
Rudder never terminates the listener merely to reclaim the port.

## Hermes Requirements

### H1. Add a first-party `hermes_gateway` adapter

Create a Rudder-owned Hermes API Server adapter and expose it through server,
shared, CLI, and UI registries. New Hermes Agents use `hermes_gateway`.

Keep `hermes_local` as a Legacy runtime during migration. Do not change its
configuration semantics in place and do not make new Agents depend on
`hermes-paperclip-adapter`. The external package may be removed only after the
legacy retirement policy and rollback window are complete.

### H2. Local discovery and lifecycle

Hermes setup scans supported loopback endpoints and validates the executable
when local process discovery is available. The default flow is:

1. attach to an authenticated, compatible API Server whose workspace binding
   can be proven;
2. otherwise, when a supported Hermes executable is installed, offer one action
   to start it under `rudder_managed_local` in the resolved Rudder workspace;
3. otherwise, show an actionable installation requirement and keep the Agent
   unready.

Managed mode owns only the process it starts. It records executable identity,
upstream version, process ID/start epoch, bound workspace fingerprint, endpoint,
and sanitized launch status. Rudder may stop or restart that process for Agent
configuration, app shutdown, workspace rebinding, or recovery, but it never
upgrades Hermes or terminates an unrelated process discovered on the same port.

Attach mode records that Rudder does not own lifecycle. If the attached process
is incompatible, disappears, or cannot prove its workspace binding, Rudder
offers managed restart when possible rather than asking for raw JSON or a
manual workspace attestation. Advanced users may enter a loopback URL and
secret reference explicitly; nonlocal URLs remain invalid in V1.

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

### H4. Runs and tool-bearing multi-turn continuity

Rudder creates one canonical transcript per Hermes workstream. It preserves the
ordered user, assistant, reasoning, tool-call, tool-result, approval, and
lifecycle evidence accepted from Rudder and Hermes. The transcript, not Hermes
SessionDB, is the continuity authority for Rudder-originated work. A mapped
Hermes session remains useful for correlation and upstream long-term memory,
but reusing `session_id` alone never counts as continuity.

Stock Hermes `0.19.1` reduces Runs `conversation_history` to `role` and string
`content`. Before each later Run, Rudder deterministically projects the bounded
canonical transcript into that representation. Plain user/assistant text stays
plain. Tool and approval records are rendered into a versioned
`RUDDER_TOOL_CONTEXT_V1` envelope containing:

- event ordinal and stable source-event ID;
- tool name, canonicalized arguments, status, and canonicalized result;
- approval request, allowed choices, selected decision, and actor class;
- source hashes plus redaction, omission, and deterministic compaction metadata;
- an explicit untrusted-data label for provider/tool content.

Envelope delimiters and control characters are escaped before projection. Tool
arguments/results are treated as untrusted quoted evidence, never as system or
developer instructions. Secrets and disallowed fields are redacted before both
persistence and projection. The projection version, full source transcript
hash, final sanitized projection digest, immutable source-event versions,
ordered inclusion/omission ranges, and compaction outputs are recorded on the
Run so later evidence can prove exactly what context was supplied without
persisting unredacted provider payloads.

This mode is named `synthetic_tool_continuity`. The UI must not label it native
or lossless Hermes history. It is nevertheless the default supported Hermes
multi-turn behavior: the presence of a tool call, tool result, structured
content, or approval does not force a reset and does not make the workstream
non-continuable.

The default bounds are 200 projected events, 64 KiB UTF-8 per event, 512 KiB
UTF-8 aggregate, and a conservative 32,000-token estimated history budget.
Within those bounds, Rudder includes all causally required tool/approval pairs
and the latest conversation needed by the workstream. Deterministic compaction
may replace older assistant prose or oversized tool payloads with a hash-linked
summary, but it may not orphan a tool result, approval decision, or referenced
artifact. The Run records every compacted/omitted source range. If required
context cannot fit safely, redaction cannot complete, or transcript integrity
fails, preflight blocks with `runtime_session_history_too_large`,
`runtime_session_history_unsafe`, or `runtime_session_history_corrupt`. Rudder
never silently drops the history and never converts an ordinary tool event into
a reset requirement.

Existing Hermes historical sessions are not imported or synchronized in V1.
New Rudder workstreams start with a new Rudder transcript and a mapped provider
session. Rudder appends every accepted turn and normalized runtime event to its
own transcript and does not claim the Runs API updated Hermes SessionDB.

Rudder passes the mapped provider session through `/v1/runs.session_id` for
correlation and uses `X-Hermes-Session-Key` only as a stable, unguessable
long-term memory scope. The key must not expose raw organization, user, Agent,
Chat, or Issue identifiers. It is derived through a keyed, versioned mapping.
The provider Run ID is persisted on the Rudder attempt.

The Runs API does not provide a proven idempotency key. Rudder therefore never
automatically retries a submission when the HTTP outcome is unknown. If it
receives a provider Run ID, it reconciles that Run. If the request may have been
accepted but no ID is recoverable, the attempt becomes
`submission_indeterminate`; no second upstream Run starts without explicit
recovery.

If a provider session disappears or rotates without an effective replacement,
Rudder may create a new correlation session only after proving the same
organization, Agent, workstream, workspace binding, and canonical transcript
hash. It records `provider_session_rebound`; synthetic transcript continuity
does not reset. It must never guess or join unrelated upstream history.

Rudder does not inject a short-lived Rudder JWT into a prompt or transcript.
Issue checkout, context delivery, result persistence, and review orchestration
remain on the Rudder server side. A future Hermes-initiated Rudder MCP/API mode
requires a separately configured least-privilege credential and product
contract.

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

Hermes approval events become durable Rudder approval actions. Rudder maps only
the choices supported by the discovered API, correlates them to the exact run,
and calls the run approval endpoint after authorization.

The old `--yolo` behavior is not carried forward. Auto-approval is allowed only
when an explicit Rudder/runtime policy already permits the action. Unknown,
expired, malformed, or unrenderable requests fail closed. Approval waits have a
bounded deadline and survive a Rudder UI refresh.

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

External runtime endpoints are code-execution control planes. V1 limits them to
the same local device as Rudder, and connection testing and execution use the
same endpoint policy.

- Secrets are stored by reference, redacted from logs, omitted from read APIs,
  and never copied into transcripts or activity payloads.
- OpenClaw accepts only a loopback WebSocket endpoint; Hermes accepts only a
  loopback HTTP endpoint. An equivalent local IPC transport may be added when
  the upstream runtime supports it.
- Hostnames must resolve exclusively to loopback for every connection. Private
  LAN, link-local, metadata, public, userinfo-bearing, redirected, or
  protocol-downgraded destinations fail with `runtime_endpoint_nonlocal` or the
  more specific sanitized policy code.
- Both preflight and execution re-resolve and revalidate the destination. A
  stored preflight result cannot grandfather a changed address.
- Hermes connections require a non-empty strong bearer secret even if a future
  upstream build advertises optional auth.
- Runtime config, capability snapshots, session mappings, and mutations remain
  organization- and Agent-scoped. Mutations write activity evidence with actor
  and organization.
- An upstream endpoint/credential tuple is a single-organization trust domain;
  both preflight and execution reject cross-organization reuse.
- OpenClaw private keys/device tokens and Hermes bearer keys never share the
  Rudder Agent identity-token namespace.
- Managed processes receive an allowlisted launch environment containing only
  the resolved workspace, provider-specific config, and required generated
  secret references. They never inherit the Rudder server's database URL,
  identity secrets, unrelated provider keys, or unrestricted parent
  environment. Sanitized launch logs follow the same redaction boundary as Run
  evidence.
- Rudder never imports provider keys, upstream credential files, skills,
  memories, or unrestricted environment dumps.
- Local ownership mode, workspace binding, endpoint, managed-process state, and
  last tested time remain visible to the operator.

The normalized connection record must not assume that Rudder Server can always
dial the runtime directly. A future server/cloud phase may add a separately
authenticated outbound connector or relay, where the machine running OpenClaw
or Hermes initiates the connection to Rudder. That transport must preserve the
same organization binding, capability, workspace, control, and evidence model.
It is an architectural extension point, not part of V1 implementation or
acceptance.

## User Experience

### Create or reconnect OpenClaw

1. The user chooses `OpenClaw` in any New Agent surface.
2. Rudder scans supported loopback endpoints and installed executable paths.
   Advanced connection details remain behind disclosure.
3. If a compatible Gateway is already running, Rudder offers `Connect`. If its
   workspace binding cannot be proven, the primary action is `Restart in this
   workspace` under managed mode when supported.
4. If no Gateway is running but OpenClaw is installed, Rudder offers `Start and
   connect` in the already resolved workspace. A missing installation produces
   a concrete setup requirement.
5. Connection performs v4 negotiation and authenticated capability validation.
   If pairing is required, the UI shows the pending-device action and retest
   state; the user never edits key JSON.
6. Agent Detail displays upstream version, protocol, scopes, ownership mode,
   workspace binding, managed-process state, endpoint, and last tested time.
7. The Agent is immediately available in assignee, reviewer, and Chat pickers.
   Work streams into the normal Run view and later turns continue the mapped
   session.
8. Stop freezes visible output and aborts only the active upstream run.

### Create or reconnect Hermes

1. The user chooses `Hermes` in any New Agent surface.
2. Rudder auto-detects a compatible loopback API Server. If none is ready but a
   supported Hermes executable is installed, `Start and connect` launches it in
   the resolved workspace. Advanced users may disclose the loopback URL and
   secret-reference fields.
3. Connection authenticates, reads capabilities/endpoints, and verifies Runs,
   events, approvals, Stop, Sessions, and workspace binding support.
4. Missing installation, auth, unsupported version, nonlocal endpoint, missing
   feature, startup failure, or unbound workspace produces one actionable
   remediation state.
5. Agent Detail displays upstream version, ownership mode, workspace binding,
   managed-process state, continuity mode, endpoint, and last tested time.
6. The Agent is immediately available in assignee, reviewer, and Chat pickers.
   Each workstream owns a canonical Rudder transcript and mapped Hermes session.
7. Later turns include bounded prior text plus `RUDDER_TOOL_CONTEXT_V1` records.
   The UI labels this `Rudder-projected tool continuity`; ordinary tool or
   approval activity never asks the user to reset the conversation.
8. Approval requests appear as Rudder actions. Stop remains `Stopping` until
   the provider reports a terminal state. Any SSE gap is visible as partial
   evidence while final output/status are reconciled when possible.

### Migrate a Legacy Hermes Agent

1. Agent Detail labels `hermes_local` as `Legacy` and offers `Migrate to Hermes
   API`, without blocking existing history access.
2. Rudder runs the same local auto-detect or `Start and connect` flow used for a
   new Hermes Agent. Advanced loopback endpoint fields remain optional.
3. Rudder validates capabilities, local ownership, and workspace binding.
4. Only after a successful test may the user atomically switch the Agent to
   `hermes_gateway`. Historical Rudder Runs remain attached to the same Agent.
5. New work starts with a new canonical Rudder transcript and mapped provider
   session. Historical Rudder Runs remain readable, but the UI never claims an
   old CLI session was resumed.

No automatic migration runs in the background. A failed test leaves the Agent
unchanged.

## Rollout Plan

### Slice 1: compatibility contract and harness

- Add normalized connection, capability, readiness, and evidence-completeness
  types.
- Add local ownership, managed-process, workspace-binding, and future connector
  transport fields without implementing a remote connector.
- Add the runtime-kernel cancellation-intent/control-handle lifecycle needed to
  reconcile provider terminal state before marking an active Run cancelled.
- Add loopback-only endpoint validation and secret references.
- Create locked current/previous upstream fixtures and black-box harnesses.
- Capture failing baselines for OpenClaw v4 and legacy Hermes CLI behavior.

### Slice 2: OpenClaw recovery

- Implement the versioned v4 handshake and schema boundary.
- Add least-privilege pairing/token lifecycle, capability checks, idempotency,
  and run-scoped Stop.
- Add local discovery, managed start/supervision where supported, and verified
  workspace binding.
- Align all UI availability/onboarding surfaces.
- Replace the stale, device-auth-disabled stock default with current secure E2E.

### Slice 3: Hermes API Server integration

- Add the first-party `hermes_gateway` adapter.
- Implement capability discovery, Runs, SSE persistence/reconciliation,
  canonical rich workstream history, `RUDDER_TOOL_CONTEXT_V1` projection,
  approvals, Stop, and normalized results.
- Add local discovery, managed start/supervision, workspace binding, and the
  standard creation/detail UI.
- Add Issue assignee, Issue reviewer, and direct Chat workflow coverage.
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
  version missing/mismatch, Runs start/status/indeterminate submission, Sessions
  create/missing/rebound, duplicate SSE delta, disconnect/404 gap, terminal
  reconciliation, approval choices, duplicate and post-complete Stop, Stop
  acknowledgement versus terminal cancellation, and expired upstream state.
- `RUDDER_TOOL_CONTEXT_V1` canonical ordering, delimiter/control escaping,
  canonical argument/result encoding, approval projection, untrusted-data
  labeling, source hashes, redaction metadata, deterministic compaction,
  causally paired tool/result retention, size-budget refusal, corruption
  refusal, and prompt-injection containment.
- Local discovery and both ownership modes: attach does not kill or upgrade an
  existing process; managed mode starts/stops only its recorded process, binds
  the resolved cwd, detects stale process identity, and recovers actionable
  startup errors.
- Managed launch environment allowlisting, port-collision ownership checks, and
  proof that Rudder database/identity/unrelated provider secrets never reach the
  child process or sanitized launch logs.
- Project workspace, organization fallback, and agent-home fallback resolution;
  managed binding proof; attached provider/OS binding proof; and refusal with
  `runtime_workspace_binding_required` when tool work cannot prove the cwd.
- Loopback acceptance and LAN/link-local/metadata/public/redirect/rebinding
  rejection with `runtime_endpoint_nonlocal` in both preflight and execution.
- Secret redaction, organization isolation, same endpoint/secret
  cross-organization rejection, Agent session isolation, opaque Hermes
  session-key derivation, and secret-shaped provider events redacted before
  persistence and continuity projection.
- Legacy Hermes migration success, failure rollback, and visible session reset.
- Assignment, checkout, reviewer routing and decision normalization, shared Chat
  cutoff, late-output fencing, Issue result normalization, and evidence
  completeness for both adapters.
- Cancellation action-ID deduplication, outbox retry, attempt-epoch/control-
  version fencing, handle registration/unregistration, and restart recovery
  while Stop is `requested` or `acknowledged`.

### Required black-box E2E

Run against clean stock upstream releases, not only mocks. Managed discovery,
startup, ownership, restart, and workspace binding must run through a packaged
Desktop/local-production build; a browser connected to a mock or dev-only
process manager does not satisfy those lifecycle assertions.

OpenClaw current stable:

1. With the locked stock executable installed but stopped, create an Agent and
   use `Start and connect` through the visible Rudder UI. Pair with device
   authentication enabled and prove the managed process starts in the resolved
   project workspace.
2. Separately start stock OpenClaw outside Rudder, auto-detect it, attach without
   taking ownership, and prove disconnect/removal never terminates that process.
3. Assert through a WS frame proxy that Issue uses `agent`/`agent.wait`, while
   Chat uses `chat.history`/`chat.send` with the expected session ID and
   idempotency key.
4. Assign an Issue that reads/writes a marker in the project workspace; then
   continue it from a new Issue comment and prove the same workstream session
   uses the prior tool evidence. Then select the Agent as reviewer and persist a
   normalized review decision with durable Run evidence. Repeat with
   organization-workspace fallback.
5. Run a multi-turn direct Chat containing a tool call, then ask a follow-up
   that requires its result and assert the same mapped provider session is used.
6. Drop the WS connection after upstream acceptance, assert no duplicate
   submission, and reconcile the exact run with partial evidence when needed.
7. Exercise OpenClaw approval requested/resolved, deny, and timeout with
   explicit approval scope and without steady-state administrator scope.
8. Start a long Chat run, press Stop, and assert the frame is exactly
   `chat.abort {sessionKey, runId}`, never a global session close; separately
   prove the selected Issue cancellation method.
9. Assert immutable visible output and terminal evidence, then restart/reconnect
   and prove paired identity, managed-process ownership, and workspace binding
   remain valid.
10. Restart Rudder while Stop is `requested` or `acknowledged`; prove the leased
   action re-registers control for the same attempt/run, never targets a newer
   attempt, and ends in the provider terminal state or honest `control_lost` /
   `cancel_unverified` evidence.

Hermes Agent `0.19.1`:

1. With the locked stock executable installed but stopped, create an Agent and
   use `Start and connect`. Prove the authenticated API Server starts in the
   resolved project workspace with a strong generated bearer secret stored by
   reference.
2. Separately attach to an already-running loopback Server, prove Rudder does
   not own it, and verify an unprovable workspace binding blocks tool-enabled
   work until `Restart in this workspace` succeeds.
3. Assign an Issue that invokes a permitted tool and writes a marker. Continue
   the workstream and ask a question whose answer requires the prior tool
   result. Inspect the outbound Runs request and prove it contains the matching
   `RUDDER_TOOL_CONTEXT_V1` record and does not re-execute the tool.
4. Select Hermes as reviewer for a reviewable Issue. Prove it reads the Issue
   evidence and records `approve`, `request_changes`, or `blocked` through the
   normal reviewer workflow.
5. Run a direct Chat with a tool plus governed approval, refresh the UI during
   approval, resolve it, and complete a later turn from the projected tool and
   approval context without a reset.
6. Feed delimiter-shaped, instruction-shaped, secret-shaped, duplicate, and
   oversized tool results. Prove escaping, untrusted-data labeling, redaction,
   deterministic compaction, and explicit over-budget refusal; no unsafe text
   is promoted to trusted instructions.
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
10. Remove or rotate the mapped provider session and prove a verified
    `provider_session_rebound` preserves the canonical transcript, while a
    mismatched organization/Agent/workspace/transcript hash refuses to join.
11. Restart the managed Hermes process and Rudder, then prove ownership,
    workspace binding, canonical transcript, and later-turn continuity recover.

Failure-shaped UI coverage includes missing installation, startup failure,
incompatible OpenClaw protocol, pairing required, missing OpenClaw scope,
nonlocal endpoint, unreachable endpoint, Hermes auth failure, missing Hermes
capability, unbound workspace, denied/expired approval, unsafe/oversized
continuity projection, SSE expiry, and Stop timeout.
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
- `pnpm desktop:verify` for managed local lifecycle and packaged boot;
- relevant `pnpm test:e2e` targets and stock runtime jobs;
- rendered browser and packaged Desktop verification plus final screenshots for
  all changed setup, status, approval, migration, workspace, and Stop states.

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

## Proposed Product Logic Delta

The user explicitly authorized the corresponding guarded Product Logic Registry
update on 2026-08-03. This PRD remains a proposal and does not misstate these
behaviors as already implemented. Implementation must update the following
contracts before the feature is declared complete:

- `AGENT.RUNTIME.ADAPTERS.001`: define external runtime connection readiness,
  capability snapshots, honest Stop/Steer projection, `openclaw_gateway`, new
  `hermes_gateway`, and Legacy `hermes_local` semantics.
- `AGENT.IDENTITY.CONFIG.001`: define secret-reference storage, local ownership
  mode, normalized transport/connector-ready connection identity,
  single-organization upstream trust domains, and organization/Agent-scoped
  provider session mapping.
- `RUN.EXECUTION.001`: require supported upstream version/capability evidence,
  provider attempt identity, idempotency or explicit indeterminate submission,
  managed-process/workspace binding, and explicit Hermes canonical history plus
  versioned synthetic projection evidence.
- `RUN.RESULT.001`: normalize upstream runtime/version, transport, session,
  approval, cancellation, continuity mode/projection, and
  evidence-completeness fields.
- `RUN.CHAT.AGENT.001`: require provider-native run-scoped cancellation when
  advertised, preserve Rudder's immutable visible-output cutoff, and apply the
  same tool-bearing multi-turn contract to direct Chat.
- Existing `ROUTING.REVIEWER.001`, `REVIEW.DECISION.001`,
  `WORKSPACE.PROJECT.001`, and `WORKSPACE.RUN.001` contracts remain the
  governing routing, review, and workspace rules. This authorized Product Logic
  delta does not create a second contract for them: implementation must make a
  ready external Agent eligible through the existing reviewer flow, preserve
  normalized durable review outcomes, and apply the existing project,
  organization, and agent-home resolution order with deterministic binding.
  Acceptance must prove those behaviors; any gap is a separately approved
  Product Logic update rather than an implicit change in this slice.
- `AGENT.SKILLS.001`: clarify that V1 does not import or synchronize OpenClaw
  or Hermes skills merely because a runtime connection exists.

## Risks And Mitigations

| Risk | Mitigation |
| --- | --- |
| Fast upstream release cadence breaks an adapter between Rudder releases. | Locked compatibility matrix, capability discovery, scheduled stock-runtime E2E, and `Unverified` state for unknown versions. |
| A local Hermes API endpoint grants tool execution. | Loopback-only policy, strong bearer secret, no redirects, per-connect address validation, organization binding, and visible ownership/workspace state. |
| One full-control upstream credential is reused across Rudder organizations. | Bind each endpoint/credential tuple to one organization trust domain and reject cross-organization reuse. |
| An attached runtime executes outside Rudder's selected workspace. | Prefer managed start in the resolved workspace; require deterministic provider/process binding for attach mode; block workspace-dependent work when binding cannot be proved. |
| A lost Hermes Run-creation response causes duplicate side effects. | Do not auto-retry an unknown submission; record `submission_indeterminate` until upstream adds proven idempotency. |
| SSE disconnect loses intermediate Hermes events. | Persist accepted events, reconcile terminal status/output, mark gaps `partial`, and do not claim lossless replay. |
| Stop acknowledgement is confused with terminal cancellation. | Separate `stopping`, `cancelled`, timeout, and fallback evidence; freeze visible output first. |
| Existing Hermes Agents are silently broken by transport replacement. | New `hermes_gateway` ID, Legacy label, explicit tested migration, atomic switch, and no automatic conversion. |
| Provider sessions leak across Agents or organizations. | Workstream-scoped mappings, organization/Agent keys, opaque session-key derivation, and isolation E2E. |
| Hermes Runs flatten prior structured tool messages. | Keep a canonical Rudder transcript and project a hash-linked, escaped, redacted `RUDDER_TOOL_CONTEXT_V1` envelope; test later-turn use of prior tool results. |
| Tool output injects instructions through the synthetic envelope. | Treat all tool/provider payloads as untrusted quoted evidence, escape delimiters/control data, redact before projection, preserve hashes, and fail closed when safe projection is impossible. |
| OpenClaw schema distribution remains unstable. | Lock schemas to an exact stable tag/SHA and license; avoid floating prerelease packages. |

## Decisions Deferred Beyond V1

- Rudder-managed installation and upgrade of OpenClaw or Hermes. Managed start,
  supervision, restart, and stop of an already-installed supported runtime are
  in V1.
- A remote/server connection transport. The expected direction is an outbound,
  separately authenticated connector or relay from the Agent machine to Rudder,
  not a Rudder Server attempt to dial the user's `localhost`.
- Native Hermes tool-message continuation or lossless session rotation when
  upstream publishes a versioned representation/effective-session contract.
- Lossless Hermes continuation for tool-call, tool-result, or structured
  histories imported from pre-existing upstream sessions. V1 starts new
  Rudder-owned workstream transcripts.
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
