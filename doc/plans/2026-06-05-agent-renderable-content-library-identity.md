---
title: Agent Renderable Content Library Identity
date: 2026-06-05
kind: implementation
status: implemented
area: api
entities:
  - agent_output_references
  - library_entries
  - renderable_content
issue:
related_plans:
  - 2026-05-19-library-project-context-workspace-proposal.md
  - 2026-06-02-library-project-workspace-contract.md
  - 2026-04-12-chat-skill-token-interaction.md
supersedes: []
related_code:
  - packages/db/src/schema
  - packages/shared/src/project-mentions.ts
  - server/src/routes/orgs.ts
  - server/src/services/organization-workspace-browser.ts
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/lib/mention-chips.ts
commit_refs: []
updated_at: 2026-06-05
---

# Agent Renderable Content Library Identity

## Summary

Implement the first durable slice of Rudder's Agent renderable content contract:
Library file references written by agents and operators should resolve by stable
Library entry identity, not by mutable file path. This slice introduces
DB-backed `library_entries`, a `library-entry://<id>` Markdown token format, and
workspace file API support so newly created or referenced Library files can be
rendered consistently across issue, chat, approval, and comment surfaces.

The broader render-block protocol remains future work. This implementation
creates the identity foundation required before rich cards or Agent-authored
render blocks can be trusted.

## Problem

Rudder already has stable identifiers for issues, chats, agents, and projects,
so those references can be rendered as durable chips. Library workspace files
are different: current `library-file://file?p=...&t=...` tokens identify a file
by path and a display snapshot. Paths and titles can change, and a new file can
later appear at an old path. A durable Agent PRD, plan, or handoff reference must
mean "the Library entry the agent produced," not "whatever currently lives at
this path."

## Scope

- In scope:
  - add a DB-backed `library_entries` table for workspace-backed files
  - add shared `library-entry://` formatter/parser and strong/weak reference
    classification
  - make workspace file create/read/list APIs expose `libraryEntryId` when an
    entry exists or is created
  - update Rudder-managed rename, move, and delete operations to preserve entry
    identity and current path/state
  - update Library copy-link and mention insertion to emit strong
    `library-entry://` links when possible
  - update Markdown rendering and editor token decoration for Library entries
  - preserve `library-file://` and `library-directory://` as weak compatibility
    references
  - add focused tests for parsing, server identity behavior, and UI rendering
- Out of scope:
  - arbitrary Agent-authored UI schemas or React/HTML rendering
  - full render-block support such as `reference_card` or `work_product`
  - DB identities for directories, external resources, or every Library item
  - automatic migration or rewrite of historical issue/comment/chat Markdown
  - stable tracking of filesystem mutations made outside Rudder
  - fake revision pinning for workspace files without stored revisions

## Implementation Plan

1. Add `library_entries` schema and migration.
2. Add shared types and helpers for `library-entry://` links and reference
   strength classification.
3. Add a server Library entry service that resolves by `orgId + entryId`, gets
   or creates entries for workspace file paths, updates paths on Rudder-managed
   move/rename, and marks entries deleted on Rudder-managed delete.
4. Extend organization workspace file entry/detail payloads with
   `libraryEntryId`.
5. Update workspace file create/read/list/mention-files and rename/move/delete
   routes to use the Library entry service.
6. Update UI copy-link, mention insertion, MarkdownBody, MarkdownEditor, and
   mention chips to use and render strong Library entry tokens.
7. Add focused tests for:
   - `library-entry://` parser/formatter
   - file create/read returning an entry id
   - move/rename preserving entry id and changing current path
   - delete preserving a deleted entry rather than erasing the reference
   - MarkdownBody rendering Library entry tokens as Library links

## Design Notes

- `library-entry://<id>` is the canonical strong reference for new durable
  Library file links.
- `library-file://...?p=...` remains a weak path-current compatibility link.
  It must not silently follow historical path aliases because that can misdirect
  when a new file appears at the old path.
- Entry lookup is always organization-scoped. A valid UUID from another
  organization must render as forbidden or broken, never as accessible content.
- Guarantees apply to Rudder-managed workspace operations. External disk
  mutation can produce a resolver state such as `missing_backing_file`; it is
  not treated as a tracked move in this slice.
- Directory identity is deferred because directory move/copy/delete affects
  descendants and requires a separate cascade contract.

## Success Criteria

- New Library file links emitted by Rudder use `library-entry://<id>`.
- Existing `library-file://` links continue to render and navigate by path.
- A Rudder-managed rename or move preserves the entry id and updates the strong
  reference target.
- A new file at an old path does not hijack an existing strong entry reference.
- Agent-facing and UI-facing workspace file payloads can carry entry identity.
- The renderer distinguishes strong Library entry tokens from weak path tokens.

## Validation

- Passed: `pnpm --filter @rudderhq/shared typecheck`
- Passed: `pnpm --filter @rudderhq/server typecheck`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm test:run packages/shared/src/project-mentions.test.ts`
- Passed: `pnpm test:run ui/src/components/MarkdownBody.test.tsx`
- Passed: `pnpm test:run server/src/__tests__/organization-workspace-browser.test.ts`
- Passed: `RUDDER_E2E_USE_EXISTING_SERVER=1 pnpm test:e2e tests/e2e/mention-token-alignment.spec.ts`
- Passed: `pnpm test:e2e tests/e2e/global-markdown-mentions.spec.ts`
  after clearing stale SysV shared memory segments left by old embedded
  PostgreSQL processes.
- Passed: `pnpm build`
- Passed: `git diff --check`

## Open Issues

- Whether future Library documents should become `library_entry` rows or stay
  separate `library-doc://` strong references until a migration is approved.
- Whether import/export should rewrite strong Library entry tokens in Markdown
  immediately or wait for the portability reference manifest work.
- Whether a later filesystem watcher or reconciliation command should convert
  external disk renames from `missing_backing_file` into tracked moves.
