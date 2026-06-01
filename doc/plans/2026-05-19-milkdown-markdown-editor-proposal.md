---
title: Milkdown Markdown Editor Migration
date: 2026-05-19
kind: proposal
status: implemented
area: ui
entities:
  - markdown_editor
  - mention_tokens
  - issue_comments
  - messenger_chat
issue:
related_plans:
  - 2026-05-07-issue-draft-markdown-preview.md
  - 2026-05-19-library-project-context-workspace-proposal.md
supersedes: []
related_code:
  - ui/src/components/MarkdownEditor.tsx
  - ui/src/components/MarkdownBody.tsx
  - ui/src/components/CommentThread.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/pages/Chat.tsx
  - ui/src/lib/mention-chips.ts
  - ui/src/lib/mention-token-node.ts
  - ui/src/lib/skill-token-node.ts
  - packages/shared/src/project-mentions.ts
commit_refs: []
updated_at: 2026-05-19
---

# Milkdown Markdown Editor Migration

## Overview

Rudder should migrate its Markdown editing layer from the current MDXEditor /
Lexical implementation to a Milkdown-backed implementation, but the migration
must be treated as an editor engine replacement, not a product behavior change.

The durable contract is:

- Markdown remains the stored and transmitted format.
- Rudder mentions remain canonical Markdown links.
- Agent-readable context remains plain Markdown, not ProseMirror JSON.
- Existing `@` and `$` mention behavior remains available.
- Chat composer plain-text behavior remains unchanged until a separate contract
  is approved.

Milkdown is a reasonable direction because it is a ProseMirror and Remark based
editor framework with a plugin architecture. That maps well to Rudder's need for
custom inline entity tokens and Markdown round-tripping. The risk is that the
current `MarkdownEditor` already owns a large amount of product behavior:
mentions, skills, image uploads, plain-text composer semantics, copy/paste, and
atomic deletion. Those behaviors must be migrated explicitly.

## What Is The Problem?

The current editor works but has accumulated too much surface-specific logic in
one component:

- `MarkdownEditor` combines generic Markdown editing with Rudder-specific
  mention chips, skill tokens, image upload behavior, copy/paste normalization,
  atomic token deletion, and chat plain-text mode.
- Issue descriptions and comments need a better writing/editing experience, but
  chat has a different contract: it should behave like a plain text composer
  with whitelisted entity tokens.
- Docs documents and issue references now depend on `library-doc://` and
  `library-file://` links staying live and recoverable.
- A naive editor swap would break persisted Markdown, linked Docs documents,
  issue prompt assembly, comment rendering, or existing tests.

The product need is not "use Milkdown everywhere." The product need is a more
reliable editing layer that preserves Rudder's AI-native Markdown model while
allowing a cleaner UI interaction.

## What Will Be Changed?

This migration should land in phases.

1. Add a Milkdown-backed editor implementation behind the existing
   `MarkdownEditor` API.
2. Keep the public React props stable:
   `value`, `onChange`, `placeholder`, `mentions`, `onMentionQueryChange`,
   `mentionMenuAnchorRef`, `mentionMenuPlacement`, `onSubmit`,
   `submitShortcut`, `plainText`, `imageUploadHandler`, `bordered`, and styling
   class props.
3. Start with true Markdown surfaces:
   - issue description in the new issue dialog
   - issue comments
   - agent/runtime configuration Markdown fields only after issue surfaces pass
4. Keep chat composer on the existing plain-text path until Milkdown has an
   explicit plain-text mode that preserves the current contract.
5. Implement a Milkdown Rudder entity plugin:
   - parse canonical mention Markdown links into inline tokens
   - serialize tokens back to the same Markdown links
   - support `@` mention search for agents, issues, projects, Docs documents,
     and Docs files
   - support `$` skill search and skill serialization
   - preserve atomic deletion and copy/paste behavior
6. Keep `MarkdownBody` rendering unchanged. The editor migration should not
   change read-only rendering.
7. Add tests for Markdown round-trip, mention insertion, mention deletion,
   copy/paste, image upload Markdown, and chat plain-text non-regression.

## Success Criteria For Change

- Existing persisted Markdown opens without content loss.
- Selecting an `@` mention produces the same canonical Markdown link as today.
- Existing canonical links render as inline tokens inside the editor.
- Saving without edits preserves canonical links and image Markdown.
- Issue descriptions and comments can still upload images.
- `@ library doc` and `@ library file` mentions still drive the linked Docs
  section and agent prompt references.
- Chat composer still stores and sends plain text with whitelisted entity
  tokens, not general WYSIWYG Markdown.
- Tests prove Markdown round-trip and mention behavior across all supported
  entity kinds.
- The old editor path remains available until the Milkdown-backed path has
  browser evidence on the core issue workflows.

## Out Of Scope

- Replacing read-only Markdown rendering in `MarkdownBody`.
- Changing the canonical mention URL schemes.
- Changing backend storage format.
- Migrating chat composer to rich Markdown WYSIWYG in this pass.
- Building a full Notion-like block editor.
- Adding collaborative editing or live cursors.
- Changing Docs document history or issue prompt assembly semantics.

## Non-Functional Requirements

### Maintainability

The editor engine should be isolated behind a small adapter. Surface components
should not import Milkdown internals.

### Accessibility / Usability

The editor must preserve keyboard behavior:

- Enter submit behavior where configured.
- Escape closes mention menus.
- Arrow keys navigate mention menus.
- Backspace/delete remove atomic tokens predictably.
- The mention menu remains reachable and readable in dense issue/comment
  surfaces.

### Security

The editor must not allow unsafe link schemes. Existing checks for unsafe
Markdown links should be preserved or replaced with equivalent validation.

### Performance

Issue descriptions and comments are small-to-medium documents. The first pass
should optimize for correctness and interaction stability, but the editor must
not reinitialize on every keystroke or mention query update.

## User Experience Walkthrough

### Issue Description

1. The user opens the new issue dialog.
2. The description editor looks like a quiet writing surface, not a toolbar-heavy
   document app.
3. The user types normal Markdown.
4. The user types `@` and sees the existing entity menu.
5. Selecting a Docs document inserts a compact inline token.
6. The user creates the issue.
7. The saved issue description still contains the canonical
   `[Label](library-doc://...)` Markdown used by the existing editor helpers.
8. The issue detail page renders the linked Docs document card.

### Issue Comment

1. The user writes a comment in the issue composer.
2. `@agent`, `@issue`, `@project`, `@library doc`, and `$skill` continue to
   behave as before.
3. The user can upload an image.
4. Submitting the comment writes Markdown that downstream renderers and agents
   already understand.

### Chat Composer

1. The user opens Messenger or Chat.
2. The composer behavior remains unchanged in this phase.
3. Generic Markdown syntax is not rendered as WYSIWYG in the composer.
4. Only approved entity tokens get special inline rendering.

## Implementation

### Product Or Technical Architecture Changes

Introduce a staged architecture:

```text
surface props
  -> MarkdownEditor adapter
    -> MDXEditor legacy implementation
    -> Milkdown implementation for approved surfaces
      -> RudderMentionMilkdownPlugin
      -> RudderSkillMilkdownPlugin
      -> Markdown serializer/parser bridge
```

The adapter keeps surface components stable while the editor engine changes.
If the Milkdown path regresses, individual surfaces can fall back without
rewriting issue, chat, or Docs components.

### Breaking Change

No storage, API, or runtime breaking change is intended. The Markdown string
contract must remain compatible.

### Design

The first Milkdown UI should be quiet and dense:

- no persistent heavy toolbar in issue/comment surfaces
- slash or bubble controls are out of scope for the first pass
- mention menu remains the primary inline UI affordance
- token styling should match existing mention chips and skill tokens
- markdown shortcuts may be enabled for true Markdown surfaces only

The editor should use Milkdown's document model internally, but `onChange`
must emit Markdown strings.

### Security

New dependencies are limited to Milkdown packages and their ProseMirror/Remark
dependencies. No new HTTP endpoints are required. Link validation must continue
to reject unsafe schemes such as `javascript:`, `data:`, and `vbscript:`.

## What Is Your Testing Plan (QA)?

### Goal

Prove that the editor engine changed without changing Rudder's Markdown,
mention, image, or chat composer behavior.

### Prerequisites

- Local dependencies installed with `pnpm install`.
- Seeded organization with agents, projects, issues, Docs documents, Docs files,
  and skills.
- Browser verification for issue detail and new issue dialog.

### Test Scenarios / Cases

1. Markdown round-trip:
   - open Markdown with headings, lists, links, code blocks, images, and mention
     links
   - save without edits
   - compare emitted Markdown
2. Mention insertion:
   - insert agent, issue, project, Docs document, Docs file, and skill tokens
   - assert emitted Markdown matches existing canonical helpers
3. Atomic token behavior:
   - click around token boundaries
   - backspace/delete removes one token, not half a link
   - copy selected token returns canonical Markdown
4. Issue workflow:
   - create issue with mentions and image
   - reopen issue
   - linked Docs section appears
5. Comment workflow:
   - submit comment with mentions and image
   - rendered timeline shows mention chips
6. Chat non-regression:
   - generic Markdown syntax remains literal in plain-text composer
   - entity tokens still work

### Expected Results

- All existing mention-related unit tests pass.
- New Milkdown tests prove canonical round-tripping.
- Browser/E2E test covers new issue and comment flows.
- Chat tests prove the plain-text contract did not change.

### Pass / Fail

Migration status: pass for the issue description and issue comment scope.

Implemented in this slice:

- Added a Milkdown-backed editor adapter behind the existing `MarkdownEditor`
  component API.
- Enabled the Milkdown path only for true Markdown issue surfaces:
  new issue description, existing issue description editing, and issue
  comments.
- Kept chat and Messenger on the existing plain-text composer path.
- Preserved canonical Markdown mention serialization for agents, issues,
  projects, Docs documents, Docs files, and skills.
- Wired Docs file mention lookup through new issue descriptions, existing issue
  descriptions, and issue comments.
- Preserved the context-rich issue mention menu, including issue status,
  project, and assignee metadata.
- Preserved both `@` and `$` skill mention lookup behavior.
- Added mark-level Rudder token handling for Milkdown links:
  - Backspace/Delete removes an adjacent Rudder token as one unit.
  - Copying selected Rudder tokens writes canonical Markdown links.
  - Clicking Rudder token links does not navigate away from the editor.
  - Typing inside a Rudder token is blocked so a token cannot be edited into a
    partial label while retaining the original link.
- Added Milkdown token styling for skill links as well as entity links.
- Kept read-only Markdown rendering in `MarkdownBody` unchanged.
- Kept the legacy MDXEditor/Lexical path available for all other surfaces.

Verified:

- `node node_modules/vitest/vitest.mjs run
  ui/src/components/MilkdownMarkdownEditor.test.ts
  ui/src/components/MarkdownEditor.test.tsx
  ui/src/components/NewIssueDialog.test.tsx
  ui/src/components/NewIssueDialog.autosave.test.tsx
  ui/src/components/CommentThread.test.tsx
  ui/src/components/CommentThread.images.test.tsx
  ui/src/components/InlineEditor.test.tsx`
  passed with 44 tests.
- `node node_modules/typescript/bin/tsc -b packages/shared/tsconfig.json
  ui/tsconfig.json` passed.
- `cd ui && node ../node_modules/typescript/bin/tsc -b &&
  ./node_modules/.bin/vite build` passed.
- `RUDDER_E2E_USE_EXISTING_SERVER=1
  RUDDER_E2E_BASE_URL=http://127.0.0.1:3491 node
  node_modules/.pnpm/playwright@1.58.2/node_modules/playwright/cli.js test
  --config tests/e2e/playwright.config.ts
  tests/e2e/issue-comment-mentions.spec.ts
  tests/e2e/new-issue-skill-mentions.spec.ts
  tests/e2e/issue-detail-documents-ux.spec.ts` passed with 4 tests.
  The Docs file fixtures are created through Rudder's workspace-file API so the
  test uses the same runtime home as the server in existing-server mode.
- The issue comment mention E2E now also verifies Backspace removes an inserted
  agent token as one token.
- Milkdown unit coverage now verifies Rudder token link recognition and
  canonical Markdown copy serialization, plus active repeated-query replacement.
- Browser verification on `http://127.0.0.1:3491` confirmed:
  - existing issue description editing mounts Milkdown
  - issue comment editor mounts Milkdown
  - typing `@` opens the existing mention menu
  - Backspace removes an inserted mention token as one unit
  - Messenger/chat composer does not mount Milkdown and remains on the legacy
    plain-text path

Notes:

- The shell in this environment does not expose `pnpm`, so validation used the
  installed package binaries through Node directly.
- Running Vitest with the Codex.app bundled Node hit a macOS code-signing issue
  loading Rollup's native optional dependency. Re-running with
  `/opt/homebrew/bin/node` passed.
- Browser console still shows an existing breadcrumb nested `<li>` warning on
  issue detail. That warning predates and is unrelated to the editor migration.

## Review Loop

Execution mode: spawned reviewers. Reviewer A owned scenario and demand
correctness; Reviewer B owned implementation, validation, and handoff
correctness.

### Round 1: Scenario And Demand Reviewer

Verdict: conditional accept, then accept after rework.

Findings:

- The migration must be framed as an editor-engine replacement, not a product
  model change.
- Chat is a separate user job from issue writing. It must remain plain text with
  whitelisted entity tokens.
- Docs document and file links are now part of the issue knowledge workflow, so
  `library-doc://` and `library-file://` must be first-class mention kinds.
- The first implementation slice should be reversible per surface.
- Existing issue description editing is part of the issue description journey,
  not only new issue creation.
- Mention replacement must target the active query under the caret, not the last
  repeated string in the Markdown body.

Changes made after review:

- The implementation uses `engine="milkdown"` only on issue description and
  comment surfaces.
- `MarkdownEditor` keeps the legacy path as the default.
- The proposal explicitly names chat as out of scope for Milkdown WYSIWYG in
  this pass.
- `InlineEditor` now supports the Milkdown engine and issue detail description
  editing uses it.
- Milkdown mention replacement now uses visible caret context to disambiguate
  repeated `@query` / `$query` strings.
- New issue and comment surfaces now receive Docs file mention lookup, not only
  preloaded Docs documents.

### Round 1: Delivery And Trust Reviewer

Verdict: reject for handoff, then accept after rework.

Findings:

- The first browser verification failed because Milkdown was configured with
  `gfm` but not the base `commonmark` schema, causing
  `Schema is missing its top node type ('doc')`.
- A migration slice is not acceptable without rendered evidence because
  TypeScript and unit tests cannot prove the editor mounted.
- Atomic token behavior must be handled at the ProseMirror mark level, not only
  by styling links as chips.
- Docs UX E2E must pass because Docs files are part of the linked context
  journey.
- The final handoff must keep unrelated dirty worktree files out of the Milkdown
  commit.

Changes made after review:

- Added the `commonmark` preset before `gfm`.
- Re-ran browser verification and confirmed both issue surfaces mount.
- Added Milkdown-side Rudder token deletion and canonical copy handling for
  issue surfaces.
- Added token-internal typing prevention and skill token styling.
- Fixed strict E2E locators in the Docs UX test and reran it with the Milkdown
  E2E slice.
- Reworked Docs file E2E setup to create files through the workspace-file API
  instead of directly writing under `E2E_HOME`, then reran all 4 E2E tests.

### Round 2 Verdict

Scenario reviewer: accept for first migration slice.

Delivery reviewer: accept for the issue description/comment scope. The old
editor remains for chat and other Markdown surfaces because those surfaces still
have separate behavior contracts.

## Documentation Changes

- Update this proposal with `commit_refs` when the implementation lands.
- Add developer notes near the editor adapter explaining why chat and issue
  surfaces use different editor modes.
- Update any user-facing docs only if the visible editor behavior changes
  beyond polish.

## Open Issues

1. Whether to expose any formatting toolbar for issue/comment surfaces.
   Recommendation: no persistent toolbar in the first pass.
2. Whether to migrate Docs file editing to Milkdown immediately.
   Recommendation: defer until issue paths pass, because Docs currently
   benefits from raw file editing.
3. Whether Milkdown plain-text mode is worth implementing for chat.
   Recommendation: only after issue Markdown mode is stable.
4. Whether to remove MDXEditor dependency after migration.
   Recommendation: keep it until all `MarkdownEditor` consumers have explicit
   Milkdown coverage and browser evidence.
