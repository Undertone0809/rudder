---
title: OpenCode Native Server Rust Adapter Boundary
date: 2026-10-18
kind: implementation
status: in_progress
updated_at: 2026-10-18
area: agent_runtimes
entities:
  - runtime_session
  - chat_transcript
  - agent_run
---

# OpenCode Native Server Rust Adapter Boundary

This note records the first Rust-owned OpenCode native protocol slice. It is
an implementation boundary and inventory, not a claim that the full W08
acceptance is complete.

## Installed protocol evidence

The local installed binary reports OpenCode `1.15.11`. Its owned loopback
Server exposes `GET /doc` with OpenAPI `3.1.0`; the live schema identifies the
following operations used by this slice:

- `POST /session` and `GET /session` for native Session identity;
- `GET /session/{sessionID}/message` and
  `GET /session/{sessionID}/message/{messageID}` for message and Part ranges;
- `POST /session/{sessionID}/prompt_async`, whose successful response is HTTP
  `204` (`accepted`, not terminal);
- `POST /session/{sessionID}/abort` for native cancellation;
- `POST /session/{sessionID}/fork` with an optional exact `messageID` anchor.

The source evidence was collected from an explicitly started local Server and
its `/doc` response. No provider credentials or response secrets are stored in
this repository.

## Rust ownership and adapter boundary

`native/crates/opencode-native` owns only the native wire contract:

- typed Session, Message, MessageInfo, Part, and native Prompt structures;
- bounded JSON response decoding and identifier/path validation;
- HTTP request construction for Session, history, async prompt, Abort, and
  exact-message Fork;
- bounded SSE event decoding with named/unnamed JSON event preservation;
- native Question and Permission listing/reply methods and Session Command
  request typing;
- explicit capability reporting and rejection of still-unsupported operations.

The shared Rust execution foundation remains responsible for Run/Attempt
admission, organization authorization, idempotency, event reduction,
terminal-state transitions, persistence, cost attribution, and recovery. This
crate does not write Rudder tables, make permission decisions, or create a
parallel Node lifecycle. A future worker integration must pass the returned
acceptance and native message/Part evidence into that shared authority.

## Deliberate capability limits

The crate now exposes bounded session SSE, Question/Permission reply, and
Session Command wire methods. It still returns an explicit unsupported result
for an unanchored or assistant-boundary Fork. OpenCode's optional Fork body
cannot prove a stable assistant boundary, so the adapter accepts only an exact
native `messageID`. HTTP `204` from `prompt_async` is represented as a
non-terminal `Accepted` outcome and cannot complete a Run by itself. The new
wire methods are not yet connected to shared Run/Attempt interaction authority.

## Verification

The Rust crate has unit and local HTTP contract tests covering typed message and
Part decoding, native media Part shape, identifier safety, async HTTP `204`
acceptance without terminal projection, bounded SSE event parsing, Abort, and
exact-message Fork. The
tests use a disposable loopback fixture and do not claim real provider model
execution. W08 still requires independent real-environment Session continuity,
SSE isolation/reconnect, questions/permissions/commands, 204 disconnect and
reconnect, exact Side Chat Fork, and restart history acceptance.
