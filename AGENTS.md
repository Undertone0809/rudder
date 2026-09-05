# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 0. Operating Contract

Use judgment appropriate to GPT-6 Astra. Optimize for a complete, verified
outcome within the user's authority; process is a means to that outcome.

- An action request authorizes investigation, scoped implementation, repair,
  verification, and the Git handoff in section 10. Read-only questions and
  requests for a plan or review alone do not authorize implementation.
- Carry forward the user's objective and authorization across retries, skill
  handoffs, status questions, and context compaction. Do not ask again merely
  because a workflow enters another stage.
- Resolve ordinary choices from repository context. Clarify only a material
  ambiguity about behavior, scope, authority, or irreversible consequences.
  Prepare the reviewable result first where possible, ask once, and continue
  independent work while waiting. Missing permission blocks its dependent
  action, not the entire task.
- Fix recoverable failures within scope. A failing test or reviewer finding is
  work to resolve, not a reason to hand the task back. Stop with a partial result
  only when a named external dependency or decision prevents useful progress.
- These project-wide rules own authorization, review depth, and completion.
  Maintainer skills supply specialized procedures; their templates and examples
  do not create additional universal gates. Preserve concrete safety constraints.
- Read canonical skills only. Historical `*-workspace/skill-snapshot*` copies
  are evaluation evidence, not competing instructions.

## 1. Purpose

Rudder is open-source software for assigning, running, reviewing, and improving agent work. It connects goals, tasks, knowledge, runs, reviews, budgets, and workflows so agents can work within clear boundaries, collaborate, and move work forward.
The current product behavior contract is the guarded Product Logic Registry in `doc/product/`.
The product north-star metric is the weekly count of real agent-work loops successfully completed through Rudder end-to-end.

## 1.1 Repository Identity

- This repository began as a Rudder fork/derivative of an early version of Paperclip. When renaming or rebranding internals, prefer compatibility-preserving changes for legacy `paperclip*` identifiers, config keys, and protocol values unless a deliberate breaking migration is planned.
- Treat the product description above as the current canonical short introduction when updating README, product docs, and onboarding copy.

## 2. Read This First

Read docs in layers instead of scanning the whole `doc/` tree.

Documentation folders have different audiences:

- `docs/` is the public website documentation. It is user-facing, use-case-led,
  and written for installation, onboarding, and product understanding.
- `doc/` is internal product, engineering, plans, and archive documentation for
  contributors working on Rudder itself.

When the task is to improve website docs, edit `docs/`. When the task is to
change contributor/product-development guidance, edit `doc/`.

For product behavior or architecture work, start here:

1. `doc/product/PRODUCT.md`
2. `doc/product/README.md`

For narrow docs, tooling, or skill edits, read the affected guidance and its
callers directly. Expand only when product behavior or another boundary is affected.

Then choose the route that matches the work:

- Desktop app, packaging, installer, local prod startup:
  - `doc/README.md`
  - `doc/engineering/DESKTOP.md`
  - `doc/engineering/DEVELOPING.md`
  - `desktop/scripts/smoke.mjs`
  - `scripts/prod-desktop.mjs`
- Server/runtime/database work:
  - `doc/README.md`
  - `doc/engineering/DEVELOPING.md`
  - `doc/engineering/DATABASE.md`
  - `doc/engineering/DEPLOYMENT-MODES.md`
  - relevant `doc/product/domains/**` contracts when behavior changes
- CLI/task-surface work:
  - `doc/README.md`
  - `doc/engineering/CLI.md`
  - relevant `doc/product/domains/issues/**`, `doc/product/domains/work-routing/**`, and `doc/product/domains/agents/**` contracts
- Visible UI or interaction design work:
  - `doc/README.md`
  - `doc/product/PRODUCT.md`
  - `doc/engineering/DESIGN.md`
  - relevant `doc/product/domains/**` contracts for user-visible behavior
- Release/publishing work:
  - `doc/README.md`
  - `doc/engineering/RELEASING.md`
  - `doc/engineering/PUBLISHING.md`
  - `doc/engineering/RELEASE-AUTOMATION-SETUP.md`
- Plugin work:
  - `doc/README.md`
  - `doc/engineering/PLUGIN_AUTHORING_GUIDE.md`
  - `doc/engineering/PLUGIN_RUNTIME_CONTRACT.md`
  - `doc/product/domains/plugins/**`

`doc/archive/` contains historical or superseded docs for archaeology. Do not use archived docs as current behavior contracts.
`doc/README.md` is the navigation hub for choosing the right doc route.

## 3. Repo Map

- `server/`: Express REST API and orchestration services
- `server/resources/bundled-skills/`: built-in Rudder runtime skills and their sibling reference docs
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `docs/`: public website documentation
- `doc/`: internal product, engineering, plans, and archive docs

## 4. Dev Setup (Auto DB)

Use embedded PostgreSQL in dev by leaving `DATABASE_URL` unset.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/orgs
```

Do not reset or delete an existing instance to diagnose startup. Preserve its
data; use the Desktop recovery skill or a disposable instance. Deleting user
data requires explicit authorization for that target.

## 4.1 Desktop Validation Workflow

For Desktop-specific work, development-shell verification is necessary but not sufficient.
Any change that can affect packaged boot, local profile isolation, startup migrations, installer assets, or prod-local data paths must run packaged verification before hand-off.

Preferred contributor workflow:

```sh
pnpm desktop:verify
```

Notes:

- `pnpm desktop:verify` runs:
  - `pnpm --filter @rudderhq/desktop smoke`
  - `pnpm desktop:dist`
  - `node desktop/scripts/smoke.mjs --mode=packaged`
- `pnpm prod` is a convenience command for humans. It builds the installer, verifies packaged boot, and opens the installer. Do not treat it as the only validation step while developing.
- If you touched Desktop startup, migrations, profile routing, or packaging, do not hand off after dev-shell checks alone.
- The Desktop CI workflow should continue to run packaged smoke after packaging, but local contributors must also run the packaged path before claiming the issue is done.

## 5. Core Engineering Rules

1. Keep changes organization-scoped.

Every domain entity should be scoped to a organization and organization boundaries must be enforced in routes/services.

1. Keep contracts synchronized.

If you change schema/API behavior, update all impacted layers:

- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

1. Preserve product invariants.

- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

1. Do not replace current product contracts wholesale unless asked.

Prefer additive updates. Keep `doc/product/**` as the current source of product truth. `doc/archive/**` is historical context only.

1. Keep bundled skill docs synchronized.

If you change a built-in Rudder skill under `server/resources/bundled-skills/<slug>/`, update the sibling `references/` docs and any contributor-facing docs that describe the bundled-skill location or behavior when they are affected. Do not leave `SKILL.md` content on a newer API contract than the docs that point to it.

1. Name repo-local development skills with a `maintainer` suffix.

Repository-based agent skills for local development, maintenance, release, debugging, preview, or operational workflows should use a `*-maintainer` name and directory under `.agents/skills/maintainer/` (for example `release-maintainer`, `stop-rudder-dev-maintainer`, or `pr-local-preview-maintainer`). Keep the directory name, `SKILL.md` frontmatter `name`, and any eval `skill_name` values synchronized.

1. Keep plan docs dated and centralized.

New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames. Plan docs must be written in English.
Persist a plan when the user requests one or when cross-module decisions need a
durable record. Ordinary implementation does not require a plan document. In
read-only plan mode, present the plan without writing files; persist it once
implementation is authorized if it remains useful.
New plan docs should start with the standard YAML frontmatter described in `doc/engineering/DEVELOPING.md`, use the most specific supported `kind`, and choose `area` / `entities` using `doc/plans/_taxonomy.md` plus relevant prior plans.

1. Treat `doc/product/` as the guarded Product Logic Registry.

`doc/product/` is the current product-behavior contract. Agents may read it at any time, but must not semantically edit `doc/product/**` unless the current user explicitly authorizes that edit or has approved a proposal/plan that includes the product doc delta.

Do not infer `doc/product/**` edit permission from implementation approval. User phrases such as "start", "proceed", "implement it", "fix it", "optimize it", "ship it", "add tests", "sync contracts", or similar task approval do not authorize guarded Product Logic Registry edits by themselves. Approval must explicitly mention updating `doc/product/**`, updating the Product Logic Contract/Registry, or approving a concrete product-doc delta.

When changing product logic, identify the affected contract IDs and run
`pnpm product-logic:check` before handoff. Distinguish restoring existing behavior
from changing the contract. A compatible fix needs no routine registry approval.

If a requested behavior needs a registry delta without edit authorization,
prepare the concrete proposed delta outside `doc/product/**`, complete independent
authorized implementation and verification, and ask once for that delta. Do not
edit the registry or claim the overall contract change complete while it remains
pending. An existing approval for that exact delta remains valid. Do not ask a
generic registry-sync question after every feature or ask again after approval.

1. Require end-to-end coverage for feature work.

New or changed user-visible workflows need automated E2E coverage. Reuse adequate
existing coverage; add or update cases for new behavior and regression risks.
When no suite exists, add a focused workflow test. Do not build a broad framework
for a small change. Copy-only, styling-only, docs, and skill edits do not require
new product E2E cases unless they change workflow behavior.
E2E coverage must exercise the real user-visible workflow plus the highest-risk corner cases for that workflow.
Do not stop at a happy-path fixture when the behavior depends on data volume, date windows, permissions, organization boundaries, persistence, async runtime state, database aggregation, or external-process results.
Include at least one representative edge case or production-shaped failure mode whenever that is where the implementation is likely to break.
If an edge case cannot reasonably be automated end-to-end, document the concrete
limitation and add the closest meaningful regression test. This does not replace
the primary workflow E2E or any required real-environment acceptance.

## 5.1 Release And Deployment Authorization

Implementation authority is not release authority. Treat local implementation,
branch push/PR, shared staging, stable publication, and production deployment as
separate transitions.

- `start`, `continue`, `proceed`, `implement`, `finish`, or approval of a plan
  authorizes implementation, verification, and the section 10 Git handoff. The default stopping point
  is Review Ready: validated changes committed and pushed on the current branch,
  a PR when appropriate, review evidence, and a release-risk summary.
- An explicit imperative to release a Rudder version, such as `release vX.Y.Z`,
  `ship this version`, or `发版`, authorizes the complete standard release
  lifecycle when the conversation identifies that version release as the target.
  Publishing only named docs, a package, or another surface stays limited to
  that surface. A bare `publish` is interpreted from context, not as automatic
  authority for every release target. The version lifecycle includes committing
  and pushing the reviewed source directly
  to `main`, running CI and the release dry-run, publishing npm/GitHub/Desktop/
  production-docs surfaces, verifying them, cleaning obsolete canary
  Releases/tags, and completing the direct next-version handoff. Do not create a
  release PR or ask for another authorization during this lifecycle.
- If the release request omits a version, infer the single consistent target
  from the current release context and repository release scripts, lock its
  source SHA, and state both in a progress update. Ask only when the channel,
  version, source, or target is genuinely ambiguous.
- Automatic branch previews are review surfaces only. Do not promote them or
  assign shared aliases unless they are part of an explicit release/publish
  request.
- Machine validation remains mandatory: the exact `main` source must pass CI,
  stable preflight, immutable-version checks, and public-surface verification.
  Diagnose and repair failed gates within scope. Missing platform access,
  credentials, permissions, or a material target decision can block publication;
  preserve a partial receipt and complete independent work before handoff.
- Destructive or nonstandard operations still require separate authority:
  unpublishing npm versions, force-pushing or retargeting published tags,
  deleting the active canary line, or expanding beyond the requested
  product/environment.
- Before the real publish, report the exact commit/tag and target, completed
  checks, unresolved failures, migration or data impact, and rollback point as
  a status update—not as another approval request. Release only that locked,
  reviewed source and verify every public surface.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

1. Validate compile:

```sh
pnpm -r typecheck
```

Notes:

- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. Verification Before Hand-off

Choose checks by the changed surface and explain material omissions:

- Docs and instruction-only changes: check the diff, links/frontmatter, relevant
  validators, and representative instruction scenarios. No product build or
  browser ceremony is needed for a claim confined to those artifacts.
- Localized code changes: run focused tests, affected-package typechecks, and
  lint/build checks that can expose the changed behavior.
- Shared contracts, runtime, dependencies, cross-package changes, and releases:
  run the full repository baseline below, plus applicable task-specific checks.

Full repository baseline:

```sh
pnpm lint
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

Use scoped formatting/import fixes; avoid whole-repository `lint:fix` churn in a
shared dirty checkout. Do not repeat passing checks without a relevant change,
failure, or unresolved risk. Attribute unrelated baseline failures explicitly.

Task-specific additions:

- Changes affecting packaged boot, profiles, migrations, packaging, or installed behavior:
  - `pnpm desktop:verify`
- Feature work or workflow changes:
  - apply section 5's E2E coverage rule: reuse adequate existing coverage, or add/update the cases needed for changed behavior
  - run the relevant E2E suite (`pnpm test:e2e`, `pnpm test:release-smoke`, or another feature-specific E2E path) when that area is affected
- Visible UI changes:
  - verify the rendered result in a browser or desktop shell, not just by tests
  - use `$ego-browser` by default; when it is unavailable or unsuitable, use an authorized available alternative and explain the reason
  - store temporary screenshots and other ad-hoc verification artifacts outside the repository tree (for example under `/tmp` or the system temp dir), not in the project root

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other organizations

When adding endpoints:

- apply organization access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use organization selection context for organization-scoped pages
- Surface failures clearly; do not silently ignore API errors
- Follow `doc/engineering/DESIGN.md` for visible UI defaults, especially density, hierarchy, dialog structure, copy style, and progressive disclosure
- Before implementing a multi-step UI, add a compact state inventory to the acceptance packet: current decision, visible and deferred controls, safety-critical context, focal action or peer choice set, and Back/Cancel/Close/Reopen/draft-restoration semantics. Each state should present one primary decision and defer later-step controls until relevant.
- For desktop-shell UI changes, preserve the `Desktop Shell` contract and review checklist in `doc/engineering/DESIGN.md`; do not revert the shell to raw-wallpaper transparency or push glass treatment into the work cards.
- For visible UI changes, verify the rendered result before hand-off using a browser, screenshot, or equivalent visual inspection. Do not rely on code review, typecheck, or tests alone for layout-sensitive changes.
- If a change affects user-visible functionality, include the relevant final screenshots in the hand-off response so the reviewer can see the shipped result, not just read about it.

## 9.1 Review And Verification Depth

Choose independent review by risk, not task length. Use
`.agents/skills/maintainer/agent-work-reviewer-maintainer` for first-principles,
functional, adversarial, product-taste, and evidence-integrity review. Use
`.agents/skills/maintainer/product-acceptance-verifier-maintainer` for read-only
black-box acceptance in the real local or otherwise named terminal environment.

- Mechanical edits: self-review and relevant checks are sufficient.
- Bounded docs, skills, tooling, and localized low-risk fixes: use one independent
  review when it adds confidence. Verify the actual artifact; a product runtime,
  organization identity, or delivery packet is not required for unrelated claims.
- User-visible workflows, security/organization boundaries, persistence/migrations,
  agent execution, Desktop startup/packaging, releases, and shared-state integration:
  use distinct reviewer and verifier agents with the gate order below.
- Use subagents within the current task. Do not create user-visible tasks without
  an explicit request. Keep delegation bounded; routine tasks may use `luna_worker`
  with `gpt-5.6-luna` / `max`, while complex judgment may use the selected model.

For the high-risk path, the gate order is:

1. Before acceptance testing, the reviewer returns a stage verdict on intent,
   implementation, product taste, risk, and the proposed acceptance packet.
2. Resolve blocking review findings, then freeze the final candidate and record
   its SHA or dirty diff fingerprint, build/runtime identity,
   organization/data identity, and acceptance packet.
3. The verifier exercises the real public workflow and returns terminal
   `PASS`, `FAIL`, or `QUESTION` for that exact candidate.
4. Only after verifier `PASS`, the reviewer runs a final round, reads the
   verifier evidence, inspects the exact candidate, and returns a final handoff
   verdict.
5. Publish the commit and push only after reviewer `accept` and verifier `PASS`
   both apply to the same candidate. A local checkpoint commit is allowed before
   acceptance to create an immutable candidate; it is not a completion claim.

`FAIL`, `QUESTION`, `needs more evidence`, and `reject` block the affected
acceptance or publication claim. Non-blocking suggestions belong under `accept`,
not `conditional accept`. Resolve findings locally and rerun affected checks.
Invalidate observations when relevant behavior, build, runtime, data, or criteria
change; unrelated dirty files and a new commit ID with identical tested content
do not alone require replay. Record content equivalence and recheck Git/CI identity
where required. The parent must read and reconcile every terminal verdict.

For visible UI changes, the reviewer must inspect current rendered evidence
against `doc/engineering/DESIGN.md`, including cognitive load and decision
sequencing. The verifier must black-box the primary journey plus the highest-risk
decision-flow, content, async, interaction, continuity, viewport, and theme
states. Include current final screenshots in the handoff.

When a required agent is unavailable, complete independent preparation and
report the missing gate. Do not relabel self-review as independent acceptance.

## 10. Definition of Done

A change is done when all are true:

1. The requested result exists and has been verified at the level claimed.
2. Applicable checks and section 9.1 review gates pass; material limits are explicit.
3. Affected code/API contracts and documentation agree. A pending guarded product
   delta is reported as pending, not as a completed contract change.
4. UI changes include current screenshots; other artifacts include useful evidence.
5. The authorized Git handoff is complete, or a concrete external blocker is reported.

- After scoped edits and applicable validation, commit and push the task's changes
  to the current remote branch, including instruction/doc fixes. This standing
  authority does not authorize merging another branch, release, or deployment.
  Honor a user request for local-only work or no commit/push.
- Continue using the repository's Conventional Commit format for commit messages (for example `feat:`, `fix:`, `test:`, `chore:`, `pref:`).
- Preserve unrelated worktree and staged changes. Inspect the index immediately
  before committing and include only this task's changes; use an isolated index
  or checkout if needed. Do not ask just because unrelated work is dirty.
- Do not create an empty commit for read-only work or retry a rejected push
  unchanged. Resolve recoverable Git issues within scope, and report the exact
  committed/pushed state when external access or another concrete gate blocks it.
