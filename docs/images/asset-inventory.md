# Documentation Screenshot Asset Inventory

Most screenshots use English product content from the `mock-data-maintainer`
landing demo org. Flow diagrams are documentation-owned assets, and a few
Desktop shell screenshots may intentionally use user-approved production-like
data when they better explain the product. Refresh the generated screenshot set
with `pnpm landing:shots`, review `/tmp/rudder-landing-proof-shots/shots`, then
copy the matching files into this directory.

| File | Purpose | Suggested reference page | Desktop/mobile crop notes |
| --- | --- | --- | --- |
| `board-overview.png` | Dashboard overview with active agents and English issue summaries. | `docs/index.mdx`, `docs/concepts/overview.mdx` | Desktop 1440 x 960. Keep the left rail and full agent grid visible. |
| `issue-flow.png` | Issue tracker list with projects, statuses, assignees, and dates. | `docs/index.mdx`, `docs/concepts/issues.mdx`, `docs/concepts/goals-projects-issues.mdx` | Desktop 1440 x 960. Do not crop the left project slices or status column. |
| `mobile-dashboard.png` | Mobile dashboard with English agent cards and bottom navigation. | Responsive/mobile docs callouts when needed. | Mobile 780 x 1688. Preserve the header, first two cards, and bottom navigation. |
| `organization-work.png` | Organization workspaces surface with managed paths and resources. | `docs/get-started/first-organization.mdx` | Desktop 1440 x 960. Keep both workspace and resource columns visible. |
| `first-organization-loop-zh.svg` | Chinese onboarding flow diagram for the first useful Rudder work loop. | `docs/zh/get-started/first-organization.mdx` | Vector diagram. Keep the loop readable at docs content width. |
| `skills-library.png` | Organization skills library and skill detail view. | `docs/concepts/skills.mdx` | Desktop 1440 x 960. Keep the org nav, skills list, and selected skill detail in frame. |
| `agent-detail.png` | Agent skills tab showing personal skill management for one agent. | `docs/concepts/skills.mdx` | Desktop 1440 x 960. Keep agent navigation and the skills management view visible. |
| `agent-run-detail.png` | Agent run detail with persisted transcript and run evidence. | `docs/get-started/first-organization.mdx` | Desktop 1440 x 960. Keep the run list and selected transcript pane visible. |
| `messenger-approvals.png` | Messenger attention surface with pending decision, linked work context, and thread list. | `docs/concepts/messenger.mdx` | Desktop 1440 x 960. Keep thread list, decision body, and right context panel visible. |
| `chat-create-issue-proposal.png` | Chat intake thread showing a reviewable issue proposal before execution. | `docs/concepts/chat.mdx`, `docs/get-started/first-organization.mdx` | Desktop crop from the Messenger chat surface. Keep the proposal block and composer context visible. |
| `calendar-work-history.png` | Calendar view over agent run history and human checkpoints. | `docs/concepts/calendar.mdx`, `docs/get-started/first-organization.mdx` | Desktop 1440 x 960. Keep the week grid, dense run blocks, and source filters visible. |
| `workspaces-resources.png` | Workspaces and resources view focused on injected project inputs and durable output paths. | `docs/concepts/workspaces.mdx` | Desktop 1440 x 960. Keep both workspaces and resources panels visible. |
| `installation-cli.png` | Installation and CLI terminal workflow. | `docs/get-started/installation.mdx` | Desktop 1440 x 960. Terminal and setup checklist should remain readable together. |
| `cost-visibility.png` | Cost visibility dashboard with budget guardrails and provider breakdown. | `docs/concepts/overview.mdx` or future budget/cost page. | Desktop 1440 x 960. Keep metric cards, trend chart, and guardrail panel visible. |
