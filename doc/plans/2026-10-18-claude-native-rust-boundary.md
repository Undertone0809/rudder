---
title: Claude Code Native Rust Transport Boundary
date: 2026-10-18
kind: implementation
status: in_progress
updated_at: 2026-10-18
area: agent_runtimes
entities:
  - runtime_session
  - agent_run
  - chat_transcript
---

# Claude Code Native Rust Transport Boundary

This note records the first Rust-owned W06 slice for the installed Claude Code
runtime. It is intentionally an implementation boundary and does not claim
that Claude Code is wired into the shared Native Chat worker or that any CL-01
through CL-06 acceptance case passes.

## Calibrated installed contract

The local executable is Claude Code `2.1.216` (`claude --version`). The native
non-interactive stream uses:

```text
claude --print - --input-format stream-json --output-format stream-json --verbose
```

The first real input is a JSON-LF envelope with `type=user` and a user message
containing a text content block. The observed output starts with
`system/init`, includes assistant events, and ends with a `result` event. The
result carries the explicit `session_id`, `subtype`, `is_error`, summary, usage,
and optional `total_cost_usd`. The Rust parser keeps those identities distinct
from Rudder Run IDs.

Session selection is explicit:

- New sessions may use a generated or supplied `--session-id` UUID.
- Existing sessions use `--resume <session-id>`.
- A native branch uses `--resume <source-id> --fork-session` and can supply a
  new `--session-id`.
- Directory-level `--continue` and “latest session” selection are not exposed.

The process is launched through the Rust process host with interactive stdin,
bounded JSON-LF writes, owner-bound cleanup, and a bounded line decoder. A
provider `result` is an observation. A future shared-worker projector must
still verify the D1 execution fence, cleanup proof, terminal state, billing, and
reader projection before completing a Run.

## Rust ownership

`native/crates/claude-code` owns:

- explicit Session ID validation and invocation construction;
- stream-json user input framing and bounded output framing;
- typed `system/init`, assistant, result, user echo, unknown, and
  `control_request` observations;
- request-id-bound control responses and owned process Stop;
- a complete raw JSONL Reader for one explicitly authorized Session file,
  including unknown future event types;
- process-host cleanup proof access without accepting a caller-supplied proof.

The crate does not own D1 claims, Run/Attempt state, authorization, billing,
Side Chat persistence, or a second scheduler. It is not a mock provider and its
unit tests are protocol/identity tests; they do not stand in for a real
authenticated Claude turn.

## Remaining W06 work

The shared `native-chat-executor`/Foundation worker currently has Codex,
Hermes, and Pi dispatch branches only. Claude therefore remains an explicit
unsupported runtime at admission until a follow-up slice adds all of the
following in the owning worker/config scopes:

1. trusted Claude executable/profile resolution and managed HOME/config
   isolation without copying operator credentials;
2. a Claude observation envelope and D1 finalizer that preserves the native
   Session ID, result UUID, usage scope, controls, and exact Run span;
3. native Session JSONL path resolution and authorized bounded Reader wiring;
4. live permission/AskUserQuestion/interruption handling and a single owner for
   in-flight controls;
5. explicit resumption, pre-compaction raw history, Fork ID remapping,
   checkpoint/mirror behavior, and child-session recovery on a real
   authenticated installation;
6. independent real-environment acceptance for CL-01 through CL-06 on the same
   candidate SHA.

Until those pieces are complete, this slice must not enable `claude_local` in
Native Chat or be described as Claude runtime parity.

## W06 audit and safe follow-up slice

The 2026-10-18 audit found the installed executable at
`/Users/zeeland/.local/bin/claude` (Claude Code `2.1.216`). It is a trusted
local wrapper whose target is the installed Claude Code binary. No authenticated
prompt was sent during this audit, so the executable probe is not a provider
acceptance result.

The Claude-owned crate now also provides three fail-closed helpers:

- `ClaudeExecutable::resolve` canonicalizes a host-selected executable and
  rejects non-files or non-executable files; it never searches an HTTP- or
  Agent-provided PATH.
- `ClaudeRuntimeProfile` emits only the approved operator HOME and managed
  `CLAUDE_CONFIG_DIR` boundary. It does not copy or read credentials and
  rejects a managed home that aliases the operator home.
- `ClaudeControlLease` enforces one in-flight permission/question owner, and
  `ClaudeHistoryReader::path_for_cwd`/`read_for_cwd` deterministically resolves
  one explicit cwd and Session ID without scanning for a latest session.

These helpers remain transport boundaries. The W06 acceptance matrix is still
unmet and is recorded conservatively:

| Case | Current status | Evidence or blocker |
| --- | --- | --- |
| CL-01 explicit resumption | blocked | Explicit `--resume` is encoded, but no shared-worker/admission or restart acceptance exists. |
| CL-02 pre-compaction raw history | partial | Bounded explicit JSONL Reader and cwd resolver exist; authorized D1 projection is not wired. |
| CL-03 Fork IDs | partial | `--fork-session` and optional child ID are encoded; child mapping and old-ID fencing are not integrated. |
| CL-04 configuration and interaction | partial | Invocation/profile boundaries are typed; same-auth native-vs-Rudder parity and live controls are unverified. |
| CL-05 checkpoint | blocked | No Claude checkpoint or cloud mirror authority exists in the shared worker. |
| CL-06 mirror failure | blocked | No mirror/listSubkeys/child recovery implementation or real failure exercise exists. |

The shared executor still admits only Codex, Hermes, and Pi. Wiring this crate
into `native-chat-executor`, public admission, D1 finalization, retention, or
checkpoint/mirror state requires changes in shared worker and persistence
owners; that work must stay a follow-up and must not be inferred from these
transport tests.

## Verification evidence

The following checks passed on the candidate containing this note and crate:

```text
cargo fmt --manifest-path native/Cargo.toml --all --check
cargo check --manifest-path native/Cargo.toml -p rudder-claude-code
cargo clippy --manifest-path native/Cargo.toml -p rudder-claude-code --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml -p rudder-claude-code --lib -- --test-threads=1
```

Eight unit tests cover explicit resume/fork arguments, the installed 2.1.216
init/result shape, executable/profile isolation, single-owner control leases,
control request-id binding, deterministic cwd/session JSONL resolution, exact
Session JSONL identity and future event preservation, and bounded JSON-LF input.
They do not prove provider authentication, model success, complete native
controls, or shared Run finalization.
