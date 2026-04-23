# Langfuse Agent Run Gap Diagnosis

Status: advisory
Date: 2026-04-12

## Goal

Diagnose why the current Langfuse integration does not satisfy the requirement of tracing full agent runs, including model turns and intermediate execution steps.

## Questions

1. Which runtime surfaces are currently traced only at the entry or root level?
2. Which intermediate steps are available inside Rudder today but are not exported to Langfuse?
3. Which intermediate steps are not available in Rudder at all and therefore require upstream adapter/runtime changes?
4. What is the correct next move: local instrumentation patch, observability contract revision, or runtime/adapter architecture work?

## Inspection Scope

- `server/src/routes/chats.ts`
- `server/src/services/chat-assistant.ts`
- `server/src/services/heartbeat.ts`
- `server/src/langfuse.ts`
- `doc/plans/2026-04-12-langfuse-derived-observability-phase1.md`
- Langfuse official observability and tracing guidance

## Expected Output

- A build-advisor diagnosis that identifies the primary broken layer
- Explicit critique of the current observability model
- A decision rubric for the next iteration
- Options and one recommended next move
