---
title: Issue Surface Contracts
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.SURFACE.001
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/validators/issue.ts
  - ui/src/components/InlineEditor.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/lib/new-issue-dialog.ts
  - ui/src/index.css
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/Issues.tsx
related_tests:
  - ui/src/components/InlineEditor.test.tsx
  - ui/src/lib/new-issue-dialog.test.ts
  - ui/src/pages/IssueDetail.test.tsx
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
  - tests/e2e/issue-board-display-properties.spec.ts
  - tests/e2e/new-issue-project-context.spec.ts
edit_policy: user_confirmed_only
---

# Issue Surface Contracts

Domain-local surface files record this domain's visible affordances and state
mapping. They are not page-level specs. Cross-domain pages must be mapped in
`doc/product/surfaces/surface-domain-map.md`.

## ISSUE.SURFACE.001

Behavior:

- Issue list and detail surfaces must expose issue status, priority, title,
  project/goal context, assignee/reviewer slots, and linked evidence.
- Issue status and ownership affordances must reflect invalid or unavailable
  transitions clearly through disabled states or server errors.
- Issue detail may show run evidence, comments, review state, and activity, but
  those semantics remain owned by their domains.
- Issue detail description reading and editing are the same content surface:
  headings, lists, paragraphs, links, images, and multiline spacing must keep
  the same readable rhythm when the operator enters edit mode.
- New Issue exposes per-issue `Agent options` for supported assignee runtimes:
  Codex, Claude, and OpenCode can override the selected model and supported
  thinking-effort field, while Claude may also enable its Chrome option.
- Submitted Agent options persist on the issue as assignee runtime overrides.
  They change this issue's assigned run configuration without changing the
  durable default runtime configuration on the agent.
- After New Issue succeeds, the destination follows the Primary Rail surface
  where the dialog opened. Creation from the Primary Rail Issues list or one of
  its Issue Detail routes opens the created Issue Detail under Issues. Creation
  from Messenger, Library, Agents, Organization, Projects, Automations, or any
  other non-Issues primary surface opens the created Issue Detail under
  Messenger at `/messenger/issues/:issueRef`.
- The created Issue destination uses the organization's canonical route key.
  The Issues branch keeps an Issues return breadcrumb; the Messenger branch
  uses a Messenger return breadcrumb to `/messenger/issues`.
- Failed issue mutations must surface an error; they must not silently discard
  the user's action.

Invariant:

- Issue UI must not redefine run, routing, review, comment, or activity rules as
  local page behavior.
- Issue description edit mode must not introduce a different Markdown box model
  from display mode. Any editor-specific implementation must opt into the same
  issue-description typography contract used by the read state.
- Per-issue Agent options belong to the issue's current agent assignee. The
  issue surface must not present them as organization defaults or silently
  write them back to the agent. Execution precedence and reassignment handling
  are owned by `RUN.EXECUTION.001`.
- New Issue destination selection must use the route captured when the dialog
  opened. A later render or modal transition must not silently reclassify a
  non-Issues creation as Issues, and project-local issue lists do not count as
  the Primary Rail Issues surface.

Rationale:

- Issue pages are the operator's main inspection surface, but product logic must
  remain owned by bounded domains to avoid duplicate facts.
- Operators treat issue descriptions as durable task context. Switching between
  reading and editing must not make the content jump, change paragraph grouping,
  or make the user re-parse the work item.
- A local override lets an operator tune one job without cloning or permanently
  reconfiguring the agent that owns the broader class of work.
- Newly created work should land in the operator's current work system: Issues
  remains the structured backlog surface, while every other primary surface
  hands the new Issue to Messenger for immediate follow-up.

Related code:

- `packages/db/src/schema/issues.ts`
- `packages/shared/src/validators/issue.ts`
- `ui/src/components/InlineEditor.tsx`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/lib/new-issue-dialog.ts`
- `ui/src/index.css`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Issues.tsx`

Related tests:

- `ui/src/components/InlineEditor.test.tsx`
- `ui/src/lib/new-issue-dialog.test.ts`
- `ui/src/pages/IssueDetail.test.tsx`
- `tests/e2e/codex-model-order.spec.ts`
- `tests/e2e/issue-detail-toolbar-actions.spec.ts`
- `tests/e2e/issue-board-display-properties.spec.ts`
- `tests/e2e/new-issue-project-context.spec.ts`
