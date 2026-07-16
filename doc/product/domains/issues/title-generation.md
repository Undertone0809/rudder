---
title: Issue Title Generation
domain: issues
status: active
coverage: detailed
spec_depth: logic_contract
contract_ids:
  - ISSUE.TITLE.GENERATION.001
related_code:
  - server/src/routes/issues.mutations.ts
  - server/src/services/issue-title-generation.ts
  - server/src/services/issues.comments-attachments.ts
  - server/src/services/title-generation.ts
  - server/src/services/product-intelligence.ts
  - server/src/services/organization-intelligence-profiles.ts
  - ui/src/api/issues.ts
  - ui/src/components/MessengerContextSidebar.tsx
  - ui/src/lib/messenger-query-cache.ts
related_tests:
  - server/src/__tests__/issue-lifecycle-routes.test.ts
  - server/src/__tests__/issue-title-generation.test.ts
  - ui/src/components/MessengerContextSidebar.actions.test.tsx
  - tests/e2e/messenger-chat-title-regenerate.spec.ts
edit_policy: user_confirmed_only
---

# Issue Title Generation

## ISSUE.TITLE.GENERATION.001

## Contract Summary

Rudder lets a board operator regenerate a split Issue title from the Messenger
thread actions menu by using the organization's `lightweight` Product
Intelligence profile, surfaced as Fast Intelligence. The generated title uses
bounded Issue context, preserves organization and actor boundaries, updates the
durable Issue, and refreshes the Issue and Messenger views without creating a
material workflow activity entry for a content-only change.

## Intent / User Job

Operators need a quick way to replace a vague or stale Issue title after the
description and discussion have clarified the work. They should not need to
copy Issue context into a separate prompt, and they need confidence that title
generation will not cross organization boundaries, expose unbounded comment
history, or leave Messenger and Issue Detail showing different titles.

## Why / Design Reasoning

Issue titles are high-frequency navigation labels. A title can be reasonable at
creation time and become inaccurate after comments narrow the scope. Manual
regeneration turns existing Issue context into a better navigation label while
leaving the structured Issue workflow, comments, and assignment state intact.

The feature is explicit rather than automatic. An operator chooses when the
current discussion is mature enough to summarize, and Rudder uses the
organization's configured Fast Intelligence instead of silently rewriting
titles after every Issue change. The prompt is bounded and prioritizes the
newest discussion so a long description cannot remove the most recent comment
evidence from the title-generation request.

## Actors / Objects / State

- Board operator: the user who chooses `Regenerate title`.
- Issue: the organization-scoped Issue whose `title`, `description`, and recent
  comments provide source context.
- Organization intelligence profile: the organization-scoped `lightweight`
  profile configured under `ORG.SETTINGS.001`.
- Product Intelligence invocation: runtime execution with
  `purpose: "lightweight"` and `feature: "issue_title"`.
- Messenger split-Issue row: the Issue thread and its actions menu in the
  Messenger sidebar.
- Issue caches: Issue detail by UUID/readable reference, organization Issue
  lists, and Messenger thread summaries.
- Live content event: `issue.content_updated` with
  `source: "title_regeneration"`, the new title, and the previous title.

## Entry Points / Inputs

- `POST /api/issues/:id/title/regenerate` for board-initiated regeneration.
- Messenger split-Issue `Thread actions`, which exposes `Regenerate title` only
  when the selected organization has a configured `lightweight` profile.
- Current Issue title.
- Non-empty comments among the latest 12 loaded Issue comments, requested
  newest first.
- Current Issue description when present.

## Product Logic Flow

1. The operator opens a split Issue's `Thread actions` menu in Messenger.
2. Rudder shows `Regenerate title` only when Fast Intelligence is configured
   for the selected organization.
3. On selection, the UI prevents a duplicate request for that Issue and shows a
   pending spinner in the menu item.
4. The server requires board access, loads the Issue, and verifies that the
   actor can access the Issue's actual organization before loading comments or
   invoking Product Intelligence.
5. Rudder builds a bounded prompt from the current title, the non-empty comments
   among the latest 12 loaded comments, and the description. Newest comments
   appear before the description so they survive shared source truncation
   first. Empty comments are filtered after the 12-row limit and are not
   backfilled with older comments.
6. Product Intelligence runs with the Issue organization, `lightweight`
   purpose, and `issue_title` feature.
7. Rudder accepts only a usable sanitized title: markdown/list prefixes,
   wrapping quotes, repeated whitespace, and trailing punctuation are removed,
   and the title is limited to 80 characters.
8. Rudder persists the title through the standard Issue update path, which also
   advances the Issue update timestamp. It publishes `issue.content_updated`
   when the title changed and returns the updated Issue.
9. The UI refreshes the Issue detail caches, Issue lists, and Messenger thread
   summaries so the new title is consistent across surfaces.

## Decision Table

| Case | Conditions | Product result | Must not happen | Evidence |
| --- | --- | --- | --- | --- |
| Regeneration succeeds | Board operator has Issue organization access; Fast Intelligence returns a usable title | Issue title persists; update timestamp advances; content update event includes regeneration source and previous title; Messenger and Issue caches refresh | Comments, description, status, ownership, or other Issue workflow/content fields must not change | Issue lifecycle route test, Messenger sidebar test, E2E |
| Fast Intelligence is not configured | Selected organization has no configured `lightweight` profile | Messenger hides `Regenerate title`; a direct request fails through Product Intelligence setup validation | UI must not offer an action that predictably cannot run | Messenger sidebar test and E2E |
| Runtime returns no usable title | Product Intelligence output is empty or sanitizes to empty | Request returns 422 and the existing title remains unchanged | Issue update or successful content event must not be written | Issue lifecycle route test |
| Actor is not board access | Agent-authenticated actor calls the endpoint | Request returns 403 before the Issue is loaded | Agent runtime must not use this operator-only mutation | Issue lifecycle authorization test |
| Board user lacks organization access | Authenticated board user cannot access the Issue organization | Request returns 403 before comments or Product Intelligence are loaded | Existence of Issue discussion or generated output must not cross the organization boundary | Issue lifecycle organization test |
| Description is larger than the source bound | Issue has a long description and a newest comment | Prompt is truncated while retaining the newest comment before description text | A long description must not remove all recent-comment evidence | Issue title generation service test |
| Generated title equals current title | Sanitized output does not change the title | Standard Issue update still advances `updatedAt` and may affect recency ordering; updated Issue is returned without publishing a false field-change event | Rudder must not claim a title field change that did not occur | Issue update detail comparison path |

## Actor-Visible Input

The operator supplies no separate prompt. The explicit menu selection authorizes
Rudder to summarize the Issue's current title, recent comments, and description
into a replacement title. The server reads at most 12 comments and applies the
shared 1,600-character title-source bound. Comments are requested and presented
newest first, before the description, so recent decisions have priority when
the context must be truncated.

Product Intelligence receives a concise instruction to return only title text,
without quotes, markdown, emoji, or trailing punctuation, and within the shared
80-character title limit.

## Operator-Visible Output

- Without configured Fast Intelligence, the split Issue menu has no
  `Regenerate title` action.
- While a request is running, the menu item is disabled and shows a spinner.
- On success, the Messenger row updates to the generated title; Issue Detail,
  including the heading and breadcrumb, receives the same persisted title when
  loaded or refreshed.
- On failure, the pending state ends and the existing Issue title remains
  unchanged. The current Messenger action does not provide dedicated visible
  error feedback; that is an implementation gap against `ISSUE.SURFACE.001`.

## Persisted Evidence

- The Issue `title` and update timestamp are the durable evidence of the
  regenerated value.
- Issue comments and description remain unchanged source evidence.
- A changed title emits the transient live signal `issue.content_updated` with
  the Issue and actor identity plus `details.title`,
  `details.source = "title_regeneration"`, and `details._previous.title`.
- The live signal is not persisted as a durable material `issue.updated`
  activity. Actor identity, previous title, and regeneration provenance expire
  with the live event and cannot be reconstructed from the Issue row alone.
- Product Intelligence invocation carries the Issue's organization-scoped
  runtime profile, `purpose: "lightweight"`, and `feature: "issue_title"`, but
  this contract does not claim that invocation metadata is durable Issue
  evidence.

## Canonical Scenarios

1. Operator improves a release Issue title:
   - Trigger: `Old release issue title` has a description and a recent comment
     emphasizing release proof and rollback readiness.
   - Expected state/action: Fast Intelligence returns
     `Release Proof and Rollback Readiness`; Rudder persists it.
   - Visible output: the Messenger row and Issue Detail show the new title.
   - Evidence: Messenger title regeneration E2E.

2. Regenerate remains hidden before setup:
   - Trigger: operator opens split Issue actions without a configured
     `lightweight` profile.
   - Expected state/action: no runtime request is offered or started.
   - Visible output: `Regenerate title` is absent.
   - Evidence: Messenger sidebar unit test and E2E.

3. Recent discussion survives a long description:
   - Trigger: Issue description exceeds the shared source limit and the newest
     comment contains the current decision.
   - Expected state/action: the bounded prompt retains the newest comment and
     truncates later description content.
   - Visible output: no separate truncation state is shown to the operator.
   - Evidence: Issue title generation service test.

## Invariants / Non-Goals

- Regeneration is board-only and organization-scoped.
- The Messenger action is shown only for split Issue threads and only when the
  selected organization has configured Fast Intelligence.
- The endpoint changes only the Issue title content field, but the standard
  Issue update timestamp advances and may affect recency-sorted views.
- Prompt source is bounded; no more than 12 comments are loaded, non-empty
  comments among those rows are used, newest comments have priority, and the
  shared source limit is 1,600 characters.
- Generated titles use the shared 80-character sanitizer.
- Missing or unusable output must not mutate the existing Issue.
- Content-only title changes publish a live content update rather than a
  material workflow activity.
- This contract does not add automatic Issue title generation, an Issue Detail
  regenerate control, or agent-authenticated regeneration.
- This contract does not own intelligence-profile setup, provider selection,
  secret resolution, or runtime fallback behavior.

## Drift Boundaries

Update this contract when changing:

- where Issue title regeneration is exposed
- board or organization permission requirements
- Fast Intelligence visibility or runtime routing
- source fields, comment count/order, prompt bounds, sanitization, or title
  length
- persisted Issue fields or content/activity event semantics
- pending, success, failure, or cache-refresh behavior in Messenger and Issue
  Detail

Code-only refactors that preserve these semantics do not require a product
contract update.

## Traceability

Related code:

- `server/src/routes/issues.mutations.ts`
- `server/src/services/issue-title-generation.ts`
- `server/src/services/issues.comments-attachments.ts`
- `server/src/services/title-generation.ts`
- `server/src/services/product-intelligence.ts`
- `server/src/services/organization-intelligence-profiles.ts`
- `ui/src/api/issues.ts`
- `ui/src/components/MessengerContextSidebar.tsx`
- `ui/src/lib/messenger-query-cache.ts`

Related tests:

- `server/src/__tests__/issue-lifecycle-routes.test.ts`
- `server/src/__tests__/issue-title-generation.test.ts`
- `ui/src/components/MessengerContextSidebar.actions.test.tsx`
- `tests/e2e/messenger-chat-title-regenerate.spec.ts`

Known gaps:

- Regeneration failures end the pending state and preserve the existing title,
  but the Messenger action does not currently show a dedicated toast or inline
  error. This does not yet satisfy the failed-mutation feedback rule in
  `ISSUE.SURFACE.001`.
- Regeneration provenance is transient. The Issue row stores the new title and
  update timestamp, but not the actor, previous title, or
  `source: "title_regeneration"` after the live event expires.
- Regeneration is currently exposed from the Messenger split-Issue menu, not
  from the standalone Issue Detail actions menu.
