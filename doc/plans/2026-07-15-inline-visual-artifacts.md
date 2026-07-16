---
title: Inline visual artifacts for Rudder Chat
date: 2026-07-15
kind: implementation
status: complete
area: chat
entities:
  - messenger_chat
  - codex_local
  - chat_attachments
  - inline_visual_artifacts
  - organization_skills
issue:
related_plans:
  - 2026-04-16-unify-chat-agent-run-semantics.md
  - 2026-04-14-codex-managed-skill-materialization.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/shared/src/types/chat.ts
  - packages/shared/src/organization-skill-reference.ts
  - server/resources/bundled-skills/visualize/SKILL.md
  - server/src/services/chat-assistant.ts
  - server/src/routes/chats.ts
  - ui/src/pages/Chat.messages.tsx
commit_refs:
  - bdcc182bd
updated_at: 2026-07-16
---

# Inline Visual Artifacts for Rudder Chat

## Goal

Archive strict Codex visualize fragments as Agent-created Chat attachments and
render them inline for their completed assistant message through a minimal,
theme-aware, declarative and scriptless sandbox. The durable Chat message and attachment must
remain the source of truth after refresh, branch navigation, regeneration, and
forking; the temporary Codex visualization directory is capture-only.

## Scope

- Parse only exact `::codex-inline-vis{file="<basename>.html"}` directives and
  preserve exact source ranges for deterministic body replacement.
- Capture at most three files from the active Codex thread directory beneath
  Rudder's managed `CODEX_HOME`, with basename, type, size, realpath, and
  symlink-escape checks.
- Persist accepted fragments through the existing generated Chat attachment
  path and add a server-owned directive-to-attachment mapping to the completed
  assistant message.
- Hide mapped directives from Markdown and render only mapped, Agent-created,
  message-owned HTML attachments in a dedicated component.
- Provide theme variables, base utility classes, responsive sizing, CSS-only
  tooltips, restrictive CSP, and an explicit HTML/SVG/attribute/CSS AST
  allowlist. Measure height from the host without artifact JavaScript.
- Reuse the existing attachment content path as a forced source download for
  unavailable visuals. Mermaid remains ordinary fenced Markdown.
- Ship a Rudder-native `visualize` bundled skill as an always-enabled,
  read-only organization skill. Preserve the Codex composition guidance while
  replacing JavaScript, CDN, bridge, and active-control assumptions with the
  declarative Rudder runtime contract.
- Materialize the full bundled skill package, including its runtime reference,
  OpenAI metadata, and sanitizer-valid example, into supported runtime skill
  homes. Emit inline directives only when the current runtime exposes the exact
  thread-scoped visualization directory; otherwise degrade to Mermaid,
  Markdown, or prose.

## Security Boundary

- Never resolve model-provided absolute paths or paths outside the current
  managed Codex thread visualization directory.
- Never expose `CODEX_HOME`, thread directories, object keys, or storage paths
  to the browser.
- Treat message text and fragment markup as untrusted. Only server-generated
  mapping metadata authorizes inline rendering.
- Keep the iframe scriptless with `sandbox="allow-same-origin"`; same-origin is
  used only so the host can measure the sanitized `srcdoc`. CSP denies scripts,
  connections, forms, nested frames, objects, base URLs, and navigation.
- Remove active/network-capable nodes and URL attributes before rendering.
  Parse artifact CSS with `css-tree`, retain only bounded static rules,
  properties, values, and `@media`, and reject URL nodes, raw nodes, unknown
  functions, custom properties, imports, fonts, keyframes, and malformed CSS.
- Do not implement `window.openai`, parent DOM access, auth propagation, or a
  general parent/child bridge.

## Implementation

1. Add a shared strict directive parser with exact ranges and focused parser
   tests.
2. Extend the Codex local adapter result with persistence-ready visual capture
   metadata and bytes sourced only from the current managed thread directory.
3. Extend generated attachment persistence to archive visual HTML and write
   the validated message mapping after attachment creation.
4. Add `ChatInlineVisual` and a small visual runtime wrapper, then integrate it
   into assistant message rendering without moving unrelated Chat logic.
5. Add focused server, UI integration, and deterministic E2E coverage for
   interaction, refresh persistence, ownership, rejection, and fallback cases.
6. Add the adapted `visualize` bundled skill, include it in the required Rudder
   skill projection, validate the package against the skill schema and the real
   sanitizer, and make the Chat E2E prove full-directory Codex materialization.

## Deferred Product Logic Delta

No `doc/product/**` files are changed by this plan. A later explicitly
authorized Product Logic Registry update should:

- extend `CHAT.LIFECYCLE.001` with completed-message-owned inline visual
  attachments and server-owned directive mappings;
- refine `CHAT.FORK.001` so archived inline visual attachments are the narrow
  exception to the current no-attachment-copy rule, with shared backing assets
  retained until the final referencing branch is deleted; and
- align `CHAT.THREAD.MANIFEST.001` with inline visual source/download handling
  without claiming copied fork artifacts as newly produced outputs; and
- extend `AGENT.SKILLS.001` so `visualize` is part of the always-enabled Rudder
  baseline, while documenting that HTML artifact emission is conditional on a
  runtime-provided thread visualization directory.

## Resolved Security Decision

Arbitrary fragment JavaScript is not supported. The artifact is declarative
HTML/SVG/CSS only: scripts and active elements are removed, CSS is AST-sanitized,
the iframe has no `allow-scripts`, and CSP denies every external resource class.
This removes the Chromium self-navigation/request exception that existed in the
earlier script-capable design. A real Playwright probe verifies no artifact
script executes, no request to `evil.invalid` occurs, and the frame remains on
`about:srcdoc`.

## Test Sequence

1. Add parser, adapter/runtime, persistence, component, Chat integration, and
   E2E tests before production implementation.
2. Run focused suites and record the expected failing RED result.
3. Implement the smallest code that satisfies the tests.
4. Re-run focused tests after each layer, then run full workspace typecheck,
   `pnpm lint`, `pnpm product-logic:check`, and the focused E2E path.

## Verification Record

- Focused shared/runtime/server/UI suites: 162/162 passed.
- Full workspace typecheck: passed.
- Import lint: 1,923 files checked, passed.
- Full production build: passed. Existing Vite large-chunk and
  `::highlight(...)` optimizer warnings remain unchanged.
- Product Logic contracts: 72/72 valid.
- Playwright Chromium security/persistence probe: passed, including script,
  network, self-navigation, safe CSS, reload, fork, and deletion checks.
- Final current-tree Chat E2E: 1/1 passed in 35.4 seconds. It proved complete
  managed `visualize` package materialization, refresh persistence, UI and API
  forks, both deletion orders, zero artifact-originated requests, and no script
  execution. Stable screenshots passed at 1280x720 and 390x844; screenshot
  capture disables finite animations so responsive transition frames are not
  mistaken for final layout.
- Follow-up visual QA replaced the minimal sanitizer fixture with a realistic
  four-week Agent operations report. The E2E now proves the inline frame tracks
  its content height while moving from the open Work rail's stacked layout to
  the collapsed desktop layout and back to a stacked 390px mobile layout.
- Final inline visual UI suite: 13/13 passed. The runtime rejects legacy active
  control and Lucide affordances, removes unsupported clipping paths, and uses
  only CSP directives recognized by current Chromium.
- Adapted skill eval: 4/4 targeted cases passed against the production
  sanitizer. The original Codex skill baseline proved the adjustable simulator
  becomes a misleading frozen snapshot under Rudder, while the adapted skill
  remains complete through static scenarios. A static review viewer with the
  paired outputs and correctness benchmark is available at
  `/tmp/rudder-visualize-eval-viewer/review.html`.
- Full repository Vitest was attempted twice. The final run passed 3,771 tests;
  19 unrelated tests and 14 DB-backed suite hooks timed out, with four existing
  post-teardown PostgreSQL errors. All inline-visual focused tests passed in the
  same run.
- `architecture:audit:check` remains red on the same repository-wide oversized
  file regressions reproduced from clean `HEAD`; this change adds no new entry.
- Independent static spec verifier: `APPROVE`; it mapped every Goal, Scope,
  Security Boundary, and Acceptance item to concrete implementation/tests. Its
  non-blocking gaps are named branch/regenerate E2E scenarios and
  unavailable-fallback E2E coverage. Browser-level responsive height reflow is
  now exercised by the desktop/side-rail/mobile screenshot path.
- Independent security gate: the full adversarial review returned `APPROVE`;
  a separate reviewer returned `APPROVE_DELTA` with no P0/P1 findings for the
  two post-review changes (forbidden-subtree removal before DOMPurify and the
  unavailable-only `out_of_window` reason).
- Final independent black-box verifier: `APPROVE` with no findings after the
  unsupported `navigate-to` CSP directive was removed and the desktop/mobile
  screenshots were re-captured from the final tree.

## Product Logic Alignment

Affected current contracts are `CHAT.LIFECYCLE.001`, `CHAT.FORK.001`,
`CHAT.THREAD.MANIFEST.001`, `CHAT.SIDE.PANEL.001`, `RUN.CHAT.AGENT.001`, and
`AGENT.SKILLS.001`.
The implementation preserves their existing message/run ownership, branch,
fork, durable Output, and Side Panel rules while adding a new completed-message
rendering behavior.

The guarded Product Logic Registry requires a follow-up semantic delta that
documents inline visual capture, attachment mapping, completed-message gating,
sandbox isolation, branch/fork ownership, and the expanded always-enabled
bundled skill baseline. That delta is explicitly deferred because this task does
not authorize edits under `doc/product/**`.

Owner: Chat and Agent Runtime maintainers. Due date: before this behavior is
treated as a documented stable contract. Reason: Product Logic Registry edits
require separate explicit user approval.

## Acceptance

- Valid declarative chart/report fragments render inline and survive a reload
  from persisted message data. Native `<details>` and CSS-only tooltips remain
  available without artifact scripts.
- Malformed, unsafe, missing, escaped, oversized, or excess directives never
  execute and show a clear fallback where mapping exists.
- A message can render only its own mapped attachments after branch selection,
  regenerate, reopen, or fork.
- The iframe has exactly `allow-same-origin` and no `allow-scripts`, a restrictive
  CSP, no Rudder credentials or bridge, and clamped host-measured height updates.
- Mermaid remains a normal Markdown rendering path.
- `visualize` appears as a locked bundled Rudder skill, its complete package is
  materialized into the managed Codex skill home, and unsupported runtimes do
  not receive instructions to fabricate an inline artifact directory.
