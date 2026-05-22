---
title: Source file size boundary refactor
date: 2026-05-19
kind: implementation
status: implemented
area: developer_workflow
entities:
  - source_file_size
  - module_boundaries
issue:
related_plans:
  - 2026-04-30-heartbeat-runtime-kernel-refactor.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-04-09-org-skill-agent-enabled-skills-refactor.md
supersedes: []
related_code:
  - server/src/services/runtime-kernel/heartbeat.ts
  - ui/src/pages/AgentDetail.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/components/transcript/RunTranscriptView.tsx
  - server/src/services/knowledge-portability/organization-portability.ts
  - server/src/services/knowledge-portability/organization-skills.ts
commit_refs:
  - 4aa497a7
  - 78b87a63
  - 112d74a7
  - a68f6568
  - df0cfc75
  - fb33c97f
  - 1a0c9384
  - 64906b77
updated_at: 2026-05-20
---

# Source File Size Boundary Refactor

## Summary

Reduce oversized hand-written production source files below 1500 lines by
extracting cohesive internal modules behind stable public entrypoints. This is
a behavior-preserving architecture cleanup: API routes, UI routes, schemas,
runtime contracts, and adapter wire contracts remain stable.

## Problem

Several production source files have become multi-responsibility hotspots.
They mix orchestration, formatting, persistence, UI state, rendering, and
boundary adapters in the same file, which makes future agent and human changes
riskier. A hard 1500-line ceiling gives the repository a concrete architectural
pressure valve: large files must expose a thin facade and move domain-specific
logic into named modules.

## Scope

- In scope: first-party production `.ts` and `.tsx` files under `server/`,
  `ui/`, `desktop/`, `cli/`, and `packages/` that are currently above 1500
  lines.
- In scope: behavior-preserving module extraction, route helper extraction,
  UI subcomponent extraction, and stable facade preservation.
- Out of scope: generated Drizzle migration snapshots, lockfiles, binary or
  image assets, docs/reference files, tests, and example plugin code.
- Out of scope: schema changes, HTTP contract changes, runtime adapter
  behavior changes, or user-visible workflow redesign.

## Implementation Plan

1. Audit oversized hand-written production files and group them by subsystem.
2. For each hotspot, extract cohesive helpers or subcomponents into sibling
   modules while preserving existing imports and exported contracts.
3. Keep route/page/service entry files as facades responsible for composition,
   not deep domain work.
4. Avoid rewrites in dirty files unless the split can preserve the current
   uncommitted behavior and reduce the file without reverting user edits.
5. Re-run the source-size audit until every in-scope production file is under
   1500 lines.

## Design Notes

- The line ceiling applies to hand-written production source only in this pass.
  Generated artifacts have their own lifecycle and should be handled by
  generator configuration or repository policy instead of manual edits.
- Existing public entrypoints should remain import-compatible wherever
  possible. Internal extraction modules can be more granular, but consumers
  should not be forced to learn the new internals.
- UI page files should become route-level composers. Rendering helpers,
  sections, hooks, and pure formatting logic should live beside the page or in
  existing component directories.
- Server route files should keep route registration and request/response
  policy at the top level, with domain helpers moved into services or private
  route modules.

## Success Criteria

- No in-scope hand-written production source file is above 1500 lines.
- Existing user-visible behavior and public API contracts remain unchanged.
- Dirty pre-existing worktree edits are preserved rather than reverted.
- New module names make ownership clearer than generic `utils` dumping.

## Implementation Notes

- Split organization skill and portability services behind their existing
  service entrypoints.
- Split the heartbeat runtime kernel into session, recovery, execution,
  release, wakeup, and miscellaneous handler modules while keeping the public
  heartbeat facade stable.
- Split Desktop main-process update, quit, image payload, local environment,
  capability, and workspace launch payload logic into focused modules.
- Split CLI worktree management and runtime utility helpers into responsibility
  modules behind their existing package entrypoints.
- Split oversized server routes/services and UI pages/components into sibling
  route helper, service helper, and view-part modules without changing route or
  API contracts.

## Validation

- Run a source-size audit excluding generated files, docs/assets, tests, and
  examples.
- Run `pnpm -r typecheck`.
- Run focused tests for directly changed areas when feasible.
- Run `pnpm test:run` and `pnpm build` unless blocked by external or pre-existing
  issues.

Current audit command:

```sh
rg --files -g '!node_modules' -g '!dist' -g '!build' -g '!coverage' \
  -g '!desktop/.packaged' -g '*.ts' -g '*.tsx' -g '!**/*.test.ts' \
  -g '!**/*.test.tsx' -g '!**/__tests__/**' \
  -g '!packages/plugins/examples/**' \
  | xargs wc -l \
  | awk '$1 > 1500 && $2 != "total" {print $1, $2}' \
  | sort -nr
```

## Open Issues

- A later repo-policy task should decide whether generated snapshots, docs
  assets, test files, and example plugins should also receive a hard line-count
  gate or documented exemptions.
