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
- A Goal Contract turns that durable reason into an accountable, evidence-backed
  commitment that can be planned, continued, evaluated, and reviewed.

Product model:

- Goals belong to one organization.
- A canonical Goal starts as a Draft with no implicit Owner or hierarchy. Its
  Contract declares the outcome, objective mode, criteria, autonomy envelope,
  human authorities, evaluation policy, and relevant deadlines.
- Activation assigns exactly one same-organization Agent Owner, creates the
  initial Plan and continuation, and records the Contract revision.
- Plans are mutable revisions; Activity is append-only and carries the owner,
  commitment, Run, and evidence references available at submission time.
- Terminal Proof is derived from the required evidence references and the
  declared evaluator. Criteria use one of four evaluator kinds: `artifact`
  requires evidence references, `metric` requires an observed `resultValue`,
  `policy` requires evidence references, and `human` requires a decision or
  explicit human approval in the result payload. Any declared
  `evidenceRequirements` must match submitted evidence references. Every
  declared criterion is evaluated independently; omitted or evidence-invalid
  criteria become `unknown`, and a positive Proof requires every criterion to
  be `met` plus the mode-specific value (`resultValue` for `maximize`, or
  `decision` for `decide`). `target` yields `achieved` only when all criteria
  are met and `not_achieved` when one fails; `maintain` yields `maintained` only
  when all criteria are met and `breached` when one breaches; incomplete
  `maximize`/`decide` evaluations remain `inconclusive`.
- Users and Agents cannot produce a terminal result by patching a legacy status
  field. Board users act as operators; an Agent API key may issue Goal commands
  only for the current Goal Owner, and an Agent may activate only with itself as
  Owner.
- Legacy `level`, `status`, and `parentId` columns remain readable for existing
  project, issue, and dependency links. They do not create a new Goal hierarchy,
  implicit root Goal, or parent/child scheduler for canonical Goals.
- During migration, every legacy `active` row is returned to Draft. A row that
  already has a complete Contract and Owner may retain compatibility fields
  such as a continuation hint, but it still requires explicit activation to
  create the canonical Plan and Owner assignment before receiving commands.
  Contract, Plan, Owner, Activity, and Proof state is database-backed and must
  survive API process restart without changing lifecycle or continuation.
- A goal description is durable Markdown and follows
  `MARKDOWN.DOCUMENT.LIVE.PREVIEW.001` in create and detail authoring surfaces.
  Full description views render Markdown; compact list/search summaries may
  flatten it to plain text.
- Deleting a goal is blocked when dependent projects, issues, automations, or
  legacy child Goals, or other linked work still rely on it, and canonical Goals
  must be in Draft before deletion.

Flow:

1. Board creates a Draft Goal in Goals UI or API.
2. Board or an authorized Agent activates a complete Contract with an explicit
   same-organization Owner, initial Plan, and continuation.
3. Owner and authorized actors revise the Plan, append Activity, set Focus, and
   submit evidence through the command APIs.
4. Goal Detail exposes Contract, Plan, Owner and continuation, Activity, Proof,
   and linked dependency previews where available.
5. Before deletion, dependency preview/check prevents accidental loss of the
   work loop's reason.

Invariants:

- Canonical Goal lifecycle changes occur through activation, Plan, Activity,
  Owner, Focus, and evaluation commands; direct terminal status writes are
  rejected.
- Positive evaluator outcomes are impossible when any criterion is unmet,
  breached, or unknown; a mode-specific payload is also required where the mode
  declares one.
- Owner assignment and all Goal-linked records remain organization-scoped.
- Focus has at most one active Goal per organization.
- A terminal Run can produce at most one closeout Activity for a Goal/Run pair,
  and idempotent Activity retries do not duplicate effects.
- Goal deletion must not silently detach existing work from its rationale.
- Rendering or focusing a Goal description must not normalize its non-empty
  Markdown source.

Evidence:

- Goal Detail lifecycle E2E covers Draft activation, persistence, denial cases,
  organization boundaries, Owner command authority, Plan/Activity/Focus, Run
  closeout, idempotency, restart continuity, contradictory multi-criterion
  evaluation, and all objective modes.
- Contract, Plan, Owner, continuation, Activity, Proof, and linked-work
  surfaces show the Goal's downstream work.

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
