---
title: Sync Recent Product Logic Into Official Docs
date: 2026-07-16
kind: implementation
status: in_progress
area: developer_workflow
entities:
  - official_docs
  - product_logic_registry
  - mintlify_docs
issue:
related_plans:
  - 2026-07-09-doc-product-official-docs-sync.md
supersedes: []
related_code:
  - doc/product/domains/agents/built-in-browser.md
  - doc/product/domains/agents/control-tools.md
  - doc/product/domains/collaboration/chat-messenger-im.md
  - doc/product/domains/issues/identity.md
  - doc/product/domains/organizations-and-goals/settings-onboarding-portability.md
  - docs/docs.json
commit_refs: []
updated_at: 2026-07-16
---

# Sync Recent Product Logic Into Official Docs

## Overview

The public documentation already presents Chat and issues as parallel ways to
move work forward. Recent product work added important behavior that is still
missing or underexplained in `docs/`: the Built-in Browser, Rudder-managed MCP
tools, Chat Work manifest and running queue, organization Issue Keys, directed
comment wakeups, automation output defaults, the global Side Panel workbench,
Library document workflows, Desktop recovery and update choices, Feishu daily
sessions, and bounded run-intelligence reads.

This implementation translates those user-visible contracts into public
operator documentation. It does not change product behavior or edit the guarded
Product Logic Registry.

## Product Narrative

Chat and issues are equally valid, first-class task surfaces:

- Chat is conversation-driven and can carry a task from request through Agent
  Run, iteration, inspectable output, and completion.
- Issues are structure-driven and add explicit status, ownership, priority,
  dependencies, acceptance criteria, checkout, and review.
- Task length, importance, cost, or executability does not force a conversion
  from Chat to an issue.
- An organization may still require issue structure for governed workflows.

Public docs must not describe Chat as a clarification-only intake step or an
issue as the only durable or real execution path.

## Scope

1. Add English and Chinese Built-in Browser pages and navigation.
2. Explain Rudder-managed MCP/native control-plane tools in runtime and
   permissions documentation.
3. Expand Chat and Messenger documentation with Work manifest classification,
   running follow-up queues, failure recovery, and Side Panel behavior.
4. Document Issue Key identity, stable organization routes, historical aliases,
   and directed comment wake semantics.
5. Align automation docs with Chat as the default custom output and explain
   per-run Chat evidence.
6. Expand Library guidance for Side Panel previews, Markdown conflict recovery,
   and local file open targets.
7. Add Desktop startup recovery and active-run update guidance.
8. Explain Feishu daily session rollover and the run-intelligence summary/full
   boundary.
9. Keep English and Simplified Chinese navigation and page structure aligned.

## Public Documentation Boundary

Publish user choices, visible states, trust boundaries, supported platforms,
and recovery behavior. Keep internal implementation details out of public docs,
including Broker credentials, JWT/header mechanics, IPC and SQLite internals,
database table names, resource-supervisor shutdown order, test traceability,
and pixel-level UI acceptance rules.

## Verification

- Run `pnpm docs:validate`.
- Check that every new English page has a Chinese counterpart and both appear in
  `docs/docs.json`.
- Search public docs for the obsolete clarification-first Chat narrative.
- Search automation docs for issue-first language that conflicts with the
  parallel Chat/issue model.
- Review the final diff for accidental `doc/product/**` edits and unrelated
  workspace changes.
- Obtain an independent docs review before commit.

## Out Of Scope

- Product behavior or source-code changes.
- Semantic edits to `doc/product/**`.
- Rewriting stable release notes for unreleased work.
- Publishing or deploying the documentation site.
