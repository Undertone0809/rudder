---
title: Chat Transcript Storage and Fork Persistence
date: 2026-08-07
kind: implementation
status: in_progress
area: data_model
entities:
  - chat_transcript
  - messenger_chat
  - chat_fork
issue:
related_plans:
  - 2026-07-23-chat-response-annotations.md
  - 2026-07-15-chat-steer-and-immediate-stop.md
supersedes: []
related_code:
  - packages/db/src/schema/chat_generation_events.ts
  - packages/db/src/schema/chat_messages.ts
  - server/src/services/chats.ts
  - server/src/services/chat-generation-protocol.ts
commit_refs: []
updated_at: 2026-08-07
---

# Decision

Keep `chat_generation_events` as the append-only source for live generation
transcript events. Remove the cumulative `__chatTranscript` JSONB projection
from `chat_messages`, which currently rewrites the full array for every stream
event and causes PostgreSQL TOAST/MVCC growth.

Add `chat_message_transcript_entries` as a detached, ordered per-message
snapshot store. It is used for legacy/non-generation-backed messages and for
forked message copies, so a fork remains readable after its source conversation
or generation is deleted. The API transcript shape remains unchanged.

# Implementation

- Add the transcript-entry table, organization/message foreign keys, composite
  message-order primary key, and organization/message/order index.
- Centralize transcript loading with the precedence: accepted generation
  events, detached entries, then legacy JSONB fallback during migration.
- Stop writing cumulative transcript JSON during streaming. Persist normalized
  entries only for non-generation-backed messages and detached fork copies.
- Fork only the selected source branch and materialize its transcript entries
  in the same transaction as the copied messages.
- Add an idempotent, short-batch legacy backfill command with dry-run support;
  repair old forks only when their source message sequence is unambiguous.
- Tune `chat_messages` autovacuum/analyze thresholds and document the offline
  `VACUUM (FULL, ANALYZE)` step required to return historical bloat to disk.

# Contracts and verification

Affected contracts are `CHAT.LIFECYCLE.001`, `CHAT.FORK.001`, `RUN.RESULT.001`,
and `RUN.CHAT.AGENT.001`. This implementation does not edit `doc/product/**`.

Verification covers streaming write amplification, legacy backfill idempotency,
fork boundary and parent deletion, historical variants, Stop/late events,
annotations/attachments, typecheck, tests, build, and real database size
readback after maintenance.
