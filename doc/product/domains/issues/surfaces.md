---
title: Issue Surface Contracts
domain: issues
status: active
coverage: seed
contract_ids:
  - ISSUE.SURFACE.001
  - ISSUE.DESCRIPTION.001
related_code:
  - packages/db/src/schema/issues.ts
  - packages/shared/src/validators/issue.ts
  - ui/src/components/InlineEditor.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/MilkdownMarkdownEditor.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/lib/new-issue-dialog.ts
  - ui/src/index.css
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/Issues.tsx
  - ui/src/pages/OrganizationSettings.tsx
related_tests:
  - ui/src/components/InlineEditor.test.tsx
  - ui/src/components/MilkdownMarkdownEditor.test.ts
  - ui/src/pages/IssueDetail.test.tsx
  - tests/e2e/issue-description-image-preview.spec.ts
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
  - tests/e2e/issue-board-display-properties.spec.ts
  - tests/e2e/organization-settings-archived-issues.spec.ts
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
- Failed issue mutations must surface an error; they must not silently discard
  the user's action.
- Active Issue Detail exposes `Archive Issue`, not permanent Delete.
  Organization Settings owns the searchable archived-Issue list plus Restore
  and confirmed permanent Delete actions.
- Archived Issues must not remain visible in normal Issue lists, detail routes,
  search, Messenger, or agent-facing context.

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
- Permanent Issue Delete must not appear on active work surfaces. The Settings
  action must operate only on archived Issues and preserve the explanatory
  tombstone contract in `CONTROL.ENTITY.RETENTION.001`.

Rationale:

- Issue pages are the operator's main inspection surface, but product logic must
  remain owned by bounded domains to avoid duplicate facts.
- Operators treat issue descriptions as durable task context. Switching between
  reading and editing must not make the content jump, change paragraph grouping,
  or make the user re-parse the work item.
- A local override lets an operator tune one job without cloning or permanently
  reconfiguring the agent that owns the broader class of work.

Related code:

- `packages/db/src/schema/issues.ts`
- `packages/shared/src/validators/issue.ts`
- `ui/src/components/InlineEditor.tsx`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/lib/new-issue-dialog.ts`
- `ui/src/index.css`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Issues.tsx`
- `ui/src/pages/OrganizationSettings.tsx`

Related tests:

- `ui/src/components/InlineEditor.test.tsx`
- `ui/src/components/MilkdownMarkdownEditor.test.ts`
- `ui/src/pages/IssueDetail.test.tsx`
- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `tests/e2e/codex-model-order.spec.ts`
- `tests/e2e/issue-detail-toolbar-actions.spec.ts`
- `tests/e2e/issue-board-display-properties.spec.ts`
- `tests/e2e/organization-settings-archived-issues.spec.ts`

## ISSUE.DESCRIPTION.001

Behavior:

- Issue detail descriptions use the same continuously editable Milkdown
  WYSIWYG Markdown surface as Library Markdown documents. The full Issue detail
  and Messenger Issue detail must not swap to a separate read-only renderer
  when the editor is unfocused.
- Plain `Enter` inserts a paragraph in prose and keeps focus in the description;
  inside a list item it creates a sibling list item. Other Markdown blocks
  retain Milkdown's native document behavior so the Issue surface does not
  override Library semantics. `Shift+Enter` is not required for ordinary
  multiline writing; submission behavior must never be bound to plain `Enter`.
- Inline Markdown images remain part of that stable editor surface. Double-clicking
  an image opens the image preview without replacing or unmounting the editor.
- Description changes autosave after editing and flush on blur. Entering a new
  paragraph does not itself submit, close, or replace the description surface.

Invariant:

- Issue description must not regress to a display-first `MarkdownBody` state
  that changes DOM, typography, spacing, or image behavior on click or focus.
- Issue description submit handling must use `mod-enter` semantics when an
  explicit shortcut is present, preserving plain `Enter` for document editing.
- Full Issue detail and Messenger Issue detail share this interaction contract;
  one surface must not carry a separate editor mode or keyboard model.

Rationale:

- An issue description is durable working context, not a compact message
  composer. Operators should be able to read, continue writing, and inspect
  visual evidence without first switching modes or relearning keyboard behavior.
- Keeping one editor DOM removes the renderer handoff that previously caused
  visible layout jumps and let parent click handling preempt image preview.

Related code:

- `ui/src/components/InlineEditor.tsx`
- `ui/src/components/MarkdownEditor.tsx`
- `ui/src/components/MilkdownMarkdownEditor.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Chat.side-panel.tsx`

Related tests:

- `ui/src/components/InlineEditor.test.tsx`
- `ui/src/components/MilkdownMarkdownEditor.test.ts`
- `ui/src/pages/IssueDetail.test.tsx`
- `tests/e2e/issue-description-image-preview.spec.ts`
