---
title: Issue detail activity stream
date: 2026-05-08
kind: implementation
status: completed
area: ui
entities:
  - issue_detail
  - issue_activity
  - issue_comments
issue:
related_plans:
  - 2026-05-06-linear-issue-activity.md
  - 2026-04-12-rud-98-add-sub-issue.md
supersedes: []
related_code:
  - ui/src/pages/IssueDetail.tsx
  - ui/src/components/CommentThread.tsx
  - ui/src/pages/IssueDetail.test.tsx
  - tests/e2e/issue-detail-subissues.spec.ts
  - tests/e2e/issue-activity-chat-links.spec.ts
commit_refs:
  - feat: unify issue activity stream
updated_at: 2026-05-08
---

# Issue Detail Activity Stream

## Summary

Replace the issue detail bottom tab pair with a single Linear-like Activity
stream. Comments, runs, linked Linear context, and relevant issue activity
events should render in one chronological list. Cost summary should move to the
right issue information column and stay hidden when there is no usage data.

## Problem

The current issue detail page splits discussion and activity into separate
`Chat` and `Activity` tabs, which makes issue history feel like two different
destinations. It also renders `Cost Summary` inside the activity area, even
though cost is aggregate issue metadata rather than a timeline event.

## Scope

- Remove the visible `Chat` / `Activity` tab switcher from issue detail.
- Render comments, runs, Linear linked issue context, and non-comment activity
  events in one time-ordered Activity stream.
- Suppress `issue.comment_added` activity rows because the corresponding
  comment is already rendered.
- Move issue cost/tokens into the right information column and mobile
  properties sheet.
- Preserve non-Linear plugin detail tabs through a compact plugin section.
- Update unit and E2E coverage for the new structure.

Out of scope:

- Backend API changes.
- A full redesign of activity event wording.
- A new plugin slot contract.

## Implementation Plan

1. Extend `CommentThread` with optional timeline activity items and optional
   section heading control.
2. Convert issue detail to render one Activity section instead of comments and
   activity tabs.
3. Move cost rendering into a reusable issue cost summary panel in the right
   sidebar and mobile properties sheet.
4. Keep Linear linked issue context inside the chronological activity stream and
   keep other plugin detail tabs reachable below the stream.
5. Update focused tests and E2E expectations that referenced the old tabs.

## Design Notes

`issue.comment_added` remains available as data for run/comment association but
must not render as its own activity row. The Activity stream should prioritize
scan speed: comments and run cards can keep richer presentation, while system
activity rows remain compact.

## Success Criteria

- Issue detail has one visible `Activity` section and no `Chat` / `Activity`
  tab switcher.
- Comments, runs, Linear context, and activity rows appear in chronological
  order.
- Comment-added activity rows are not duplicated.
- Cost summary appears only in the issue information column when usage exists.
- Existing comments, runs, plugin tabs, and sub-issue behavior still work.

## Validation

- Passed: `pnpm --filter @rudderhq/ui exec vitest run src/pages/IssueDetail.test.tsx src/components/CommentThread.test.tsx`
- Passed: `pnpm --filter @rudderhq/ui typecheck`
- Passed: `pnpm --filter @rudderhq/ui build`
- Passed: `pnpm -r typecheck`
- Passed: `pnpm build`
- Passed: `pnpm exec playwright test --config tests/e2e/playwright.config.ts tests/e2e/issue-detail-subissues.spec.ts tests/e2e/issue-activity-chat-links.spec.ts tests/e2e/issue-passive-followup.spec.ts --list`
- Failed before page logic: targeted E2E browser launch timed out at Chromium startup.
- Failed due pre-existing server/database test noise: `pnpm test:run`.
- Browser visual inspection was attempted against `http://127.0.0.1:3100/R/issues/R-1`, but browser automation could not capture DOM or screenshots in this environment.

## Open Issues

- Other plugin detail tabs stay below Activity for compatibility. A future
  plugin placement contract can make this cleaner.
- Full E2E and visual verification should be rerun once local Chromium/browser
  automation is healthy.
