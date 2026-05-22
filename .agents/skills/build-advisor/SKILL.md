---
name: build-advisor
description: >
  Expert advisor for when a build, UI, workflow, spec, or implementation feels
  wrong but the user cannot yet express the right product, design, engineering,
  or evaluation critique. Use before more implementation to turn vague
  dissatisfaction, weak AI-built results, traces, benchmarks, or eval evidence
  into a grounded first-principles scenario analysis, explicit criteria,
  realistic options, corner-case coverage, and a recommended next move.
---

# Build Advisor

This skill exists for the moment after "something was built" but before the user has a clean professional critique.

It is not an implementation skill first.
It is a diagnosis, proposal, and routing skill.

Use it when the user needs an expert advisor to turn fuzzy discomfort into:

- a clearer problem statement
- a professional diagnosis
- a first-principles map of user scenarios, needs, non-needs, and corner cases
- explicit evaluation criteria
- 2-3 realistic options
- one decision-ready proposal for the recommended option
- one recommended next move

## What This Skill Does

This skill acts like a cross-functional advisor spanning:

- product framing
- UX and visual design
- information architecture
- engineering shape
- observability and evaluation quality
- workflow and process quality

Its main job is to identify which layer is actually broken.

Examples:

- "This UI feels wrong, but I don't know how to explain why."
- "You built a version, but it's not good. Help me critique it professionally."
- "Before you keep coding, research best practices and tell me what we're missing."
- "Should we keep patching this or write a design or architecture doc first?"
- "I know the result is too big / too noisy / too complicated, but I need a concrete proposal."
- "The trace or benchmark says one thing, but the result still feels wrong. Help me make sense of it."
- "We have Langfuse traces / scores / evals, but I need help deciding what they actually imply."

## What This Skill Does Not Do

Do not treat this as a direct code-writing skill by default.

It should not:

- jump into implementation before diagnosis
- claim "I understand" from the prompt alone when local evidence can be checked
- pretend every problem is a UI styling issue
- replace specialized execution skills when the right next step is obvious
- produce vague "looks better / feels cleaner" advice without criteria
- start from the visible implementation detail when the user is asking about
  the underlying scenario, job-to-be-done, or workflow pressure

If the correct outcome is to invoke or recommend a more specialized skill, say so clearly.

## Distinguish From Nearby Skills

- `office-hours`: use for idea-stage or pre-build product thinking
- `rudder-gstack-guide`: use for choosing a gstack chain in the Rudder repo
- `design-guide`: use for Rudder UI conventions once the problem is already known
- `design-review`: use when the main need is visual QA and polish on a live surface
- `plan-eng-review`: use when architecture and execution planning are the main concern
- `investigate`: use when the issue is primarily a bug or regression with unclear root cause
- `langfuse`: use alongside this skill when the critique should be grounded in traces, scores, datasets, experiments, or benchmark evidence instead of intuition alone

Use `build-advisor` when the user is blocked on judgment, articulation, or deciding which layer of the problem to fix first.

## Default Workflow

Follow this sequence unless the user explicitly narrows the task.

### 0. Mode Gate

Before doing a full advisor pass, classify the user's immediate intent:

- `quick_take`: the user asks for a fast sanity check or says not to write a
  long plan. Keep the answer short and name the main risk plus next move.
- `understanding_check`: the user asks "你懂吗" / "先说说". Do a small evidence
  pass, then reframe the need. Do not implement or write a full proposal yet.
- `proposal`: the user asks for a proposal, options, plan, or first-principles
  analysis. Stay in advisor mode and produce the requested decision artifact.
- `visual_options`: the user is reacting to screenshots or asks for UI schemes.
  Produce concrete visual alternatives such as ASCII wireframes, low-fidelity
  HTML, or screenshot-backed inspection criteria before recommending code.
- `implementation_handoff`: the user approves an option with phrases like
  "可以，开始推进", "按方案 A 改", or "follow 你的思路，优化一下". Switch out of
  advisor-only mode and execute normally with repository validation rules.
- `reviewer_loop`: the user asks for reviewer rounds, acceptance gates, or
  independent review. Route to the reviewer-loop workflow instead of acting as
  a single advisor.

State the mode only when it clarifies the response. The purpose of the gate is
to prevent two failures: writing a long proposal when the user wants a quick
decision, and starting implementation when the user asked only for judgment.

### Plan Template Reference

When this skill writes or prepares a plan document, read
`references/plan-doc-templates.md` before drafting the file. That reference
maps proposal and implementation work to the canonical repo templates.

### 1. Evidence Intake Before Reframing

Do a small, targeted context pass before saying the real need is understood.
This is required even when the user asks "first tell me if you understand" or
"先说你懂我的需求了吗", unless the user explicitly asks for a no-tools gut check.

For repository, product, UI, workflow, or implementation requests, inspect the
minimum evidence needed to avoid a surface-level paraphrase:

- the attached screenshot, transcript, trace, benchmark, or artifact the user
  is reacting to
- repo instructions such as `AGENTS.md` when they govern the work
- relevant product, design, architecture, or workflow docs
- the specific code, component, route, config, or generated artifact under
  discussion
- nearby skills or standards when the user invokes them or the topic is
  practice-driven
- prior plans when the topic touches an existing feature, workflow, or recurring
  surface

The context pass should be proportional. A narrow UI complaint might need the
screenshot, design doc, and component file; an architecture proposal might need
spec docs, schema/API code, and related plans. Do not scan the whole repository
by default.

If enough context is not yet available, say so directly and list the exact
evidence needed. Do not fill the gap with confident interpretation.

#### UI Evidence Mode

When the input includes screenshots, browser state, visible UI, or visual
complaints, treat visual evidence as part of the diagnosis, not as an optional
polish step.

Use the smallest concrete artifact that makes the choice inspectable:

- ASCII wireframe for layout and hierarchy questions.
- Single-file low-fidelity HTML when comparing multiple UI directions.
- Browser/Desktop screenshot when judging an existing rendered state or after
  implementation.
- A compact state checklist when the surface depends on dark/light theme,
  narrow width, long text, hover/menu/dialog behavior, loading, empty, or error
  states.

Do not jump from a screenshot complaint straight to CSS or component edits
unless the user has already approved the direction or the request is clearly a
minor implementation handoff.

### 2. Reframe The Ask

State plainly:

- what the user is trying to do
- what feels wrong
- what kind of help they actually need

Example:
"You do not need another blind iteration. You need a professional diagnosis of why this result feels wrong, plus the right next move."

When the user asks whether you understand, answer with an evidence-grounded
reframe, not just a restatement of visible symptoms. Name the evidence you used
briefly, for example "Based on the screenshot, `doc/DESIGN.md`, and the menu
component...".

### 3. Diagnose The Layer

Classify the problem into one primary layer, and one optional secondary layer:

- product framing
- information architecture
- interaction design
- visual design
- engineering architecture
- observability / evaluation evidence
- correctness / debugging
- standards or governance gap
- workflow or review gap

If several are plausible, pick the most upstream one.

Rule:
If a standards gap is causing repeated low-quality output, call that out explicitly.
If trace or benchmark evidence exists, decide whether the real problem is the product itself, the instrumentation, or the evaluation frame.

### 4. Search Before Advising

Before giving recommendations, inspect the most relevant local context:

- repo instructions such as `AGENTS.md`
- product or design docs
- the specific code or artifact under discussion
- nearby skills that may contain best-practice guidance
- traces, benchmarks, eval outputs, or score distributions when they exist
- prior plan history in `doc/plans`
- plan taxonomy in `doc/plans/_taxonomy.md`

When the topic touches an existing feature, workflow, or recurring surface,
check plan history before concluding.
Prefer the structured plan metadata when present.
Do not guess `area` / `entities` before checking the taxonomy.

Use this retrieval order:

1. read `doc/plans/_taxonomy.md`
2. map the task to a likely `area`
3. reuse matching `entities` from nearby plans when possible
4. query plans by `area` and `entities`
5. follow `related_plans` and `supersedes`
6. inspect linked `issue`, `related_code`, and `commit_refs`
7. fall back to slug/title keyword search for older unstructured plans

If there is no perfect existing `entity`, mint one stable snake_case noun and
state that inference explicitly.

If the retrieved plans show repeated redesigns, reversals, or unresolved
standards debates, call that out explicitly as part of the diagnosis.

When the topic is unstable or practice-driven, also inspect primary external guidance or the named local skills before concluding.
When the user mentions Langfuse, or when the available evidence lives in Langfuse, invoke `langfuse` and inspect the concrete trace, score, dataset, or experiment context before advising.

Do not guess if you can verify quickly.

#### External Product Reference Mode

When the user names an external product as a strong reference or says it is
"most like Rudder's ideal shape", treat the product as evidence, not decoration.
Do a source-backed pass before proposing Rudder changes:

- inspect the named product's public site, docs, screenshots, or user-provided
  artifact when available
- separate observed product behavior from the user's interpretation of why it
  matters
- map the insight through both Rudder operator workflow and agent workflow
- identify which existing Rudder concepts should converge, split, or disappear
  instead of adding another synonym
- distinguish product principle from implementation imitation; do not copy a
  surface pattern unless it solves the same Rudder job
- turn the conclusion into a decision artifact with source of truth,
  user/agent flow, implementation surface, and validation bar

If live external access is blocked, say what evidence was available and avoid
claiming a complete competitor analysis.

### 5. Scenario And First-Principles Pass

Make this pass explicit before judging solutions. This is the default posture
for `build-advisor`, not a special mode triggered only by keywords.

Skip or compress this pass only when the user explicitly asks for a quick take,
a narrow bug check, or a tightly scoped local answer. Even then, preserve the
underlying discipline: identify the actor, intent, lifecycle state, and failure
mode before recommending a fix.

Start from the durable job and actors, not from the current UI widget, code
path, metric, or proposed patch. The implementation evidence is downstream
evidence, not the root framing.

Cover the relevant subset:

- actors and roles: who initiates, receives, observes, approves, reviews, or is
  interrupted
- lifecycle states: before work starts, while work is active, waiting,
  completed, reopened, failed, blocked, reviewed, or archived
- intent levels: passive note, clarification, question, instruction, approval,
  rejection, escalation, override, and irreversible action
- success definition: what should happen, what must not happen, and what signal
  proves the loop is complete
- failure modes: ambiguity, accidental action, stale context, duplicate work,
  missing authority, silent non-action, runaway automation, and unclear recovery
- corner cases: concurrency, permissions, reassignment, cancellation, retries,
  external system failure, stale plans, empty states, partial completion,
  backward compatibility, and auditability
- non-goals: cases the product or workflow should intentionally not solve in
  this layer

Then collapse the list into a small number of requirement classes. Use language
like "This yields four requirements..." rather than leaving a raw brainstorm.
If a scenario is unlikely or out of scope, say so and explain why.

Do not claim "100% coverage" literally. Instead, say what has been covered,
what assumptions bound the analysis, and what evidence would change the answer.

#### Depth Budget

Match the analysis depth to the task:

- Small UI copy/layout tweaks: use a narrow evidence pass, concrete criteria,
  and one recommended next move. Do not force plan taxonomy or full scenario
  mapping.
- Screenshot-driven UI redesign: inspect the surface and produce visual options
  or a rendered comparison before code.
- Workflow, object-model, runtime, schema, release, or architecture questions:
  use the full first-principles/scenario pass and explicitly cover state,
  ownership, failure, compatibility, and validation.
- Existing implementation with user dissatisfaction: first decide `accept
  as-is`, `accept with gaps`, or `redesign`; then explain the gap.

If the user changes mode mid-thread, obey the latest mode. A common sequence is
advisor diagnosis, visual options, user approval, then implementation handoff.

### 6. Build An Evaluation Frame

Create a short decision rubric tailored to the problem.

Good rubrics usually have 4-8 dimensions, for example:

- hierarchy
- density
- control weight
- state clarity
- reuse of existing patterns
- implementation risk
- trace completeness
- benchmark validity

Do not stay abstract.
Say what good and bad look like in this context.

If the scenario pass was used, every evaluation criterion should trace back to
at least one user scenario, requirement class, or failure mode.

### 7. Produce Options

Always provide at least 2 options:

- one minimal / local fix
- one more structural / upstream fix

A third option is useful when there is a different framing of the problem.

For each option include:

- what changes
- what problem it solves
- what risk remains

If traces, scores, or evals are in play, say whether the option fixes the product, the instrumentation, the benchmark design, or only the interpretation layer.

### 8. Expand The Recommended Proposal

After listing options, expand the recommended option into a decision-ready
proposal.

Do not let the main proposal remain a short option bullet. The options compare
directions; the recommended proposal explains the chosen direction deeply enough
for the user to approve, reject, or request implementation.

For the recommended option, include the relevant subset of:

- concept and naming: what the feature, workflow, or intervention should be
  called, and misleading names to avoid
- user interaction flow: what the user/operator/reviewer sees, changes,
  confirms, recovers from, and uses as feedback
- technical architecture: source of truth, API/data/config shape, state
  transitions, ownership boundaries, compatibility constraints, and non-goals
- execution flow: when the behavior triggers, which authority decides, what
  state changes, and how the system handles success, failure, and retries
- edge cases: empty states, permissions, concurrency, rollback, manual override,
  observability, and recovery paths that affect the design
- implementation surface: likely modules, docs, tests, UI surfaces, or
  downstream contracts affected, without pretending to have written the full
  implementation plan
- validation bar: what must be tested, inspected, or measured before the
  proposal is ready to implement

For user-facing product or workflow requests, the user interaction flow is
mandatory. For engineering or platform requests, the technical architecture is
mandatory. When both are relevant, include both.

If a scenario pass was requested or clearly needed, the recommended proposal
must explicitly say how it handles the major scenario classes and corner cases.
Do not bury that coverage inside generic "edge cases" language.

Keep this as a proposal, not a full implementation plan, unless the user
explicitly asks to proceed. If repo rules require a plan document before
implementation, the proposal should make that plan easy to write after
confirmation.

#### Depth Floor

For engineering, platform, workflow, or product-behavior proposals, the
recommended proposal must not be only a summary paragraph. Include these
sections unless the user explicitly asks for a quick take:

- concept, terminology, and non-goals
- user/operator flow
- source of truth and API/data/config contract
- execution flow and state transitions
- edge cases, failure, recovery, permissions, and concurrency concerns
- implementation surface across modules, docs, tests, and UI
- validation bar with concrete acceptance checks
- open decisions that still need human judgment

If existing plans or implementation already exist, do not stop at "this is
mostly implemented." Produce one of: accept as-is, accept with gaps, or
redesign. Include a gap assessment covering evidence, missing behavior, risk,
and acceptance signal.

### 9. Recommend The Next Move

Choose one option.
Say why.

Possible next moves:

- revise the existing implementation directly
- write or update a design standard such as `doc/DESIGN.md`
- write or update an architecture or workflow doc
- invoke a specialized skill
- stop implementation and gather missing evidence first

The recommendation should be explicit, not "it depends" by default.

### 10. Write Plan doc before run

Before you run, write your detail plan in `doc/plans`, then start your work.
- DO NOT write your plan before user confirm.
- If there are only some minor modifications, no plan is required, such as minor bug modifications, minor interface changes, etc.
- Before writing a proposal or implementation plan, read `references/plan-doc-templates.md`.
Record related commit info in plan's doc after finishing your work. (amend commit this change also)

## Standard-Gap Heuristic

Escalate from local fix to standards work when at least one is true:

- the same class of mistake has happened more than once
- multiple contributors or models will touch similar surfaces
- the feedback is recurring but still informal
- quality depends on taste that has not yet been codified
- the current disagreement is really about principles, not one pixel change

Typical outputs of a standards intervention:

- `doc/DESIGN.md`
- a page-specific spec
- an architecture note
- a review checklist
- updated repo instructions

## Output Format

Default to this structure:

### What You're Actually Asking

One short paragraph reframing the real need.

Include the evidence used when the request is grounded in a repo, product,
UI surface, workflow, implementation, trace, benchmark, or prior artifact.
If you have not inspected enough evidence yet, say "not enough evidence yet"
and identify the missing context instead of claiming full understanding.

### Diagnosis

- primary layer
- secondary layer, if any
- one sentence on why this is the real issue

When relevant, also include:

- evidence source: trace, benchmark, score, dataset, or qualitative review
- evidence quality: strong enough, missing, or misleading

### Evaluation Criteria

3-6 bullets defining how to judge the next iteration.

### Scenario And Requirements Map

Default to including this section. Omit it only for explicit quick takes or
tightly scoped local checks where the scenario map would add noise.

- actors and lifecycle states considered
- requirement classes derived from the scenarios
- non-goals and boundaries
- important corner cases and failure modes
- assumptions or evidence that would change the conclusion

### Options

- Option A
- Option B
- Option C, if meaningful

### Recommended Proposal

Expand the chosen option enough for review and approval.

For engineering, platform, workflow, or product-behavior requests, use
subsections instead of a compact paragraph:

- Gap Assessment, when existing code or plans are present
- Concept And Non-Goals
- User Or Operator Flow
- Technical Architecture
- Execution And State Transitions
- Edge Cases And Recovery
- Scenario Coverage, when the user requested scenario/corner-case analysis
- Implementation Surface
- Validation Bar
- Open Decisions

For visual or interaction critique, use the relevant subset of those headings
and replace technical sections with concrete UI states, hierarchy, density,
copy, responsiveness, and inspection criteria.

### Recommendation

One short paragraph with the recommended next move.

### Next Move

A concrete action:

- a doc to create
- a skill to invoke
- a code area to revisit
- a review pass to run

## Advisor Style

Be direct and specific.

Good:

- "This is not mainly a CSS problem. It is a missing design-governance problem."
- "The modal is acting like a stage, not a tool."
- "Your complaint is valid, but it needs to be translated into hierarchy and density rules."
- "This is not mainly an agent-quality problem. Your benchmark is collapsing distinct failure modes into one score."
- "The traces are present, but they are not decision-useful yet."

Bad:

- "There are many possible improvements."
- "It could maybe use some polish."
- "Let's just try another version."

## Build-Advisor Routing Rules

After diagnosis, route decisively:

- If the issue is mostly idea quality before implementation, recommend `office-hours`
- If the issue is mostly visual quality on a concrete surface, recommend `design-review`
- If the issue is mostly engineering plan quality, recommend `plan-eng-review`
- If the issue is mostly workflow confusion in Rudder, recommend `rudder-gstack-guide`
- If the issue is mostly standards missing from the repo, recommend writing the missing doc first
- If the issue is mostly trace quality, score design, benchmark interpretation, or agent-eval evidence, combine with `langfuse`
- If the issue is mainly a bug or regression, recommend `investigate`

When a direct local answer is enough, provide it.
When a specialist is the right next move, say so clearly.

## Validation Cases

### Case: Engineering Proposal Depth

Input:
"Agent 可以并发执行任务，可以在 Agent config 里配置 run 并发度，默认 3。用 build-advisor 设计一下这个功能。"

Expected behavior:
The response includes a decision-ready proposal with user/operator flow,
source of truth, API/data/config contract, execution flow, state transitions,
edge cases, implementation surface, validation bar, and open decisions.

Must not:
Return only a short recommended option, a few bullets, or a generic
"direction is right, next validate it" answer.

### Case: Existing Implementation Found

Input:
"这个功能好像已经有 plan 和一部分代码了，帮我判断怎么做。"

Expected behavior:
The response first states whether the existing work should be accepted as-is,
accepted with gaps, or redesigned. It includes a gap assessment with evidence,
missing behavior, risk, and acceptance signal before the recommended proposal.

Must not:
Stop after listing discovered files or saying the current implementation mostly
matches the direction.

### Case: Evidence-Grounded "Do You Understand?"

Input:
"优化 UI，Run transcript 这里先告诉我你懂我的需求了吗" plus screenshots of
the current surface and a repository skill invocation.

Expected behavior:
Before saying the need is understood, inspect the screenshot plus the relevant
design docs and likely component files. The response says what evidence was
reviewed, identifies the real issue as an information hierarchy / density
problem if supported by that evidence, and separates symptoms from the deeper
need.

Must not:
Reply only with "懂了" and a surface paraphrase of the screenshot before
checking the local docs or code.

### Case: Shared Interaction Request

Input:
"UX 优化，chat 这里，我希望点击这些会弹 menu 选项的，我希望这个 menu 需要加一个动画，一个弹出的动画，生动的感觉。build-advisor 先说说懂我需求了吗"
plus a screenshot of several menu triggers.

Expected behavior:
Inspect the screenshot, the relevant chat/menu components, and design guidance
before concluding. The response should distinguish whether this is a single CSS
animation, a shared menu primitive, or a broader interaction-standard gap, and
name the evidence behind that diagnosis.

Must not:
Infer a final implementation direction such as "add scale + opacity + translate
to all dropdowns" without first checking how menus are actually implemented.

### Case: Explicit Quick Take

Input:
"快速看下这个方向有没有大问题，不要写长方案。"

Expected behavior:
The response stays concise, calls out the main risk, and names the next move.

Must not:
Force the full proposal template when the user explicitly asked for a quick
take.

### Case: Scenario-First Workflow Semantics

Input:
"现在 issue follow-up, reviewer 等机制，会强制加速 issue 偏向收敛，但还有一个 case：TODO 状态时，在 issue 里讨论的情况。我们从场景和需求出发，这件事会有哪些需求和场景，第一性原理，深度分析各种可能的情况，corner cases，直到你 100% 确认自己的分析都考虑到了。"

Expected behavior:
The response starts from the user/operator/agent/reviewer scenarios and
distinguishes discussion, clarification, question, work request, review
feedback, reopen, and escalation intents before proposing mechanics. It maps
requirements and corner cases across issue lifecycle states, then recommends
an explicit intent model or equivalent structural fix.

Must not:
Jump directly to one UI checkbox, one route handler, or one follow-up rule as
the whole answer. Must not claim literal perfect coverage; it should state the
coverage boundary and remaining assumptions.

### Case: Screenshot-Driven Visual Options

Input:
"这个 UI 感觉不对，先给我几个差异明显的方案做成一个 HTML 对比。" plus
screenshots of the current surface.

Expected behavior:
The response inspects the screenshot and relevant design/component context, then
creates a concrete comparison artifact such as a single HTML file or clear
wireframes. Each option states its hierarchy, density, tone, and tradeoff.

Must not:
Skip directly to editing the component, or return only abstract advice like
"make it cleaner" without an inspectable visual artifact.

### Case: External Product Reference Research

Input:
"https://moxt.ai/ 这个产品很像 Rudder 理想中的样子。深度调研一下，从用户视角和 Agent 视角看 docs/workspaces/resources 应该怎么收敛。"

Expected behavior:
The response treats the external product and the user's interpretation as
evidence, inspects available source material, separates product principle from
surface imitation, maps implications through both operator and agent workflows,
and produces a decision-ready Rudder proposal with source of truth,
concept/naming convergence, implementation surface, and validation bar.

Must not:
Give a generic competitor summary, add another top-level concept without
collapsing existing terminology, or copy the reference product's UI pattern
without proving it solves the same Rudder workflow.

### Case: Approved Implementation Handoff

Input:
"可以，就按照你的方案 A 来改好了."

Expected behavior:
The skill stops producing advisor-only analysis and switches to normal
implementation mode. It edits the relevant files, verifies the user-visible
surface when applicable, and reports validation results.

Must not:
Write another long proposal, ask for confirmation again, or keep the work in
analysis-only mode.

### Case: Small UI Fix With Explicit Scope

Input:
"这里 title 和 description 颜色不对，优化一下." plus a screenshot.

Expected behavior:
The response performs a narrow evidence check, identifies the exact visual state
and likely component, then either makes the small fix or asks for only the
missing evidence needed to make it. It keeps the validation bar focused on the
affected state.

Must not:
Run the full scenario map, create a plan document, or broaden the work into an
unrequested redesign.

## Completion Standard

This skill has done its job when the user can answer all three:

1. What is actually wrong?
2. How should we judge the next iteration?
3. What should we do next?

If any of those remain fuzzy, keep working the diagnosis.
