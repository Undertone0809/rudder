---
title: Chat title defaults
date: 2026-06-18
kind: implementation
status: in_progress
area: chat
entities:
  - messenger_chat
  - chat_titles
issue:
related_plans:
  - 2026-04-10-messenger-unification.md
  - 2026-06-02-chat-native-automation-output.md
supersedes: []
related_code:
  - server/src/routes/chats.ts
  - server/src/services/chats.ts
  - server/src/__tests__/chat-routes.test.ts
  - ui/src/lib/chat-title.ts
  - ui/src/pages/Chat.parts.tsx
  - ui/src/pages/Chat.empty-state.test.tsx
commit_refs: []
updated_at: 2026-06-18
---

# Chat Title Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Remove user-visible `New chat` placeholders by making the first user
message the deterministic default chat title, while keeping AI title generation
as an optional replacement when Fast Intelligence succeeds.

**Architecture:** The persisted chat title should become useful as soon as the
first user message is accepted. The server should write a deterministic title
from that user message before attempting AI generation. AI generation remains a
best-effort enhancement that may replace the deterministic title only while the
conversation still has a system-owned default title. UI fallback should prefer
user-message previews and never promote assistant replies into titles.

**Tech Stack:** Express routes, Drizzle-backed chat service, React/Vite UI,
Vitest route and component tests.

---

## Requirements

- A board operator should not see `New chat` in chat lists or recent-chat rows
  after they have sent a first non-empty user message.
- The default title must be deterministic when AI is disabled or fails: clean
  and truncate the initiating user input using existing Messenger title
  formatting.
- Assistant reply text must stay preview/subtitle content and must not become a
  display title.
- If Fast Intelligence is configured and returns a usable title, that AI title
  should replace the deterministic user-input title.
- Manual renames and already non-default titles must not be overwritten by
  automatic deterministic or AI title generation.

## Files

- Modify `server/src/services/chats.ts`
  - Add a server-side update path that can replace either `New chat` or the
    exact deterministic fallback title, without touching manually renamed
    titles.
- Modify `server/src/routes/chats.ts`
  - Persist the deterministic user-message title before asynchronous AI title
    generation.
  - Pass the deterministic title into AI replacement so AI can replace that
    exact system-owned title.
- Modify `server/src/__tests__/chat-routes.test.ts`
  - Add RED tests proving fallback title persistence happens immediately and AI
    can replace the deterministic fallback.
- Modify `ui/src/lib/chat-title.ts`
  - Prefer `latestUserMessagePreview` over assistant replies for display
    fallback.
  - Do not use `latestReplyPreview` as title fallback.
- Modify `ui/src/pages/Chat.empty-state.test.tsx`
  - Update the recent-conversation expectation so default-title display comes
    from the user preview, not `New chat` or assistant reply.

## Task 1: Server deterministic title before AI

**Files:**
- Modify: `server/src/services/chats.ts`
- Modify: `server/src/routes/chats.ts`
- Test: `server/src/__tests__/chat-routes.test.ts`

- [ ] **Step 1: Write failing route tests**

Add tests that verify:

```ts
expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Need help");
expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
```

for the immediate deterministic path, and:

```ts
expect(mockChatService.updateDefaultTitle).toHaveBeenNthCalledWith(1, "chat-1", "Help me debug the release failure");
expect(mockChatService.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
  "chat-1",
  "Help me debug the release failure",
  "Debug release failure",
);
```

for the AI replacement path.

- [ ] **Step 2: Verify RED**

Run:

```sh
pnpm vitest run server/src/__tests__/chat-routes.test.ts --testNamePattern "chat title"
```

Expected: FAIL because deterministic fallback is not persisted before AI and
the service has no system-generated replacement method.

- [ ] **Step 3: Implement minimal server behavior**

Add a chat service method:

```ts
replaceSystemGeneratedTitle(id: string, expectedTitle: string, title: string)
```

that updates only when the current title is either the exact deterministic
fallback or `New chat`.

Change title startup so it:

1. builds `fallbackTitle` from the user body
2. writes `fallbackTitle` immediately with `updateDefaultTitle`
3. runs AI generation asynchronously
4. replaces only the expected fallback title with the AI title

- [ ] **Step 4: Verify GREEN**

Run:

```sh
pnpm vitest run server/src/__tests__/chat-routes.test.ts --testNamePattern "chat title"
```

Expected: PASS.

## Task 2: UI display fallback uses user intent

**Files:**
- Modify: `ui/src/lib/chat-title.ts`
- Modify: `ui/src/pages/Chat.empty-state.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Update or add tests that make a default-title conversation include:

```ts
title: "New chat",
summary: null,
latestUserMessagePreview: "Can this release workflow run from the desktop shell?",
latestReplyPreview: "Assistant reply should stay hidden.",
```

and expect the visible row title to be:

```ts
"Can this release workflow run from the desktop shell?"
```

- [ ] **Step 2: Verify RED**

Run:

```sh
pnpm vitest run ui/src/pages/Chat.empty-state.test.tsx
```

Expected: FAIL because display fallback currently does not accept
`latestUserMessagePreview` in the shared chat-title helper.

- [ ] **Step 3: Implement minimal UI behavior**

Change `displayChatTitle` to accept `latestUserMessagePreview` and use fallback
order:

```ts
summary -> latestUserMessagePreview -> title
```

Do not use `latestReplyPreview` as title fallback.

- [ ] **Step 4: Verify GREEN**

Run:

```sh
pnpm vitest run ui/src/pages/Chat.empty-state.test.tsx
```

Expected: PASS.

## Task 3: Focused validation and review

**Files:**
- Verify changed test files and affected type surfaces.

- [ ] **Step 1: Run focused tests**

Run:

```sh
pnpm vitest run server/src/__tests__/chat-routes.test.ts --testNamePattern "chat title"
pnpm vitest run ui/src/pages/Chat.empty-state.test.tsx
```

- [ ] **Step 2: Run typecheck if focused tests pass**

Run:

```sh
pnpm -r typecheck
```

- [ ] **Step 3: Spawn reviewer gate**

Spawn functional, adversarial, and heuristic reviewers against the diff and
validation evidence. The gate passes only if no reviewer names an unresolved
blocker.

- [ ] **Step 4: Commit scoped files**

Stage only files changed for this plan:

```sh
git add doc/plans/2026-06-18-chat-title-defaults.md \
  server/src/routes/chats.ts \
  server/src/services/chats.ts \
  server/src/__tests__/chat-routes.test.ts \
  ui/src/lib/chat-title.ts \
  ui/src/pages/Chat.empty-state.test.tsx
git commit -m "fix: default chat titles from user input"
```

Do not stage unrelated dirty files already present in the worktree.
