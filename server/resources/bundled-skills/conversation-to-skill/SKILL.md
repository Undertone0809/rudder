---
name: conversation-to-skill
description: >
  Turn the current conversation's workflow into a reusable agent skill. Use this
  whenever the user wants to make a workflow reusable, standardize a successful
  thread, package an agent capability, or convert an ad hoc process into a
  repeatable skill. Read the thread first, extract the stable pattern, decide
  whether the skill should live in `~/.agents/skills/<name>` or
  `<project-path>/.agents/skills/<name>`, write the skill, and when quality
  matters add lightweight evals and iteration instead of just transcribing the
  chat.
---

# Conversation To Skill

This skill turns the work happening in the current conversation into a reusable
agent skill.

Its job is not just to write `SKILL.md`.
Its job is to identify the durable workflow, separate it from one-off thread
noise, decide the right packaging and placement, and produce a skill that will
actually help a future agent perform better.

When useful, this skill should borrow the practical methods of `skill-creator`:
good descriptions, clean skill structure, eval-friendly organization, and an
improve-via-feedback loop. When this skill owns evaluation, bundle the relevant
toolchain locally under `agents/`, `assets/`, `eval-viewer/`, `scripts/`, and
`references/` so it stays self-contained instead of depending on another skill
directory at runtime.

## Use This Skill For

Use this skill when the user is trying to:

- turn the current task or workflow into a reusable skill
- capture a successful collaboration pattern for future runs
- standardize how a class of tasks should be handled
- extract a repeatable agent workflow from the current thread
- package a reasoning framework, execution sequence, or artifact pattern into a skill
- upgrade an existing draft skill so it is general, usable, and easier to trigger

Typical prompts:

- "Turn what we're doing into a skill."
- "I want this conversation to become an agent capability."
- "Make this reusable for next time."
- "Abstract this workflow into a Codex skill."
- "This should be a standard operating pattern, not a one-off chat."
- "Clean up this skill and make it actually reusable."

## Do Not Use This Skill For

Do not use this skill when the user mainly wants:

- a summary of the conversation without creating a reusable skill
- immediate execution of the task with no abstraction step
- a skill generated from multiple unseen threads you cannot inspect
- a rigid template that blindly copies file paths, project names, or temporary constraints
- a generic skill factory that ignores what was actually valuable in the conversation

If the conversation does not yet reveal a stable workflow, say that plainly and
help the user clarify the reusable part first.

## Core Principles

### Capture The Repeatable Value

The skill should capture the repeatable value, not the accidental details.

A good abstraction preserves:

- the job to be done
- the trigger conditions
- the critical inputs and outputs
- the sequence of reasoning or execution
- the judgment criteria that make the workflow valuable
- the boundaries and non-goals

A bad abstraction copies:

- temporary filenames
- irrelevant project-specific paths
- incidental tools that happened to be used once
- order-of-operations that are not actually essential
- user wording that does not generalize

### Explain Why, Not Just What

Prefer instructions that explain why a step matters.
Avoid brittle mandates unless the workflow truly requires them.

If you find yourself writing a long list of rigid commands with no reasoning,
you are probably transcribing the thread instead of building a skill.

### Choose The Smallest Useful Shape

Do not overbuild the skill.
Use the smallest structure that preserves the capability:

- `SKILL.md` only, when the workflow is mostly reasoning and sequencing
- `SKILL.md` plus `references/`, when the skill needs domain guidance
- `SKILL.md` plus `scripts/`, when deterministic repeated work should be bundled
- `SKILL.md` plus `evals/`, when the skill benefits from repeatable testing

### Decide Placement Before Writing Files

Pick the skill location before creating files so the paths stay stable:

- **Global**: `~/.agents/skills/<skill-name>`
- **Project-based**: `<project-path>/.agents/skills/<skill-name>`

If the user wants a global skill to be discoverable by Codex immediately, also
create:

- `~/.codex/skills/<skill-name>` as a symlink to the global skill directory

If you plan to run evals, place the workspace next to the skill directory as:

- `<skill-name>-workspace/`

## Default Workflow

Follow this sequence unless the user already provided enough structure.

### 1. Extract The Candidate Skill From The Current Thread

Read the current conversation first.
Pull out the real workflow before asking the user to restate everything.

Capture:

- what the user was trying to achieve
- what sequence of steps the agent followed or should follow
- which tools or artifacts mattered
- what corrections or preferences the user introduced
- what output the user actually wanted
- what makes this reusable instead of one-off

### 2. Separate Stable Pattern From Incidental Context

Classify each detail into one of three buckets:

- **Core**: must stay because the skill breaks without it
- **Contextual**: useful examples or defaults, but not universal
- **Incidental**: this-thread noise that should not be baked into the skill

Useful heuristic:

- if the detail would still matter in six months on a different project, it is probably core
- if it only mattered because of this repository, filename, or user phrasing, it is probably contextual or incidental

### 3. Fill Gaps With Minimal Interview Or Research

Do not ask the user to restate the whole workflow if the thread already tells
you most of it.
Only ask for the missing pieces that affect the resulting skill:

- what this skill should enable the agent to do
- when the skill should trigger
- what output format or artifact the user expects
- whether lightweight test prompts would help validate the result

If examples, edge cases, dependencies, or adjacent skills matter, gather that
context before writing the final version.

### 4. Produce An Abstraction Brief Before Writing Files

Before generating the final skill, write a short abstraction brief for the user
to review unless they already said to just build it.

Use this structure:

```markdown
## Skill Intent
- Name:
- Goal:
- Why this should exist:

## Trigger
- Use when:
- Do not use when:

## Inputs
- Required inputs:
- Optional inputs:

## Outputs
- Main deliverable:
- Secondary artifacts:

## Workflow
1. ...
2. ...
3. ...

## Judgment Rules
- What must stay true:
- What to avoid:

## Open Questions
- ...
```

If the conversation already settles these points, keep the brief short and move
on.

### 5. Challenge Weak Abstractions

Do not act like a passive stenographer.
If the proposed skill is overfit, under-scoped, or missing the real judgment
logic, say so and correct it.

Common failure modes to call out:

- "This is a transcript, not a skill."
- "These instructions depend on this exact repo, but the user asked for a global skill."
- "The workflow says what to do, but not how to decide when a step is necessary."
- "The description would under-trigger because it only names one phrasing."
- "This skill repeats manual work that should be moved into a bundled script."

### 6. Decide Location, Shape, And Scope

Make these decisions before writing:

- whether the skill is global or project-based
- whether to preserve an existing name and directory
- whether `SKILL.md` alone is enough
- whether the skill needs `references/`, `scripts/`, `assets/`, or `evals/`
- whether a sibling workspace should be created for testing

Default location rules:

- **Global skill**: `~/.agents/skills/<skill-name>`
- **Project-based skill**: `<project-path>/.agents/skills/<skill-name>`

If updating an existing skill, preserve the directory name and frontmatter name
unless the user asked for a rename.

### 7. Write The Skill Like A Real Skill

When writing `SKILL.md`, include:

- frontmatter with `name` and a trigger-oriented `description`
- what the skill is for
- when to use it and when not to use it
- the default workflow
- output expectations
- edge cases and boundaries when they materially affect quality

Bring in the `skill-creator` quality bar here:

- make the description a little aggressive so hosts do not under-trigger it
- include both what the skill does and the contexts that should trigger it
- prefer imperative instructions
- explain the reasoning behind important steps
- keep the file readable; if it grows too large, move detail into references

### 8. Use Clean Skill Structure

Prefer this structure when it helps:

```text
skill-name/
├── SKILL.md
├── references/
├── scripts/
├── assets/
└── evals/
```

Use progressive disclosure:

1. metadata in frontmatter should be enough to trigger the skill
2. `SKILL.md` should explain the workflow clearly
3. large reference material should be loaded only when relevant

When the skill supports multiple variants or domains, organize references by
variant and tell the future agent which file to read for which case.

If the user wants more than a draft, or explicitly asks for testing,
benchmarking, or trigger tuning, add local references that capture the
evaluation workflow instead of leaving that logic implicit.

If the workflow needs actual tooling, prefer bundling it inside this skill
rather than pointing at another repo's copy.

### 9. Bundle Repeated Deterministic Work

If multiple runs of the workflow would obviously repeat the same deterministic
steps, package that work into `scripts/` instead of forcing future agents to
reinvent it every time.

Good candidates:

- file conversions
- formatting helpers
- benchmark aggregation
- schema validation
- packaging helpers

Do not add scripts just because you can.
Only bundle work that is repeated, stable, and cheaper to reuse than to re-derive.

### 10. Add Evals With The Full Suite When The Skill Warrants Them

Not every conversation-derived skill needs evals.
But if the skill produces objectively testable outputs, if the user asks for
benchmarking, or if you are iterating on quality instead of just drafting, do
not stop at a hand-wavy "light eval."

When you choose to evaluate, use the full evaluation suite:

- create 2-3 realistic test prompts and store them in `evals/evals.json`
- create a sibling `<skill-name>-workspace/` for iteration outputs
- compare `with_skill` against `without_skill` or an old snapshot
- draft assertions while runs are executing
- capture timing and grading artifacts per run
- aggregate results into a benchmark
- generate a reviewable viewer artifact for the human
- read feedback, improve the skill, and rerun into the next iteration

The detailed procedure lives in:

- `references/evaluation-suite.md` for test execution, grading, benchmark aggregation, feedback, and iteration
- `references/description-optimization.md` for trigger-query generation and description tuning
- `references/compatibility.md` and `references/schemas.md` for host differences and file formats

The local support toolchain lives in:

- `agents/` for grader, comparator, and analyst instructions
- `assets/` for review UI assets
- `eval-viewer/` for viewer generation
- `scripts/` for aggregation, optimization, validation, and packaging

If you decide evals are needed, read those reference files before proceeding.

Prefer qualitative review for subjective skills.
Prefer assertions and benchmarks for objective skills.

### 11. Iterate Instead Of Fossilizing Bad Drafts

If the first draft feels narrow, ambiguous, or weakly triggered, improve it.
Useful improvement passes include:

- description tuning for better triggering
- removing overfit instructions
- generalizing from user feedback
- turning repeated ad hoc steps into bundled resources
- simplifying sections that make the model do busywork

Do not force a full benchmark loop if the user only wants a draft.
But do not pretend the first draft is final if it clearly is not.

### 12. Close With A Clear Hand-off

After creating or revising the skill, report:

- the chosen skill name
- whether it is global or project-based
- the final path
- whether a Codex symlink was created
- whether eval files or a workspace were created
- what still needs evaluation, if anything

## Naming Guidance

Choose names that are short, clear, and capability-oriented.

Prefer names like:

- `conversation-to-skill`
- `workflow-standardizer`
- `task-to-playbook`

Avoid names that depend on this thread's temporary wording unless the user
explicitly wants that.

If updating an existing skill, preserve the existing directory name and
frontmatter name unless the user asked for a rename.

## Output Format

Unless the user wants files written immediately, start with:

1. a compact abstraction brief
2. the proposed skill name and placement
3. any risks of overfitting or under-specification

If the user asks to proceed, then write the files.

When the user already said "build it" or "just make it", go straight from the
brief into file creation in the same turn.

If you also set up evals, mention:

- the test prompts
- what is being compared
- where the reviewable output lives

## Quality Bar

The resulting skill should make a future agent meaningfully better at the task.

That usually means it captures at least one of these:

- a reusable workflow
- a reusable decision framework
- a reusable artifact format
- a reusable boundary or escalation rule

Strong skills often also have at least one of these:

- a well-targeted description that triggers reliably
- a clean placement and file layout
- a bundled helper for repeated deterministic work
- a full eval loop that makes improvements testable

If it captures none of those, it is probably not a real skill yet.

## Safety And Boundaries

Do not create misleading, hostile, or surprise-heavy skills.
The skill should do what its description honestly suggests.

Do not package instructions that facilitate unauthorized access, harmful
automation, or disguised exfiltration.

Roleplay, stylistic framing, and benign workflow abstraction are fine.
