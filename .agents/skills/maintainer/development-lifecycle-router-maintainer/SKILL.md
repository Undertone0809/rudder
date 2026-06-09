---
name: development-lifecycle-router-maintainer
description: >
  Route Rudder development work when a request is ambiguous or spans lifecycle
  stages: requirements, advisor/product analysis, UI design, implementation,
  verification, review, commit/push, and handoff. Use for stage selection,
  reviewer gates, aborted-run recovery, component-lab work, public-docs content
  structure, scoped performance optimization, skill-improvement routing, and
  risky dirty-worktree cleanup. Keep thin: if the prompt clearly names release,
  UI polish, run/debug, local preview, data path, Desktop recovery, PR preview,
  mock data, review-only work, or direct skill optimization, use the narrower
  maintainer or meta-skill directly.
---

# Development Lifecycle Router Maintainer

This skill is the routing layer for Rudder development work. It decides which
stage the user is entering, selects the right downstream skill or normal coding
workflow, defines the stage exit criteria, and adds review gates when needed.
By default, every routed development stage should end with a review gate before
handoff or before moving to the next consequential stage.

It should stay thin. Do not copy the full logic of advisor, reviewer, UI,
release, debug, or preview skills into this file. Route to those skills and
follow their contracts.

## When To Use

Use this skill when the user asks for any of:

- an end-to-end development workflow from requirement to implementation,
  testing, review, and handoff
- a general "which skill/workflow should handle this?" decision
- lifecycle routing when the user may enter from requirements, UI design,
  implementation, testing, CI, release, debug, or review
- stage-by-stage reviewer gates, reviewer subagents, or "review after every
  phase"
- repair of a previous agent run where the failure was weak routing, skipped
  review, wrong stage, or premature implementation
- continuation after `turn_aborted`, rollback, stash/worktree confusion, or a
  long `/goal` run where the agent must recover the real current state before
  resuming
- destructive or ambiguous worktree cleanup requests such as "这些删了", "what are
  these changes", or "is this old Codex work" where file ownership must be
  reconstructed before removing or restoring anything
- component lab, UI Lab, component inventory, or design-system catalog work that
  needs fixture coverage, context-required classification, browser proof, and
  E2E rather than a small visual polish pass
- performance benchmark or control-plane optimization work that must start from
  measured workload evidence and a scoped first slice before implementation
- agent-runtime, provider-adapter, transcript-parser, tool-call, or skill-usage
  contract work that must prove the same Rudder work loop across multiple agent
  runtimes before handoff
- public docs content-structure, Mintlify page behavior, sidebar/TOC,
  navigation, changelog, or docs information-architecture work where the route
  must distinguish `docs/` page edits from app UI polish, release, or internal
  `doc/` contributor guidance
- creating or improving a reusable workflow for development tasks
- deciding whether a named maintainer skill should be optimized, when the user
  is not already explicitly asking to run `skill-optimizer`

Do not use this skill as a substitute for a clearly matched narrow skill. If
the user asks only to release, debug a run, review a Codex session, preview a
PR, seed mock data, polish a screenshot, stop dev processes, or optimize a
named skill, use the specialized skill or meta-skill directly.

## Non-Use Gate

Before taking ownership, ask whether the prompt already has a narrow owner.
This router should only stay active when it adds value by choosing a stage,
resolving ambiguity, sequencing multiple stages, or protecting a high-risk
handoff.

Use the narrow skill directly when all of these are true:

- the user names a concrete surface, run, PR, release, screenshot, data path, or
  local runtime problem
- the next useful artifact is obvious for that surface
- the task does not need cross-stage planning, reviewer orchestration, or
  destructive recovery judgment before the narrow work can begin

When the narrow route is clear, state the route in one sentence and then follow
the downstream skill. Do not expand a lifecycle plan just because this router is
available.

Keep only these cases in the router:

- the user asks which workflow or skill should handle the work
- the request combines multiple stages and the earliest blocking stage is not
  obvious
- the task needs sequencing from requirements to implementation, verification,
  review, commit, and handoff
- the worktree or prior-session state must be reconstructed before any safe
  edit, cleanup, or handoff

### Meta-Request Precedence

User instructions about the conversation, the agent workflow, or a named skill
take precedence over task details embedded in screenshots, transcripts, quoted
logs, or pasted prior messages.

When the user says a skill "needs optimization", "should be hardened", "always
does the wrong thing", "I have to ask this every time", or explicitly asks to
use `skill-optimizer`, classify the turn as skill optimization. In that case:

- route to `skill-optimizer` as the primary owner
- treat the named skill as the target artifact, not as the workflow to execute
- treat screenshots, session ids, prior assistant messages, and linked skills
  inside the evidence as failure evidence, not as current routing candidates
- extract the failed decision point before patching the target skill
- add or update a validation case for the next-run behavior that should change

Example: if the user says "you need to optimize this router with
skill-optimizer" and attaches a screenshot where the prior assistant proposed
`imagegen-frontend-web`, `redesign-existing-projects`, and this router, the
route is `skill_optimization -> skill-optimizer`. Do not generate UI mockups or
recommend the design skills unless the user separately asks to continue the UI
task.

## Core Rule

Route first, then execute.

Before editing files, running long validation, spawning reviewers, or committing,
state the lifecycle stage and the acceptance bar for leaving that stage. The
router fails when it silently jumps from a user complaint to implementation, or
when it claims review happened without real reviewer evidence.

The object being protected is not the diff, test suite, screenshot, or review
artifact by itself. The object is the Rudder work loop the change is supposed to
improve: an operator or agent acts, Rudder records and routes the work, the
right surface shows the result, and the next actor can trust what happened.
When those terminal effects are cheap to exercise, they are required evidence,
not optional polish.

Default to review with real spawned reviewers. Do not use self-review or a
serial two-role simulation as a substitute for the reviewer gate; those modes
overfit to the author's own reasoning and cannot close a routed stage as
complete.

When reviewer spawning is available, run it by default after each stage artifact
exists. Do not wait for the user to ask for subagents; this skill is the user's
standing instruction that routed development work needs independent reviewer
agents.

When the user explicitly names, links, or pastes this
`development-lifecycle-router-maintainer` skill, treat that as an explicit
request for this skill's reviewer-subagent policy. Do not reinterpret the same
turn as "no explicit subagent request" unless the active spawn tool itself
rejects the call after a real availability probe.

If the active runtime truly cannot spawn reviewers, mark the review gate as
`blocked: spawned reviewers unavailable`. You may still provide the stage
artifact and local validation evidence, but do not claim the routed stage is
complete, do not call the review passed, and do not hand off as done until real
spawned reviewer evidence exists or the user explicitly changes this policy.

## Stage Classifier

Classify the prompt into one primary stage:

- `intake`: user intent, target artifact, and mode are unclear.
- `requirements`: user wants problem framing, scenarios, acceptance criteria,
  or "do you understand?"
- `advisor`: the current build, UI, workflow, trace, or proposal feels wrong and
  needs first-principles diagnosis.
- `ui_design`: user asks for interface direction, wireframe, visual hierarchy,
  or screenshot-based product/design judgment before code.
- `implementation`: user approved a direction or directly asks to fix/build.
- `verification`: user asks whether tests, CI, E2E, screenshot, Desktop smoke,
  actor-run-chain, or release checks prove the work.
- `review`: user asks for review, PM judgment, first-principles critique, or a
  Codex/session/PR/commit verdict.
- `debug`: user asks why a run, UI path, data path, CI job, Desktop app, or
  local process failed.
- `release`: user asks for canary/stable release, npm, Desktop assets, tags, or
  GitHub Release state.
- `handoff`: work is implemented and needs final summary, validation, commit,
  push, residual risk, or PR.
- `recovery`: the user asks to clean, delete, restore, classify, or continue
  from a dirty worktree, stash, interrupted run, or suspected old Codex work.
- `component_lab`: the user asks to build or expand UI Lab, component inventory,
  component fixtures, or design-system coverage.
- `performance_benchmark`: the user asks to benchmark Rudder, analyze
  performance, or optimize a bottleneck before the exact fix is known.
- `runtime_contract`: the user asks whether Codex, Claude, Gemini, OpenCode,
  Pi, Cursor, or another runtime/provider behaves the same way for tools,
  skills, transcript parsing, adapter isolation, analytics, comments, CLI
  output, or any agent-visible Rudder contract.
- `docs_site_content`: the user asks to discuss, fix, or validate public docs
  page content, Mintlify page behavior, TOC/sidebar/navigation, MDX heading
  hierarchy, changelog structure, docs SEO/GEO content, or docs information
  architecture without asking to deploy or release.
- `skill_optimization`: the user asks to optimize, harden, refactor, validate,
  benchmark, package, or improve a named skill or workflow skill based on
  conversation evidence, a session id, a screenshot, an eval failure, or a
  repeated correction.

If multiple stages are present, choose the earliest blocking stage. Example:
"fix this and review it" starts at `implementation`, then must pass
`verification` and `review` before handoff.

## Routing Matrix

Use the smallest matching workflow:

- If the prompt is already narrow, route out first:
  - visible screenshot, label, alignment, menu, icon, empty state, or compact UI
    behavior: `rudder-ui-polish-maintainer`
  - missing, stale, wrong, unexplained, slow, or suspicious page data:
    `rudder-data-path-diagnostician-maintainer`
  - one run, recent run batch, transcript, stdout/stderr, runtime failure, or
    run-quality investigation: `debug-run-transcript-maintainer`
  - Desktop launch, local Electron shell, packaged startup, update, profile, or
    local instance recovery: `rudder-desktop-dev-recovery-maintainer`
  - review-only of a session, PR, commit, proposal, release, screenshot, or
    agent outcome: `agent-work-reviewer-maintainer` or the more specific
    session reviewer
  - release, npm, GitHub Release, Desktop release assets, tags, dist-tags, or
    install-smoke state: `release-maintainer`

Only keep ownership after this table when the narrow owner cannot safely begin
without lifecycle sequencing, dirty-state recovery, or stage-gate decisions.

- Vague dissatisfaction, weak result, unclear product/design critique:
  `build-advisor`.
- High-stakes proposal or implementation that must pass reviewer rounds:
  `advisor-review-loop-maintainer`.
- Review-only of a session, PR, commit, proposal, UI state, release, or agent
  outcome: `agent-work-reviewer-maintainer` or
  `codex-session-product-reviewer-maintainer` for local Codex session ids.
- Codex session benchmarking against recent local session history, efficiency,
  follow-up rate, token/cost hints, or problem-resolution proxy metrics:
  `codex-session-benchmark-maintainer`.
- Cohort-only Codex session review whose goal is to decide which skills need
  optimization, with no target session to benchmark: route to `skill-optimizer`
  with a clean recent-session evidence packet instead of forcing a benchmark.
- Screenshot-driven visible UI polish or small UI interaction fix:
  `rudder-ui-polish-maintainer`.
- UI Lab, component inventory, fixture catalog, component coverage, or design
  system surface work: keep this router as the owner of the component-lab route,
  then use normal implementation plus UI/browser/E2E evidence. Do not route it
  directly to narrow UI polish.
- Wrong, missing, stale, or sparse data on a Rudder surface:
  `rudder-data-path-diagnostician-maintainer`.
- Rudder agent run failure, transcript, logs, stdout/stderr, or run id:
  `debug-run-transcript-maintainer`.
- Rudder performance benchmark, control-plane bottleneck analysis, or app/API
  optimization: first collect measured workload evidence and current validation
  readiness, then route to implementation or
  `architecture-refactor-driver-maintainer` only if the first slice requires
  architectural change.
- Agent-runtime/provider contract work: keep this router as owner of the
  `runtime_contract` route. Use the relevant debug or implementation workflow
  underneath, but do not hand off until a provider matrix and actor-run-chain
  prove the changed contract for the runtimes that the user cares about.
- Public docs content, Mintlify TOC/sidebar/page-mode behavior, changelog
  headings, docs navigation, or docs SEO/GEO content: use the
  `docs_site_content` route with normal docs workflow. The source tree is
  `docs/`, not internal `doc/`, unless the user asks for contributor guidance.
  Use current Mintlify docs or local rendered/exported docs behavior when the
  question depends on platform behavior. Do not route this to UI polish,
  release, or a new docs skill unless the user asks for visual app UI, live
  publication, or reusable workflow creation.
- Local Rudder Desktop dev startup, Electron shell, embedded Postgres,
  prod-local instance confusion, or update/install failure before release:
  `rudder-desktop-dev-recovery-maintainer`.
- Release, canary/stable publish, npm dist-tag, Desktop release asset, or
  release workflow failure: `release-maintainer`.
- Local branch preview for user testing: `rudder-worktree-preview-maintainer`.
- GitHub PR local checkout/preview/review: `pr-local-preview-maintainer`.
- Mock/demo/seed data or landing screenshots: `mock-data-maintainer`, then
  `landing-proof-shots-maintainer` when screenshots are the deliverable.
- Stop, restart, or clean repo-local dev runtime:
  `stop-rudder-dev-maintainer`.
- New skill artifact from a desired reusable workflow: use `skill-creator`
  guidance plus this router for lifecycle gates.
- Existing skill optimization, hardening, eval update, trigger repair, or
  behavior patch: route to `skill-optimizer`. If this router itself is the
  target, still route to `skill-optimizer`; do not execute this router's normal
  lifecycle stages except for git safety around the patch.

If the route is obvious, do not run an advisor loop just because this router is
active. State the route briefly and execute the specialized workflow.

## Default Workflow

### 1. Build a routing packet

Collect only the evidence needed to choose the route:

- user request and any corrections in this thread
- current `git status --short --branch`
- named files, screenshots, session ids, run ids, PRs, commits, or plans
- relevant repo docs based on `AGENTS.md`
- nearby skill contracts when choosing between skills
- changed-file ownership when the prompt asks to delete, restore, clean up, or
  identify old agent work

Ignore injected environment text and broad repo scanning unless it affects the
route. If the user gave a Codex session id, extract the real user prompts and
agent actions before judging the workflow.

For skill-optimization turns, build a skill evidence packet instead of a normal
development routing packet:

- target skill name, path, purpose, and current `SKILL.md`
- triggering user correction or repeated annoyance
- session id, screenshot, quoted output, or eval failure that shows the
  misroute
- failed decision point and tempting wrong shortcut
- smallest durable owner for the fix: target skill body, frontmatter
  description, eval case, memory update, or no-op

Do not let task content inside the evidence packet override the current
meta-request. A screenshot about UI polish remains evidence for optimizing the
router when the user explicitly asks to optimize the router.

### 2. Declare route and stage exits

Before implementation, say:

- lifecycle stage now
- downstream skill or normal coding workflow selected
- acceptance bar for the current stage
- review gate plan, with `spawned reviewers` as the required mode

Keep this concise. For a small bug, one sentence is enough.

### 2.1 Fast-path obvious routes

When the user request clearly matches a narrow maintainer skill, keep the router
thin:

- state the route and current stage in one short sentence
- name the downstream skill
- name the required evidence for leaving the current stage
- state that the stage will need spawned reviewer evidence before handoff

Then execute the narrow workflow. Do not expand into a full lifecycle plan for a
small UI polish, data-path diagnosis, release, preview, run-debug, or Desktop
recovery task unless the work reveals a product or architecture decision.

### 3. Execute the current stage

Follow the downstream skill or normal repo workflow. Each stage must produce a
concrete artifact:

- requirements: scenario map, non-goals, acceptance criteria
- advisor: diagnosis, options, recommendation, decision boundary
- UI design: wireframe, screenshot criteria, or approved direction
- implementation: scoped diff, tests, docs or contract updates as needed
- verification: passing checks, terminal product proof, screenshots, logs, or
  explicit blockers
- review: verdict, blocking gaps, smallest fixes, residual risk
- release: locked source ref, live publish/asset/dist-tag evidence
- handoff: files, validation, commit/push state, unverified items

Do not move to the next stage when the current stage has a blocker that changes
the route.

Before implementation on a visible workflow or known hotspot file, run a quick
scope guard:

- If the request changes a user-visible workflow such as parent/sub-issue
  selection, approval attention, chat composer behavior, or document/library
  navigation, require the relevant E2E path unless the user explicitly approves
  a lower-level substitute.
- If the likely edit target is an already oversized UI file, especially
  `IssueDetail.tsx` or another multi-responsibility page component, prefer a
  small extracted component/helper for new behavior instead of making the
  hotspot file harder to maintain.
- If extraction would be larger than the requested fix, keep the fix narrow but
  record the hotspot risk in handoff and avoid unrelated cleanup.
- Do not broaden a small bug into an architecture refactor solely because the
  file is large; use the guard to preserve workflow coverage and scope
  discipline.

### 3.1 Recover continuation state before resuming work

When the thread resumes after `turn_aborted`, rollback, compaction, a long
`/goal` run, unexpected stash creation, or work that spans multiple Codex
sessions, rebuild state before editing or handing off:

- Read the newest user request and compare it with the original task. Do not
  continue an older ghost task if the user redirected the work.
- Check `git status --short --branch`, recent commits, stashes, and touched
  files relevant to the task. Treat unrelated dirty files as user work unless
  evidence shows they belong to this task.
- Inspect prior session evidence when the user names sessions or says "刚才",
  "之前", "正在处理", or "别把功能弄没了".
- Reconstruct the current phase, files changed, validation already run,
  blockers, and next safe command before continuing.
- Before final handoff, verify that the final answer, commit, and push state
  correspond to the latest user request, not a stale pre-interruption stage.

If a stash exists, classify it before applying or dropping it: source session,
files included, overlap with current task, and whether applying it would
overwrite unrelated work. Do not drop or pop a stash just to clean up state.

### 3.2 Handle dirty-worktree cleanup as recovery first

For prompts like "这些删了", "no, only delete package.json changes", "what is this
code", or "is this previous Codex uncommitted work", enter `recovery` before
any destructive action.

Build a changed-file ownership packet:

- current branch, upstream, and ahead/behind state
- every modified and untracked path grouped by likely feature or source session
- relevant recent Codex sessions, branch names, commits, and screenshots when
  the user references previous work
- which files are safe to restore, which must be preserved, and which are
  unknown

Do not delete, restore, stash-pop, or commit until the target group is clear.
If the user narrows the scope mid-run, stop and reclassify the file groups
before touching more paths.

### 3.3 Treat component labs as workflow features

UI Lab, component catalog, fixture coverage, and design-system inventory work is
not narrow UI polish, even when the user says the surface should look better.

The component-lab route must define:

- the coverage target: hand-authored fixtures, auto-discovered components,
  context-required components, or all of them
- how context-required components are labeled instead of faked
- the user-visible route and browser proof
- focused page/unit tests and E2E coverage when navigation or filtering changes
- a reviewer gate for coverage quality before handoff

Use `rudder-ui-polish-maintainer` only after the component-lab scope is already
settled and the remaining task is a concrete rendered-state fix.

### 3.4 Require measured evidence for performance work

For "做一下 Rudder 性能优化分析", app benchmark, control-plane optimization, or
similar prompts, start with `performance_benchmark` unless the user names an
already-proven bottleneck.

Before implementation, record:

- workload shape, dataset size, route/API surface, and user scenario
- baseline measurement and the tool or script that produced it
- dependency/cache readiness for the checks you intend to run
- one scoped first slice with expected impact and rollback boundary
- verification plan, including what will be measured again after the change

Do not promise full validation if dependency install, registry, browser, or
runtime setup is already blocked. Report validation readiness before starting a
long implementation phase.

### 3.5 Require terminal product proof for workflow changes

For any change that affects a user-visible, agent-visible, Desktop, release, or
control-plane workflow, identify the terminal product surface before calling
verification complete.

Start from the work loop, not from the implementation layer:

- actor: board operator, reviewer, assignee agent, runtime agent, CLI user,
  Desktop user, release consumer, or automation
- trigger: click, command, wakeup, API action, scheduled run, release workflow,
  or packaged startup
- system effect: issue state, comment, review decision, activity, run log,
  cost, approval, release artifact, or persisted setting
- terminal surface: current dev web app, packaged Desktop shell, CLI output,
  run-intelligence view, npm/GitHub release state, or another final consumer

Choose proof that follows that loop:

- For CLI or agent-runtime changes, prefer an actor-run-chain: seed a disposable
  org/issue/agent when needed, trigger the runtime or CLI as that actor, then
  read back the API/DB state and observe the final app or CLI surface.
- For UI and workflow changes, use Browser or Computer Use to exercise the
  actual route when practical, plus API/log readback when state matters.
- When the user explicitly asks for "真实环境", "本地真实环境", "在我电脑上",
  "你自己 UI 跑一遍", "我验收结果", or challenges "你试过了吗", treat that
  as a hard real-local validation request. Automated E2E, unit tests, static
  review, spawned reviewer acceptance, or screenshots from an isolated test
  fixture are supporting evidence only; they do not satisfy the request by
  themselves.
- For hard real-local validation requests on a UI surface, use the user's
  current local Rudder instance when safe: confirm `/api/health` or the
  equivalent live source of truth, create disposable seed data through public
  APIs when needed, open the actual local route in Browser or Computer Use,
  perform the user-visible action, then read back persisted API/DB state and
  capture a screenshot or final URL. If a later runtime/agent step fails for
  reasons outside the UI path, separate that failure from the UI validation
  result instead of downgrading or hiding the UI proof.
- For Desktop-native behavior, packaged startup, menus, update prompts,
  drag/drop, native dialogs, or resident shell behavior, use Computer Use or
  packaged Desktop verification. Browser proof is only a substitute when the
  behavior is truly web-surface equivalent.
- For release work, live npm, GitHub, tag, asset, workflow, and install-smoke
  state is the terminal surface. Local build output is supporting evidence.
- For debug-derived fixes, transcript or log evidence proves the root cause; it
  does not prove the fix until the terminal workflow is rerun or the missing
  workflow proof is explicitly recorded as blocked.

When a realistic product proof requires seed or mutation data, record a
mutation ledger:

- target runtime and `/api/health` or equivalent source of truth
- organization, issue, agent, run, approval, release, or other records created
- which writes used public APIs and which used direct database writes
- final URL, run id, screenshot path, log path, or release URL inspected
- cleanup status, or why the evidence data was intentionally left in place

Substitutions must be named. Example: if packaged Desktop capture fails and a
current-dev browser path is used instead, call it `substituted: Browser current
dev app for Desktop shell capture`; do not present it as full Desktop proof.

Missing terminal product proof blocks handoff for workflow changes unless the
user explicitly lowers the acceptance bar for this turn.

### 3.6 Prove runtime/provider contracts with a matrix

For runtime, provider-adapter, transcript-parser, tool-call, skill-usage,
agent-comment, CLI, or run-analytics contract work, build a compact provider
matrix before implementation or before claiming verification.

The matrix must name:

- runtimes in scope: Codex, Claude, Gemini, OpenCode, Pi, Cursor, or any
  user-named adapter
- actor path: the command, heartbeat, CLI invocation, chat action, or runtime
  wakeup that exercised each provider
- transcript/parser evidence: raw log or parsed steps showing the relevant tool
  call, skill call, message, output, or error shape
- persisted Rudder evidence: run record, analytics field, comment, issue,
  message, cost, usage, or activity readback
- terminal surface: run-intelligence view, UI state, CLI output, or API response
  where the next actor would consume the result
- unsupported or blocked providers, with exact blocker evidence

Do not accept "works for Codex" as proof for Claude/Gemini/OpenCode/Pi-style
tool-call behavior when the user explicitly raised provider parity. If a
runtime cannot be launched locally, preserve the contract with a parser fixture
or recorded log and label the missing actor-run-chain as blocked/substituted.

For skill-usage analytics specifically, verify both sides:

- ingestion: provider-specific raw transcript/tool-call shape is normalized
- consumption: the stored analytics/readback/UI surface reports the expected
  skill usage without relying on a Codex-only `SKILL.md` read heuristic

### 3.7 Keep public docs structure work narrow

For public docs content, Mintlify behavior, changelog, sidebar, page TOC,
navigation, or docs SEO/GEO content, use `docs_site_content` unless the user
clearly asks for release/deploy, app UI polish, or internal contributor docs.

Build a docs evidence packet:

- target page and locale under `docs/`
- whether the request is discussion-only, content edit, rendered validation, or
  deployment/release
- relevant `docs/docs.json`, MDX headings, and current rendered/exported page
  behavior
- current Mintlify source of truth when the platform behavior is in question
- acceptance bar: content structure, docs validation, rendered/export/browser
  proof, or explicit no-code recommendation

For TOC/sidebar problems, prefer content hierarchy and generated-page behavior
over CSS hacks or hidden selectors. Example: if repeated `Highlights` and
`Install` headings make a changelog page-level TOC noisy, keep release versions
as real headings and convert repeated section labels to prose labels or lower
visual treatments when that preserves readability and generated navigation.

Do not treat a docs-page screenshot inside a skill-optimization request as an
active docs task. In that case it is failure evidence for the target skill; the
route stays `skill_optimization -> skill-optimizer`.

### 4. Run default review gates

Use review gates by default for every routed stage that produces an artifact,
decision, diff, validation bundle, or handoff. This includes narrow bug fixes:
implement first, collect verification evidence, then review the actual diff and
evidence before final handoff.

The reviewer gate is not only a functionality check. Its job is to expand the
author's field of view. A valid gate must preserve distinct reviewer lenses so
the parent does not receive three copies of the same test checklist. For any
workflow, proposal, skill, agent-visible contract, UI/product journey, release,
Desktop, runtime, or prior-failed handoff, spawn reviewers with at least these
three lenses:

- functional trust: does the artifact work, are contracts/tests/evidence real,
  and is the handoff safe?
- adversarial: what would make this wrong, misleading, brittle, over-scoped,
  under-scoped, or harmful from the user's real journey?
- heuristic: what alternative framing, smaller slice, missed user job, stronger
  product shape, or future-proofing path would the author likely not see?

For truly mechanical routed changes, two spawned reviewers are acceptable only
when one owns functional trust and the other is explicitly adversarial or
heuristic. Record why the third lens was not required. Do not let both
reviewers collapse into duplicate functional checks, and do not use "lightweight"
to mean self-review or no spawned review.

Reviewer gates mean spawned reviewer agents. The author rereading the diff,
writing two internal personas, or labeling a serial pass as "Reviewer A/B" is
not a valid review gate for this skill.

Escalate the review depth when:

- the user explicitly asks for reviewer agents, two rounds, or "not done until
  review passes"
- the work is a workflow/skill/proposal that will shape future agent behavior
- the change is broad, user-visible, release-related, Desktop/package-related,
  or cross-contract
- a prior run failed because it skipped review or used the wrong stage
- the user complains that a prior review missed risks, lacked first-principles
  thinking, or failed to provide a new perspective

Skip or defer the review gate only when:

- the user explicitly changes this spawned-reviewer policy for the current turn
- the work is a truly mechanical no-code operation such as a quick status check,
  with no routed artifact, diff, validation bundle, or handoff to judge
- the stage has no artifact yet; create the artifact first, then review it

Review-only requests are not an exemption from independent review. Route them to
the reviewer skill, produce the review artifact, then use spawned reviewers to
review that artifact before handoff unless the review artifact itself was
produced by spawned reviewer agents.

When subagents are available, spawn reviewers after the stage artifact exists.
Record execution mode as `spawned reviewers`.

Spawning reviewers is not the same as passing review. Before moving to handoff
or the next consequential stage, reconcile the spawned reviewer gate:

- read the actual reviewer outputs after the review assignment, not just the
  fact that child threads were created
- record each reviewer verdict, verdict level, blockers, and whether its proof
  was reviewer-verified or only author-claimed
- if a child session is still open and has no final verdict, wait when
  practical or mark the gate blocked/incomplete
- if a child has a final verdict but the spawn edge still appears open, record
  the state mismatch and judge from the actual final output, but do not hide the
  orchestration inconsistency
- treat `conditional accept`, `needs more evidence`, and `reject` as unresolved
  gate states until the named blocker is fixed, the missing proof is gathered,
  or the user explicitly lowers the acceptance bar
- do not upgrade a `stage accept` into a final handoff accept
- reject the review gate when all reviewers evaluate the same functional
  surface and none meaningfully challenges framing, user journey, hidden
  assumptions, or unseen alternatives

For UI, workflow, Desktop, runtime, release, or control-plane changes, the
parent must verify that reviewer outputs distinguish author-claimed validation
from reviewer-verified terminal product proof. If all reviewers only repeat the
implementer's claimed tests, screenshots, or dev-server evidence, the review
gate is not strong enough to close final handoff.

Before recording `blocked: spawned reviewers unavailable`, perform an explicit
spawn availability probe. Absence of a visible spawn tool in the first tool list,
uncertainty about the active harness, or not having used multi-agent tools yet is
not enough. Probe the runtime by using the available tool-discovery path or the
runtime's spawn mechanism directly. If the probe succeeds, spawn the reviewers
and wait for verdicts. If the probe fails, include the failed probe evidence in
the evidence ledger.

Do not record "the user did not explicitly ask for subagents" as the blocker
when the user explicitly invoked this router skill. In that case, either spawn
the reviewers, or record the exact tool-policy or tool-call failure that blocked
the spawn after probing.

If subagents are unavailable after that probe, do not run a serial fallback.
Record execution mode as `blocked: spawned reviewers unavailable`, include the
artifact, validation evidence gathered so far, and the failed probe evidence, and
stop before complete handoff unless the user explicitly changes the review
policy.

Reviewer A owns functional trust and scenario correctness:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review the stage artifact as the scenario, demand, implementation, validation,
and handoff trust reviewer. Focus on user job, actors, lifecycle states,
non-goals, requirement classes, object model, scope discipline, org scoping,
contracts, tests, terminal product proof, git safety, and whether this stage
solves the right problem. Separate author-claimed proof from reviewer-verified
proof. Give accept / conditional accept / needs more evidence / reject, verdict
level, blockers, and smallest changes needed.
```

Reviewer B owns adversarial review:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review the stage artifact adversarially. Try to disprove the author's framing
from first principles and from the user's real journey. Look for hidden
assumptions, wrong abstraction level, path dependence, overfitting to tests,
weak terminal proof, old or conflicting docs, agent/operator behavior that was
not exercised, edge cases that reverse the conclusion, and ways the artifact
could be technically correct but product-wrong. Separate author-claimed proof
from reviewer-verified proof. Give accept / conditional accept / needs more
evidence / reject, verdict level, blockers, and smallest changes needed.
```

Reviewer C owns heuristic and generative review:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review the stage artifact as a heuristic/product-systems reviewer. Do not only
look for bugs. Look for the better question, the smaller durable slice, the
missing actor journey, the more teachable contract, the alternative surface or
protocol that would make future work easier, and the second-order consequence
the author likely missed. Identify useful next perspectives without broadening
the current task unnecessarily. Separate author-claimed proof from
reviewer-verified proof. Give accept / conditional accept / needs more evidence
/ reject, verdict level, blockers, and the smallest changes or next-slice
recommendations.
```

If any required reviewer rejects, names a blocker, or says the review lens was
not answerable from available evidence, rework before final handoff or report
the blocker as requiring user judgment. Do not collapse an adversarial or
heuristic reviewer into a standard implementation reviewer just to get a pass.

### 4.1 Reviewer Lens Validation Cases

Use these cases to judge whether this router's review gate itself behaved
correctly.

#### Case: Agent-Writable Protocol

Input:
A change adds a renderer for a new token and tests that the UI can display it.

Expected behavior:
The functional reviewer checks parser/render/navigation evidence. The
adversarial reviewer asks whether the real agent can discover and author the
token from CLI, skills, runtime context, or API output. The heuristic reviewer
suggests the smallest authoring contract, such as a CLI-returned markdown link
or protocol reference, instead of jumping to a full UI-schema system.

Must not:
Accept the change as complete only because screenshots and renderer tests pass.

#### Case: UI Looks Correct But Journey Is Wrong

Input:
A visible UI patch fixes the immediate screen but the user complains the review
missed the real workflow.

Expected behavior:
The adversarial reviewer reconstructs actor, trigger, persisted effect, and
terminal surface. The heuristic reviewer asks whether the screen is only a
symptom of a deeper workflow or data-path contract.

Must not:
Run two reviewers that both repeat the same DOM, typecheck, and screenshot
checks.

#### Case: Narrow Mechanical Patch

Input:
A one-line typo or command help fix with no workflow behavior.

Expected behavior:
The router may use two spawned reviewers and record a mechanical exception for
the missing third lens, but one lens must still challenge whether the change
accidentally alters scope, command meaning, or docs consistency.

Must not:
Spawn three heavyweight reviewers for a no-risk text correction unless the user
explicitly asks for that depth.

### 4.2 Evidence ledger

Before handoff, include a compact evidence ledger:

- Required: the checks or artifacts this route requires, including spawned
  reviewer verdicts
- Scenario: the actor, trigger, system effect, and terminal surface the work was
  supposed to prove
- Proven: commands, screenshots, browser/Desktop checks, live release evidence,
  actor-run-chain results, readbacks, mutation ledger entries, or reviewer
  outputs that actually ran
- Missing or substituted: anything not proven, why it is missing, and whether it
  blocks completion

For user-visible UI, workflow, Desktop, release, and cross-contract changes,
missing required terminal product evidence blocks the handoff unless the user
explicitly changes the acceptance bar.

### 5. Keep git safe in shared worktrees

Always inspect branch and dirty state before edits and before commit.

- Stage only files from the current task.
- For large refactors or `/goal` runs, split commits by coherent phase when
  the phase can stand on its own: facade/boundary setup, internal extraction,
  consumer rewiring, compatibility fix, test hardening, or docs update.
- When the user says "分批 commit" or "不要一个很大的 commit", make a phase
  checklist before the first commit and preserve a resumable checkpoint after
  each phase: current phase, files touched, validation state, known blockers,
  and next command or edit target.
- Do not batch unrelated route, UI, runtime, migration, and docs cleanup into a
  single commit just because they were discovered during one long run.
- Do not amend unless HEAD is confirmed to be your own just-created commit and
  no parallel commits have appeared.
- Prefer a normal follow-up commit over history rewrite in a shared workspace.
- Do not push when the branch is behind, non-fast-forward, or includes unrelated
  local commits that the user did not ask to publish.
- If push is blocked, still make the scoped local commit when repo rules require
  a commit, and explain the branch state.

### 6. Final handoff

Final output should include:

- route taken and stages completed
- downstream skills used or deliberately skipped
- review execution mode, if any
- files or artifacts changed
- validation passed and not run
- commit and push status
- remaining blockers or human decisions

## Acceptance Bar

Do not hand off as complete when any of these are true:

- the route was never stated and the agent silently jumped stages
- a narrow specialized skill was bypassed for a heavyweight advisor loop
- spawned reviewer evidence is missing for a routed stage artifact, decision,
  diff, validation bundle, or handoff
- spawned reviewer child sessions have no final verdict, or the final verdicts
  are `conditional accept`, `needs more evidence`, or `reject` with unresolved
  blockers
- "review" only means the author reread their own diff without findings
- reviewers only repeated author-claimed validation instead of verifying the
  required terminal product proof for UI, workflow, Desktop, runtime, release,
  or control-plane changes
- user-visible UI lacks rendered or screenshot evidence when required
- agent-visible, CLI, runtime, Desktop, release, or control-plane workflow work
  lacks terminal product proof or a named blocked/substituted proof
- feature/workflow changes skip required E2E coverage without explicit approval
- Desktop/release/package work lacks the repo-required packaged or live checks
- git history includes unrelated files or an unsafe amend in a shared worktree
- final answer hides failed checks, skipped evidence, or push blockers

## Common Routes

### Small UI bug with review requested

Route: `implementation -> verification -> review -> handoff`.

Use the UI or Desktop-specific workflow needed for the bug. Review after the
diff and tests exist. Do not run a full advisor loop unless the bug reveals an
unclear product decision.

### Small UI bug without explicit review request

Route: `implementation -> verification -> review -> handoff`.

Default review still applies. Keep the review lightweight when the bug is
narrow, but the gate still requires spawned reviewers before handoff.

### Visible workflow change in a hotspot file

Route: `implementation -> verification -> review -> handoff`.

Before editing, identify whether the change affects a real workflow and whether
the target file is already a hotspot. Add E2E coverage for the workflow path
when behavior changes. Prefer extracting a small component/helper if the new
logic would otherwise deepen an oversized page component, but keep the task
scoped and avoid opportunistic refactors.

### Proposal-only request

Route: `requirements -> advisor -> review -> handoff`.

Do not implement. Produce the decision artifact, run spawned reviewer gates by
default, and stop with verdicts, blockers, and next decision.

### Codex session audit

Route: `review`.

Use `codex-session-product-reviewer-maintainer`, extract real user requests and
agent actions from local session logs, then give a verdict. Do not edit files
unless the user later switches to rework.

### Failed run or transcript problem

Route: `debug -> review or implementation`.

Use `debug-run-transcript-maintainer` first to reconstruct what happened. Only
switch to implementation after the root cause and target fix are clear.
After a fix, do not treat the transcript as proof that the product behavior is
fixed. Move through verification with terminal product proof for the affected
actor and surface.

### Agent-visible CLI or runtime workflow regression

Route: `debug or implementation -> verification -> review -> handoff`.

When the bug affects how an agent uses Rudder, verify through the agent's real
work loop when practical: seed a disposable issue, trigger the agent/runtime or
CLI as that actor, read back persisted issue/run/comment state, and inspect the
terminal app or CLI surface. Unit tests and direct DB assertions are supporting
evidence, not the whole review.

### Runtime/provider contract change

Route: `runtime_contract -> implementation or debug -> verification -> review -> handoff`.

Build the provider matrix first. Then prove the contract at three layers:
provider raw output, Rudder normalization/persistence, and the terminal surface
that operators or reviewers use. For provider parity requests, at least one
non-Codex provider must be exercised or explicitly marked blocked with evidence.

### Public docs TOC or content-structure question

Route: `docs_site_content -> advisor or implementation -> verification -> review -> handoff`.

For discussion-only prompts, answer from current docs files plus the platform
source of truth and stop without editing. For edit requests, patch `docs/`,
validate docs commands, and verify rendered/exported navigation when the issue
is visual or generated by Mintlify.

### Release request

Route: `release`.

Use `release-maintainer` directly. Live remote state is the source of truth.

## Output Template

```markdown
Route: ...
Stage exits:
- ...

Used:
- ...

Review:
- Mode: spawned reviewers / blocked: spawned reviewers unavailable / not a routed review gate
- Lenses: functional trust / adversarial / heuristic, or mechanical exception rationale
- Verdict: ...

Validation:
- Passed: ...
- Not run / not proven: ...

Evidence:
- Required: ...
- Scenario: ...
- Proven: ...
- Missing or substituted: ...

Git:
- Commit: ...
- Push: ...

Residual risk:
- ...
```
