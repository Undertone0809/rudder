---
title: Cursor ACP native adapter boundary
date: 2026-10-18
kind: implementation
status: in_progress
area: runtime
entities:
  - native_chat
  - cursor_acp
  - runtime_adapter
issue:
related_plans:
  - 2026-09-21-rudder-native-chat-complete-plan.md
supersedes: []
related_code:
  - native/crates/cursor-acp-adapter
commit_refs: []
updated_at: 2026-10-18
---

# Scope

`rudder-cursor-acp-adapter` is the Rust-owned, transport-neutral boundary for
Cursor ACP. It serializes the documented `initialize`, `session/new`,
`session/load`, `session/prompt`, and `session/cancel` requests; parses
`session/update` notifications; and exposes typed permission, question, and
plan requests. Unknown protocol messages remain visible as bounded values
instead of being silently discarded.

The crate owns no process, HTTP listener, database query, or terminal Run
transition. A future Host adapter may launch the installed `agent acp` process;
the Rust native-chat worker must retain admission, identity binding, ordered
event reduction, persistence, and finalization authority.

# Capability and history policy

Capabilities are recorded as `unknown`, `documented`, `observed`,
`verified`, or `unsupported`. Documentation and parser fixtures cannot produce
`verified` evidence. Precise Fork and Steer remain fail-closed until the
installed Cursor build is probed; Side Chat must use an explicit visible
`context_handoff` when precise branching is unavailable. The adapter never
scrapes Cursor's private IDE database and never fabricates a Fork request.

ACP updates may repeat identical payloads or be replayed incompletely by
`session/load`. Each bounded `ObjectSupplement` carries an independent
occurrence identity, Run/session binding, sequence, source update name, and
explicit reason. Supplements are a display/recovery aid and do not claim that
Cursor history is complete or lossless.

# Remaining integration and acceptance gates

The shared Host/process transport, D1 binding/segment/span persistence, and
native-chat worker are outside this slice and must consume these types without
moving business authority into the adapter. W10 remains incomplete until a
real installed Cursor ACP environment verifies CU-01 through CU-05, including
restart/load, permissions/questions/plans, notification display, history
completeness, Side Chat lifecycle, and the capability report.
