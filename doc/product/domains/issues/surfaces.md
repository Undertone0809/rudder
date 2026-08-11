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
  - ui/src/components/InspectableImage.tsx
  - ui/src/context/ImagePreviewContext.tsx
  - ui/src/components/InlineEditor.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/lib/new-issue-dialog.ts
  - ui/src/index.css
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/Issues.tsx
related_tests:
  - ui/src/components/InlineEditor.test.tsx
  - ui/src/lib/index-css.test.ts
  - ui/src/lib/new-issue-dialog.test.ts
  - ui/src/pages/IssueDetail.test.tsx
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/issue-detail-properties-layout.spec.ts
  - tests/e2e/issue-detail-toolbar-actions.spec.ts
  - tests/e2e/issue-description-image-preview.spec.ts
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
- Full Issue Detail may replace one continuous middle range of a long unified
  Activity timeline with an exact-count disclosure. The earliest context and
  latest evidence remain visible, and each reveal extends chronologically from
  the older side using a viewport- and content-height budget. Disclosure is
  monotonic for the current Issue mount: polling, live updates, edits, deletes,
  and resize must not re-hide visible evidence. Compact Messenger side-panel
  comment timelines remain fully rendered by this rule.
- Initial Activity disclosure waits for comments, activity, linked runs, live
  runs, and the active run to settle successfully. An initial error in any
  source fails open for that mount, keeps available evidence fully expanded,
  and exposes scoped retry without allowing a later successful retry to
  introduce a new hidden range.
- Issue Detail chooses one- versus two-column layout from the width of the issue
  work surface, not the browser viewport. In compact desktop/tablet mode,
  operational properties join the primary issue scroll after issue
  identity/context and before the description; issue actions and all detail
  evidence remain available. Opening or resizing the global Side Panel must not
  leave Issue Detail in unreadable columns or lose editable state. Phone layouts
  retain the dedicated Properties sheet.
- Issue detail description reading and editing are the same content surface:
  headings, lists, paragraphs, links, images, and multiline spacing must keep
  the same readable rhythm when the operator enters edit mode.
- New Issue, Issue Detail, and Side Panel issue-description authoring follow
  `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001`: inactive logical blocks render, active
  blocks reveal exact Markdown source, and the owning Issue save path remains
  authoritative.
- Issue description and issue-level attachment images open in the shared
  application image-preview overlay with explicit close, copy, and download
  controls plus `Escape` dismissal. They do not open as Built-in Browser
  targets. Closing the overlay preserves the Issue Detail route and state.
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
- Live-preview focus or decoration must not normalize a non-empty Issue
  description. Issue comment composition and wake behavior remain governed by
  `ISSUE.COMMENTS.001` and `ROUTING.COMMENT.WAKE.001`, not by the
  issue-description editor.
- Image evidence on Issue Detail must retain an application-owned exit path
  while the image is loading or unavailable; image size and load failure must
  not clip the preview controls.
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
- Issue Detail is embedded in work surfaces whose width can change independently
  of the browser. A container-owned hierarchy keeps operational metadata and
  editable evidence readable without substituting a reduced-capability view or
  remounting stateful controls.
- A local override lets an operator tune one job without cloning or permanently
  reconfiguring the agent that owns the broader class of work.
- Newly created work should land in the operator's current work system: Issues
  remains the structured backlog surface, while every other primary surface
  hands the new Issue to Messenger for immediate follow-up.

Related code:

- `packages/db/src/schema/issues.ts`
- `packages/shared/src/validators/issue.ts`
- `ui/src/components/InspectableImage.tsx`
- `ui/src/context/ImagePreviewContext.tsx`
- `ui/src/components/InlineEditor.tsx`
- `ui/src/components/CommentThread.tsx`
- `ui/src/components/CommentThread.timeline.ts`
- `ui/src/components/CommentThreadTimelineRows.tsx`
- `ui/src/components/IssueTimelineDisclosure.tsx`
- `ui/src/components/IssueDetailFind.tsx`
- `ui/src/components/issue-timeline-disclosure.ts`
- `ui/src/hooks/useIssueTimelineQueries.ts`
- `ui/src/hooks/issue-timeline-readiness.ts`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/lib/new-issue-dialog.ts`
- `ui/src/index.css`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Issues.tsx`

Related tests:

- `ui/src/components/InlineEditor.test.tsx`
- `ui/src/components/CommentThread.test.tsx`
- `ui/src/components/issue-timeline-disclosure.test.ts`
- `ui/src/hooks/issue-timeline-readiness.test.ts`
- `ui/src/lib/index-css.test.ts`
- `ui/src/lib/new-issue-dialog.test.ts`
- `ui/src/pages/IssueDetail.test.tsx`
- `tests/e2e/codex-model-order.spec.ts`
- `tests/e2e/issue-detail-properties-layout.spec.ts`
- `tests/e2e/thread-pressure.spec.ts`
- `tests/e2e/issue-detail-toolbar-actions.spec.ts`
- `tests/e2e/issue-description-image-preview.spec.ts`
- `tests/e2e/issue-board-display-properties.spec.ts`
- `tests/e2e/new-issue-project-context.spec.ts`
