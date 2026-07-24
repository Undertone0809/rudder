---
title: Goals And Projects
domain: organizations-and-goals
status: active
coverage: detailed
contract_ids:
  - ORG.GOAL.001
  - ORG.PROJECT.001
related_code:
  - packages/db/src/schema/goals.ts
  - packages/db/src/schema/project_goals.ts
  - packages/db/src/schema/projects.ts
  - server/src/routes/goals.ts
  - server/src/services/goals.ts
  - server/src/routes/projects.ts
  - server/src/services/projects.ts
  - ui/src/pages/Goals.tsx
  - ui/src/pages/GoalDetail.tsx
  - ui/src/pages/ProjectDetail.tsx
related_tests:
  - tests/e2e/goal-detail-lifecycle.spec.ts
  - server/src/__tests__/projects-service.test.ts
  - server/src/__tests__/project-routes.test.ts
edit_policy: user_confirmed_only
---

# Goals And Projects

## ORG.GOAL.001

Why:

- A goal is the durable "why" for agent work. Without it, tasks become a queue
  with no compounding product memory.
- Goal hierarchy lets the organization mission connect to project, team, agent,
  and task-level work without forcing every Chat or issue to duplicate strategy text.

Product model:

- Goals belong to one organization.
- A goal has level, status, optional parent, optional owner agent, and linked
  work.
- A goal description is durable Markdown and follows
  `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` in create and detail authoring surfaces.
  Full description views render Markdown; compact list/search summaries may
  flatten it to plain text.
- A valid organization has at least one root organization-level goal.
- Parent goals must be in the same organization and must not form a cycle.
- Deleting a goal is blocked when dependent projects, issues, automations, or
  other linked work still rely on it.

Flow:

1. Board creates or edits a goal in Goals UI or API.
2. Server validates organization boundary, parent cycle, owner, and status.
3. Linked work is exposed on Goal Detail: sub-goals, projects, issues,
   automations, costs, and activity where available.
4. Before deletion, dependency preview/check prevents accidental loss of the
   work loop's reason.

Invariants:

- Goal hierarchy cannot cross organizations or cycle.
- Goal deletion must not silently detach existing work from its rationale.
- Rendering or focusing a Goal description must not normalize its non-empty
  Markdown source.

Evidence:

- Goal Detail lifecycle E2E covers create/edit/status/delete paths.
- Activity and linked-work surfaces show the goal's downstream work.

## ORG.PROJECT.001

Why:

- Projects are the practical grouping boundary between abstract goals and
  execution objects. They collect chats, issues, resources, workspaces, lead
  agents, and timelines for one line of work.

Product model:

- A project belongs to one organization.
- A project may link to multiple goals while preserving legacy single-goal
  compatibility where code still carries `goalId`.
- Projects have status, target date, lead agent, URL/shortname identity, visual
  metadata, resources, workspaces, chats, and issues.
- A project description is durable Markdown and follows
  `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` in create and detail/configuration
  authoring surfaces. Full description views render Markdown; compact
  list/search summaries may flatten it to plain text.
- Creating a project can initialize the project's Library layout so resources
  and outputs have a stable place.

Flow:

1. Board creates project with name, status, goal links, and optional lead agent.
2. Server validates organization boundary, unique route keys, goal links, and
   lead agent.
3. Project detail exposes resources, workspaces, issues, and goal context.
4. Issue creation or update can attach work to the project and inherit project
   context for agent runs.

Invariants:

- Project identity must stay organization-scoped and URL-stable.
- Project goal links must not imply execution state; chat, issue, and automation
  contracts still own work progress.
- Rendering or focusing a Project description must not normalize its non-empty
  Markdown source.

Evidence:

- Project service/route tests cover project identity and goal linkage.
- Project Detail UI exposes resources/workspaces as project context.
