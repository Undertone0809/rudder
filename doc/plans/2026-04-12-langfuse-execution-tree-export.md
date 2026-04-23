# Langfuse Execution-Tree Export

Date: 2026-04-12

## Goal

Upgrade Rudder's Langfuse integration from route/root-span tracing to execution-tree tracing so one `chat_turn` or `issue_run` trace exposes the runtime middle process:

- model turns
- thinking steps
- tool calls and results
- stderr and system events when relevant

## Problem

Rudder already produces transcript signals for several runtimes, and `run-intelligence-core` already knows how to reconstruct execution steps from logs. The gap is export shape, not raw data capture.

Current behavior is mostly:

- one root Langfuse observation per execution
- a few lifecycle events
- no canonical transcript-to-observation export

That produces trace coverage without execution-tree visibility.

## Scope

Phase 1 of this fix covers:

- assistant chat turns, emitted as `chat_turn`
- heartbeat-backed executions, including `issue_run`

Out of scope for this pass:

- new board-facing APIs
- adapter-by-adapter bespoke Langfuse SDK calls
- LLM-as-a-judge expansion

## Design

### 1. Shared transcript exporter

Add one server-side exporter that maps `TranscriptEntry[]` to Langfuse child observations under a provided parent observation.

Mapping:

- `assistant`, `thinking`, `result` -> one `generation` observation per model turn
- `tool_call` / `tool_result` -> `tool` observations nested under the active generation
- `stderr`, `stdout`, `system` -> `event` observations
- `init` -> generation metadata seed for model/session context

The exporter must:

- preserve Rudder root execution IDs
- use transcript timestamps as observation start/end times
- close dangling tools/generations safely on partial failure
- never throw back into the execution path

### 2. Chat turn surface

Split assistant reply tracing from generic chat-side actions:

- assistant reply root traces use `surface=chat_turn`
- convert-to-issue / approval / lightweight operation application stay `surface=chat_action`

### 3. Chat assistant raw transcript feed

Extend `chat-assistant` streaming so Langfuse export can receive sanitized internal transcript entries, including:

- assistant text without the result sentinel envelope
- final `result` entries for usage/finalization
- non-assistant transcript entries already exposed to the stream client

The public streaming API keeps its current UX-oriented event contract.

### 4. Heartbeat transcript capture

Parse runtime stdout/stderr during heartbeat execution into transcript entries and export them to Langfuse before the root observation closes.

Heartbeat remains the system of record for logs and status; Langfuse stays derived.

## Validation

- unit tests for transcript-to-observation mapping behavior
- server route tests for `chat_turn` surface selection
- chat assistant tests proving sanitized internal transcript feed includes assistant/result data
- targeted server tests for heartbeat observation surface behavior still passing

## Success Criteria

- one direct assistant chat turn appears as a `chat_turn` trace
- the trace shows nested model/tool activity instead of only the outer wrapper
- one issue-backed run appears as `issue_run` with nested transcript-derived children
- Langfuse export failure does not block Rudder execution
