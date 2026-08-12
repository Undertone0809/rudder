---
title: Markdown Document Live Preview
domain: collaboration
status: active
coverage: logic_contract
spec_depth: logic_contract
contract_ids:
  - MARKDOWN.DOCUMENT.LIVE.PREVIEW.001
related_code:
  - packages/shared/src/website-icons.ts
  - server/src/routes/website-metadata.ts
  - server/src/services/website-metadata.ts
  - ui/src/api/websiteMetadata.ts
  - ui/src/components/CodeMirrorMarkdownEditor.tsx
  - ui/src/components/InlineEditor.tsx
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/NewGoalDialog.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/components/NewProjectDialog.tsx
  - ui/src/components/ProjectProperties.tsx
  - ui/src/components/workbench/LibraryLiveSurface.tsx
  - ui/src/lib/markdown-editor-scroll.ts
  - ui/src/lib/markdown-live-preview.ts
  - ui/src/lib/website-metadata-cache.ts
  - ui/src/pages/Chat.side-panel.tsx
  - ui/src/pages/OrganizationWorkspaces.tsx
  - ui/src/pages/IssueDetail.tsx
  - ui/src/pages/Automations.tsx
  - ui/src/pages/AutomationDetail.tsx
  - ui/src/pages/GoalDetail.tsx
related_tests:
  - server/src/__tests__/website-metadata.test.ts
  - server/src/__tests__/website-metadata-routes.test.ts
  - ui/src/components/InlineEditor.test.tsx
  - ui/src/components/CodeMirrorMarkdownEditor.test.tsx
  - ui/src/components/MarkdownEditor.test.tsx
  - ui/src/components/MilkdownMarkdownEditor.test.ts
  - ui/src/lib/markdown-live-preview-surfaces.test.ts
  - ui/src/lib/markdown-live-preview.test.ts
  - ui/src/lib/website-metadata-cache.test.ts
  - tests/e2e/markdown-live-preview.spec.ts
  - tests/e2e/issue-comment-mention-boundary.spec.ts
  - tests/e2e/goal-detail-lifecycle.spec.ts
  - tests/e2e/automation-detail-layout.spec.ts
related_plans:
  - doc/plans/2026-07-23-codemirror-markdown-live-preview.md
edit_policy: user_confirmed_only
---

# Markdown Document Live Preview

## MARKDOWN.DOCUMENT.LIVE.PREVIEW.001

## Contract Summary

Rudder's durable Markdown document surfaces use the Markdown string as their
only content truth. Inactive reveal units render as readable CommonMark/GFM;
the source line, list item, or inseparable multiline structure touched by the
current cursor or selection reveals its exact editable source. Rendering,
focus changes, metadata loading, and token
decoration do not normalize or rewrite that source.

This contract applies only to explicitly opted-in document fields: Issue
descriptions, Library Markdown bodies, Automation instructions, and Goal and
Project descriptions. Chat and Issue comment composers, runtime/configuration
source fields, Organization Skill source, and Library frontmatter keep their
separate editor behavior.

## Intent / User Job

An operator can read a durable Markdown document with its normal visual
hierarchy, edit table cells without dropping into a raw table, inspect images at
full size, paste useful links or several images in one operation, and save
without an editor silently changing delimiters, indentation, escapes, or
boundary whitespace.

## Why / Design Reasoning

- Markdown is the durable interchange format for these surfaces, so it must
  remain the primary value rather than a serialization of a different document
  model.
- Live preview reduces visual noise while keeping the source directly
  inspectable at the point of editing.
- Rudder entity and skill references are product objects, not ordinary links;
  keeping them atomic protects their recognizability and navigation behavior.
- Website metadata is useful for link labels and icons, but it is asynchronous
  and untrusted. It must never overwrite later operator edits or weaken the
  existing external-fetch boundary.
- Message composers and execution-sensitive source fields serve different user
  jobs. Opt-in routing prevents a shared editor change from altering Chat,
  comment wake behavior, prompt templates, skills, or frontmatter.

## Actors / Objects / State

- Board operator: reads, focuses, selects, edits, pastes, navigates references,
  and saves Markdown.
- Markdown source: the exact persisted string, including delimiter choice,
  indentation, escapes, and leading/trailing newlines.
- Reveal unit: an ordinary source line or independently addressable list item by
  default. An inseparable multiline structure such as a nested list item,
  fenced code block, quote block, or table is one complete reveal unit.
- Active block set: every reveal unit intersecting the primary cursor or
  current selection.
- Preview decoration: a non-persisted visual projection of Markdown syntax.
- Rudder rich reference: an existing canonical entity reference inserted
  through `@`, an existing `$skill` reference, or a previously persisted
  canonical Rudder reference.
- Website link metadata: a site icon, site identity, and optional public page
  title resolved under `CHAT.WEBSITE.LINK.ICON.001`.

## Entry Points / Inputs

- Issue description creation and editing in the full surface or Side Panel.
- Full-Library, workbench, and Side Panel editing of a Markdown file body.
- Automation instruction creation and editing in the full surface or Side
  Panel.
- Goal and Project description creation and editing.
- Cursor movement, pointer focus, keyboard selection, paste, undo/redo, and
  controlled-value updates from the owning save flow.
- An exact single `http` or `https` URL, or one or more image files, on the
  clipboard.

## Product Logic Flow

1. The owning surface explicitly selects document live preview. The editor
   loads the persisted Markdown string without parsing and serializing it into a
   replacement value.
2. Rudder derives reveal units and preview decorations from that string.
   Inactive supported blocks show readable CommonMark/GFM. Unknown syntax and
   raw HTML remain inert, visible source rather than executing or disappearing.
3. Moving the cursor or selection recomputes the active block set. A normal
   source line or list item removes its visual projection and exposes its exact
   source; an inseparable multiline construct reveals as one complete source
   block.
4. A canonical Rudder rich reference remains an atomic, accessible inline
   object in both active and inactive blocks. An unmodified click navigates
   directly to its target and does not reveal its underlying Markdown link.
   Copy, deletion, undo, and persistence continue to operate on the canonical
   source representation.
5. An ordinary link is not atomic. Activating its block exposes its source,
   including label, destination, and delimiters. Activating a rendered image
   opens the global image preview and keeps its Markdown source concealed;
   keyboard activation provides the same preview behavior.
6. Pasting one valid HTTP(S) URL over editable selected text replaces the
   selection with `[selected text](URL)` synchronously. Pasting without a
   selection inserts a Markdown link with a known site name or hostname
   fallback, then requests an authoring-purpose page title only when the target
   is eligible for public website metadata retrieval.
7. Async title enrichment updates only the exact inserted link while both its
   fallback label and destination remain unchanged. Cursor movement is allowed;
   any operator edit to the inserted range cancels replacement. The enrichment
   is coalesced into existing editor history and never creates its own undo
   step; with no intervening edit, one undo returns to the state before paste.
8. Smart-link conversion does not run for non-HTTP(S), unsafe, multiline, or
   already formatted Markdown clipboard content, or inside code/raw-source
   contexts. Those inputs follow ordinary paste behavior and do not trigger
   website metadata fetches.
9. In an inactive block, an ordinary external HTTP(S) link shows the compact
   website icon governed by `CHAT.WEBSITE.LINK.ICON.001`. Activating the block
   removes the icon projection and shows the exact Markdown source.
10. A rendered GFM table remains readable when activated. Activating an
    individual header or body cell opens an in-place single-cell editor without
    exposing the whole table source. Enter or blur commits, Escape cancels, and
    Tab or Shift+Tab commits and advances between adjacent cells. Literal line
    breaks are flattened and unescaped pipes are escaped before persistence so
    the edit cannot corrupt the table structure.
11. Pasting or dropping one or more image files uploads them concurrently and
    inserts successful Markdown image references once, in clipboard order, as
    one undoable edit. Successfully inserted image-only lines remain rendered
    when the paste completes instead of exposing the final image's source. A
    partial failure retains successful uploads in order and reports how many
    files failed; a total failure leaves the document unchanged and reports the
    failure.
12. The owning surface persists the resulting Markdown through its existing
    save path. Empty-value normalization may use trimming only to decide whether
    a value is empty; every non-empty value is stored without trimming or
    editor-driven source normalization.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Inactive document block | Opted-in surface; cursor/selection is elsewhere | Render supported Markdown with readable rhythm | Persist or normalize the projection | Editor/component and E2E coverage |
| Active normal block | Cursor or selection intersects the block | Reveal exact editable source; reveal the complete inseparable multiline unit | Re-serialize delimiters, indentation, or whitespace | Source-fidelity and selection tests |
| Rudder rich reference | Canonical `@` entity, `$skill`, or persisted Rudder link | Keep one atomic token; unmodified click navigates | Reveal or rewrite its underlying Markdown on focus | Token unit/E2E coverage |
| Ordinary external link | Inactive versus active block | Show website icon while inactive; show exact link source while active | Let an icon alter copied or persisted text | Website-link unit/E2E coverage |
| Rendered image | Click or keyboard activation | Open the global image preview while the Markdown remains rendered | Reveal image source as a side effect of preview | Image-preview component and E2E coverage |
| Rendered table cell | Click, Enter, blur, Escape, Tab, or Shift+Tab | Edit only the selected cell in place; commit, cancel, or navigate predictably | Reveal the full table source or corrupt delimiters | Table interaction component and E2E coverage |
| Multiple pasted images | Two or more image files, including partial upload failure | Upload concurrently, insert successes in clipboard order as one undo step, and report failures | Reorder successful images, discard successes, or create one undo step per image | Image-paste component and E2E coverage |
| URL paste over selection | One valid HTTP(S) URL and editable selected text | Insert `[selection](URL)` immediately | Fetch metadata or overwrite unrelated text | Smart-paste tests |
| URL paste without selection | One valid HTTP(S) URL outside source/code contexts | Insert fallback label, then conditionally enrich with page title | Replace a range the operator has edited | Metadata race and undo tests |
| Composer or source field | Chat, Issue comment, agent/prompt config, Skill source, or frontmatter | Keep that surface's existing editor mode | Opt in through a shared default | Negative regression E2E |
| Unsafe metadata target | Private, loopback, link-local, credentialed, invalid, or unsafe redirect | Keep a safe fallback without a fetch result | Contact or expose an internal target | Server metadata security tests |

## Actor-Visible Input

The operator sees rendered Markdown except at the reveal unit currently being
edited. Atomic Rudder references remain recognizable objects. Ordinary links
show a favicon only in preview state. Paste accepts normal clipboard input; the
smart-link branch is limited to one explicit credential-free HTTP(S) URL.
Local, private, and same-origin targets may still become ordinary links, but
they do not trigger website metadata retrieval.

## Operator-Visible Output

- Focused content displays its exact Markdown syntax without a separate global
  edit/preview switch.
- Leaving a block restores its readable projection without changing content.
- `@` entity and `$skill` objects remain compact and navigate directly.
- A pasted URL becomes readable Markdown link text, with page-title enrichment
  only when it cannot overwrite a later edit.
- Save, conflict, and error UI remain owned by the Issue, Library, Automation,
  Goal, or Project surface.

## Persisted Evidence

The existing Issue, Library file, Automation, Goal, or Project Markdown value
is the durable evidence. This contract adds no parallel rich-document model and
no database state for decorations, active blocks, icons, or metadata. Existing
save/activity/revision evidence remains owned by each domain.

## Canonical Scenarios

1. Edit a Library link:
   - Trigger: Open a Markdown file containing `[Rudder](https://rudder.dev)`.
   - Expected state/action: The inactive block shows a link and website icon;
     clicking the block reveals the exact source.
   - Visible output: Moving away restores the rendered link.
   - Evidence: The saved file is byte-for-byte unchanged until an explicit edit.
2. Paste a public page:
   - Trigger: Paste one HTTP(S) URL with no selection.
   - Expected state/action: Insert a hostname/site-name link immediately and
     enrich its label only if the inserted link remains unchanged.
   - Visible output: The editor stays responsive and the enriched link remains
     undoable.
   - Evidence: Persisted Markdown contains the final operator-visible label and
     URL.
3. Activate a Rudder reference:
   - Trigger: Click an `@` entity or `$skill` token in any block state.
   - Expected state/action: Navigate directly through the canonical target.
   - Visible output: The token never flashes or expands into raw link syntax.
   - Evidence: The underlying canonical Markdown remains unchanged.
4. Use an excluded composer:
   - Trigger: Type or paste in Chat or an Issue comment.
   - Expected state/action: Preserve the existing composer, submission, and
     mention behavior.
   - Visible output: No document live-preview state or smart-link rewrite is
     introduced.
   - Evidence: Chat and comment non-regression tests pass.

## Invariants / Non-Goals

- The Markdown source is the only content truth; decorations never become a
  second editable document model.
- Focus, blur, selection, metadata loading, and icon loading do not mutate the
  source.
- Non-empty values preserve exact source boundaries and formatting.
- IME composition, undo/redo, keyboard selection, and controlled external
  updates must not lose or duplicate text.
- Canonical Rudder reference formats and existing link targets do not change.
- `ISSUE.COMMENTS.001` and `ROUTING.COMMENT.WAKE.001` remain unchanged.
- Chat and Side Chat composers, Chat message/decision-note editors, Issue
  comment composers, Agent capabilities and prompt templates, Organization
  Skill source, and Library YAML frontmatter do not opt in.
- Raw HTML is not executed by the live-preview layer.
- This contract does not add collaborative editing, live cursors, a new
  persistence format, or a global replacement of every Markdown editor.

## Drift Boundaries

Update this contract when changing the opted-in surface set, active-block
granularity, source-fidelity guarantee, rich-reference exception, smart-paste
rules, metadata overwrite guard, website-icon state behavior, or composer/source
exclusions. CodeMirror module boundaries, decoration implementation, styling
tokens, metadata cache duration, and internal parsing helpers may change without
a contract update when the visible behavior and invariants remain intact.

## Traceability

Related plans:

- `doc/plans/2026-07-23-codemirror-markdown-live-preview.md`

Related code:

- `ui/src/components/CodeMirrorMarkdownEditor.tsx`
- `ui/src/components/MarkdownEditor.tsx`
- `ui/src/components/InlineEditor.tsx`
- `ui/src/components/MarkdownBody.tsx`
- `ui/src/components/NewIssueDialog.tsx`
- `ui/src/components/NewGoalDialog.tsx`
- `ui/src/components/NewProjectDialog.tsx`
- `ui/src/components/ProjectProperties.tsx`
- `ui/src/components/workbench/LibraryLiveSurface.tsx`
- `ui/src/lib/markdown-editor-scroll.ts`
- `ui/src/lib/markdown-live-preview.ts`
- `ui/src/lib/website-metadata-cache.ts`
- `ui/src/pages/Chat.side-panel.tsx`
- `ui/src/pages/OrganizationWorkspaces.tsx`
- `ui/src/pages/IssueDetail.tsx`
- `ui/src/pages/Automations.tsx`
- `ui/src/pages/AutomationDetail.tsx`
- `ui/src/pages/GoalDetail.tsx`
- `server/src/services/website-metadata.ts`

Related tests:

- `ui/src/components/CodeMirrorMarkdownEditor.test.tsx`
- `ui/src/components/MarkdownEditor.test.tsx`
- `ui/src/components/InlineEditor.test.tsx`
- `ui/src/lib/markdown-live-preview-surfaces.test.ts`
- `ui/src/lib/markdown-live-preview.test.ts`
- `ui/src/lib/website-metadata-cache.test.ts`
- `server/src/__tests__/website-metadata.test.ts`
- `tests/e2e/markdown-live-preview.spec.ts`
- `tests/e2e/organization-workspaces-markdown-editor.spec.ts`
- `tests/e2e/issue-comment-mention-boundary.spec.ts`

Known gaps:

- None for the scoped document surfaces in this contract.
