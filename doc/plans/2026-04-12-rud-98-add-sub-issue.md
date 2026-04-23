# RUD-98: Move Sub-Issues Into Main Issue Detail Layout

## Summary

The feature should not live behind a dedicated `Sub-issues` tab. The issue detail page should treat sub-issues as first-class issue structure, not as alternate content alongside comments and activity.

Update the issue layout to follow the Linear-like model the user referenced:

- keep the issue title/description as the main top content
- render a `Sub-issues` section directly in the main body, above documents and above the chat/activity area
- keep `Chat` and `Activity` as the remaining bottom tabs
- add the creation affordance inside that inline `Sub-issues` section, not in a separate tab

## Key Changes

1. Issue detail information architecture
- Remove the `Sub-issues` tab from `ui/src/pages/IssueDetail.tsx`.
- Keep only `Comments` and `Activity` tabs, but rename the presentation to match the current bottom interaction shell if needed (`Chat`/`Activity`) without changing underlying comment behavior.
- Insert a new inline `Sub-issues` section in the main content column after the issue description/plugins and before `IssueDocumentsSection`.
- The section should read like structural issue content, not like a secondary panel or oversized card.

2. Sub-issues section layout
- Add a compact section header row with:
  - `Sub-issues` label
  - child count
  - `Add sub-issue` action on the right
- Render the child issues as a dense inline list/table beneath the header.
- Match the existing issue-detail tone from `doc/DESIGN.md`: quiet borders, compact row height, low-chrome controls, no decorative empty-state card.
- Keep the list always visible in-page; no dedicated tab and no large surface switch.

3. Add sub-issue interaction
- Recommended interaction: lightweight inline creation anchored in the `Sub-issues` section.
- Clicking `Add sub-issue` reveals a compact composer at the top of the list:
  - title input
  - `Create`
  - `Cancel`
  - keyboard support: `Enter` submit, `Escape` cancel
- Create via `issuesApi.create` with `parentId: issue.id`.
- Do not inherit parent project/goal/assignee/status/priority. Chosen default remains `Parent Only`.
- On success:
  - collapse/clear composer
  - invalidate issue detail/list queries
  - show the new child immediately in the inline sub-issue list

4. Creation plumbing
- Extend `ui/src/context/DialogContext.tsx` `NewIssueDefaults` with `parentId?: string`.
- Update `ui/src/components/NewIssueDialog.tsx` to pass `parentId` through on submit.
- This is mainly to keep parent-aware creation consistent and reusable, even if the primary issue-detail flow uses inline creation.

## API / Interface Changes

- Internal UI change: `NewIssueDefaults` gains `parentId?: string`.
- No backend API, DB schema, or shared validator changes required.

## Test Plan

Add or update E2E coverage for the new layout and flow.

Required scenarios:

- Issue detail no longer shows a `Sub-issues` tab.
- A `Sub-issues` section appears in the main page body above documents and above the bottom comment/activity area.
- From an issue with no children, `Add sub-issue` is visible and opens the inline composer.
- Creating a sub-issue inline renders the new child immediately in the section without navigation.
- The created child is linked correctly with `parentId === parent.id`.
- Canceling inline creation closes the composer without creating anything.
- Existing comments/activity behavior still works after the layout change.

Suggested test file:
- `tests/e2e/issue-detail-subissues.spec.ts`

## Assumptions

- “参考 Linear 的布局” means sub-issues should be part of the main issue body, not tabbed secondary content.
- The section should be positioned above documents, since sub-issues are structurally closer to the issue itself than attached artifacts.
- Scope is limited to issue detail page layout and sub-issue creation UX; no change to issue list pages or project pages.
