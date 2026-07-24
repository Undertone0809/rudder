---
title: Org Skill Runtime Materialization Fix
date: 2026-07-24
kind: fix-plan
status: completed
area: skills
entities:
  - organization_skills
  - runtime_skill_materialization
  - messenger_chat
  - chat_generation_control
issue:
related_plans:
  - 2026-07-20-merge-rudder-creation-skills-into-docs.md
supersedes: []
related_code:
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/chats.ts
  - ui/src/pages/Chat.tsx
commit_refs:
  - "25e60b6c3 fix: install organization skills locally"
  - "cb2cd6955 fix: harden organization skill installs"
  - "39c2e07d2 fix: protect organization skill sources"
  - "5ced73dd7 fix: serialize local skill transitions"
  - "3a3784216 fix: harden organization skill mutations"
  - "5cd508007 fix(chat): decouple transcript loading from runtime preparation"
  - "93a091980 fix(chat): scope transcript history by organization"
  - "055c7889a fix(chat): surface runtime preparation failures"
updated_at: 2026-07-24
---

# Org Skill Runtime Materialization Fix

## Problem

Remote organization skills are currently treated as remote sources at runtime.
Preparing an agent can delete and rebuild every selected skill directory,
including fetching each remote file again. Chat detail enrichment uses the same
path, so opening a conversation can block on filesystem and network work.

Chat generations also receive a control lease before a runtime attempt owns
them. Slow pre-runtime preparation can therefore be mistaken for a stale
runtime owner and terminally project `control_owner_stale` before the provider
process starts.

## Decisions

- Every non-bundled organization skill is an editable local installation.
  Remote identity remains provenance and an explicit update source.
- Installation and explicit update materialize the complete skill tree into the
  organization skills directory. Normal listing, Chat loading, and repeated
  runs reuse that directory without downloading or rebuilding it.
- Legacy remote rows are migrated once, under a per-skill lock, when a run or
  edit first requires the local installation.
- Rudder bundled and capability-bundled skills remain read-only.
- Runtime metadata resolution is side-effect free. Only an actual run may
  ensure that a legacy skill has been installed locally.
- A chat generation receives a control owner and lease only when a runtime
  attempt begins. Pending pre-runtime preparation is not stale-owner recovery
  input.

## Implementation

1. Add atomic, path-safe, bounded-concurrency installation for remote and
   package skill trees, preserving upstream provenance while exposing the local
   directory for editing and runtime use.
2. Split organization skill entry resolution into metadata-only and
   installation-required modes; remove destructive per-run `__runtime__`
   rebuilding and apply the shared behavior to all local adapters.
3. Make Chat transcript loading independent of runtime descriptor enrichment
   and keep Chat list/detail enrichment free of skill installation work.
4. Move generation control lease acquisition to attempt start and restrict
   stale-owner recovery to generations with a real leased runtime owner.
5. Synchronize `AGENT.SKILLS.001`, `AGENT.RUNTIME.PERMISSIONS.001`,
   `AGENT.INSTRUCTIONS.001`, and `RUN.CHAT.AGENT.001`.

## Verification

- Service tests cover install-once reuse, offline subsequent reads/runs,
  editable non-bundled skills, read-only bundled skills, atomic failure, and
  concurrent legacy migration.
- Adapter tests cover Claude, Codex, Cursor, Gemini, OpenCode, and Pi consuming
  the same stable organization skill source.
- Chat generation tests cover slow pre-runtime preparation, lease renewal after
  attempt start, stale recovery, and retry after `control_lost`.
- E2E covers import, enable, run, edit, and rerun, plus production-shaped Chat
  loading with many skills.
- Run lint, recursive typecheck, test suite, build, product logic check,
  relevant E2E, and packaged Desktop verification before handoff.

## Outcome

- Remote and imported organization skills now install as complete, editable
  local trees. Normal reads and runs reuse the stable installation, while
  Rudder-bundled and capability-bundled skills remain read-only.
- Shared runtime preparation resolves the same installed skill entries for
  Claude, Codex, Cursor, Gemini, OpenCode, and Pi without destructive per-run
  reconstruction.
- Messenger transcript loading is independent of runtime descriptor
  preparation, and runtime preparation failures are reported as sanitized,
  retryable failures distinct from provider installation failures.
- Chat generations remain ownerless during legitimate preprocessing. Control
  ownership, attempt fencing, and the lease begin when the adapter attempt
  starts.
- The guarded product contracts `AGENT.SKILLS.001`,
  `AGENT.RUNTIME.PERMISSIONS.001`, `AGENT.INSTRUCTIONS.001`, and
  `RUN.CHAT.AGENT.001` were synchronized under the approved contract delta.

## Validation Record

- `pnpm lint`: passed.
- `pnpm -r typecheck`: passed.
- `pnpm build`: passed.
- `pnpm product-logic:check`: passed with 78 contracts.
- Focused organization-skill, runtime-adapter, Chat descriptor, generation
  control, and failure-projection regression suites passed.
- `pnpm test:run` exited successfully; database-backed suites that could not
  initialize embedded PostgreSQL were skipped by their existing environment
  guard.
- The added organization-skill E2E is discoverable by Playwright. Executing it
  and `pnpm desktop:verify` was blocked before application startup because the
  macOS host exhausted its 32 System V shared-memory identifiers. A standalone
  `initdb` reproduced `shmget(...): No space left on device`; no product
  assertion failed. Existing PostgreSQL processes were left untouched to avoid
  disrupting other work.
