---
name: build-advisor
description: >
  Expert advisor for moments when the user knows a build result is wrong but
  cannot yet express the right product, design, or engineering critique. Use
  when the user says a feature feels off, the AI-built result is poor, they do
  not know how to give better feedback, they want professional diagnosis before
  more implementation, or they want help translating vague dissatisfaction into
  explicit standards, recommendations, and next steps. Especially useful when
  the user says the result feels wrong, asks for a professional critique before
  more implementation, wants best-practice research first, wants help deciding
  what is actually wrong and what to do next, or has traces, benchmarks, evals,
  or score data but needs help turning that evidence into a product,
  UX, engineering, or workflow diagnosis. When the discussion is grounded in
  Langfuse traces, scores, datasets, or experiment results, combine this skill
  with `langfuse` instead of reasoning from vague impressions alone.
---

# Build Advisor

This skill exists for the moment after "something was built" but before the user has a clean professional critique.

It is not an implementation skill first.
It is a diagnosis, translation, and routing skill.

Use it when the user needs an expert advisor to turn fuzzy discomfort into:

- a clearer problem statement
- a professional diagnosis
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
- "I know the result is too big / too noisy / too complicated, but I need better language."
- "The trace or benchmark says one thing, but the result still feels wrong. Help me make sense of it."
- "We have Langfuse traces / scores / evals, but I need help deciding what they actually imply."

## What This Skill Does Not Do

Do not treat this as a direct code-writing skill by default.

It should not:

- jump into implementation before diagnosis
- pretend every problem is a UI styling issue
- replace specialized execution skills when the right next step is obvious
- produce vague "looks better / feels cleaner" advice without criteria

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

### 1. Reframe The Ask

State plainly:

- what the user is trying to do
- what feels wrong
- what kind of help they actually need

Example:
"You do not need another blind iteration. You need a professional diagnosis of why this result feels wrong, plus the right next move."

### 2. Diagnose The Layer

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

### 3. Search Before Advising

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

### 4. Translate Vague Dissatisfaction Into Professional Language

Turn the user's intuition into explicit critique.

Examples:

- "too big" -> poor surface ratio, oversized controls, inflated internal whitespace
- "too noisy" -> weak hierarchy, too many competing accents, helper copy overexposed
- "too complicated" -> poor progressive disclosure, secondary settings shown too early
- "feels generic" -> no visual thesis, weak product character, interchangeable patterns
- "hard to trust" -> unclear states, weak feedback, missing operational context
- "trace looks messy" -> span hierarchy is not revealing decision boundaries, so failure analysis is shallow
- "benchmark improved but quality feels worse" -> the eval rubric is rewarding the wrong behavior or averaging away the failure mode that matters
- "agent eval is unstable" -> dataset segmentation, score naming, or review criteria are too coarse to distinguish real regressions from noise

This translation step is mandatory.
It is the main value of the skill.

### 5. Build An Evaluation Frame

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

### 6. Produce Options

Always provide at least 2 options:

- one minimal / local fix
- one more structural / upstream fix

A third option is useful when there is a different framing of the problem.

For each option include:

- what changes
- what problem it solves
- what risk remains

If traces, scores, or evals are in play, say whether the option fixes the product, the instrumentation, the benchmark design, or only the interpretation layer.

### 7. Expand The Recommended Proposal

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

Keep this as a proposal, not a full implementation plan, unless the user
explicitly asks to proceed. If repo rules require a plan document before
implementation, the proposal should make that plan easy to write after
confirmation.

### 8. Recommend The Next Move

Choose one option.
Say why.

Possible next moves:

- revise the existing implementation directly
- write or update a design standard such as `doc/DESIGN.md`
- write or update an architecture or workflow doc
- invoke a specialized skill
- stop implementation and gather missing evidence first

The recommendation should be explicit, not "it depends" by default.

### 9. Write Plan doc before run

Before you run, write your detail plan in `doc/plans`, then start your work.
- DO NOT write your plan before user confirm.
- If there are only some minor modifications, no plan is required, such as minor bug modifications, minor interface changes, etc.
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

### Diagnosis

- primary layer
- secondary layer, if any
- one sentence on why this is the real issue

When relevant, also include:

- evidence source: trace, benchmark, score, dataset, or qualitative review
- evidence quality: strong enough, missing, or misleading

### Professional Translation

3-6 bullets translating the user's discomfort into explicit critique.

### Evaluation Criteria

3-6 bullets defining how to judge the next iteration.

### Options

- Option A
- Option B
- Option C, if meaningful

### Recommended Proposal

Expand the chosen option enough for review and approval. Include user
interaction flow and technical architecture when the request touches both
product behavior and implementation shape.

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

## Completion Standard

This skill has done its job when the user can answer all three:

1. What is actually wrong?
2. How should we judge the next iteration?
3. What should we do next?

If any of those remain fuzzy, keep working the diagnosis.
