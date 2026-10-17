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

## Verification evidence

The following checks passed on the candidate containing this note and crate:

```text
cargo fmt --manifest-path native/Cargo.toml --all --check
cargo check --manifest-path native/Cargo.toml -p rudder-claude-code
cargo clippy --manifest-path native/Cargo.toml -p rudder-claude-code --all-targets -- -D warnings
cargo test --manifest-path native/Cargo.toml -p rudder-claude-code --lib -- --test-threads=1
```

Five unit tests cover explicit resume/fork arguments, the installed 2.1.216
init/result shape, control request-id binding, exact Session JSONL identity and
future event preservation, and bounded JSON-LF input. They do not prove
provider authentication, model success, complete native controls, or shared
Run finalization.
