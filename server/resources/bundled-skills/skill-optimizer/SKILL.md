---
name: skill-optimizer
description: Improve, debug, benchmark, or refactor an existing Agent Skill from conversation evidence, execution traces, user corrections, eval failures, or target skill files. Use this skill whenever the user asks to optimize, harden, generalize, validate, benchmark, package, or turn observed behavior into durable skill changes. Produces evidence-based diagnosis, reviewable patches, trigger evals, validation cases, and safe next-run behavior; do not use it to perform the target skill's normal task.
---

# Skill Optimizer

## Mission

Turn real usage evidence into safer, more reliable, easier-to-trigger, and easier-to-evaluate Agent Skills.

This is a meta-skill. It does not merely rewrite prose. It analyzes the fit between a skill's purpose, trigger description, inputs, procedure, tools, outputs, risks, examples, and evaluations, then proposes small reviewable changes.

## Use when

Use this skill when the user asks to improve, optimize, debug, refactor, benchmark, validate, generalize, harden, package, or document another skill. Also use it when the user says the current conversation should be captured into a skill, or that a previous skill run exposed something that should happen differently next time.

Do not use this skill for ordinary task execution. If the user asks to run the release skill, do not optimize the release skill unless they ask to improve it.

## Modes

- Diagnose: identify what should change without writing a patch.
- Patch: produce a reviewable diff, replacement section, or revised `SKILL.md`.
- Validate: create validation cases and failure-mode checks.
- Benchmark: compare the old and new skill using task cases, trigger cases, and deterministic rubrics.
- Package: organize the skill folder, references, scripts, examples, changelog, and README.

## Required inputs

Infer these from the conversation before asking follow-up questions:

- target skill name and purpose
- current `SKILL.md` and supporting files, if available
- execution evidence: user request, tool use, output, corrections, mistakes, delays, or surprises
- environment: chat, code agent, workspace agent, API, or another harness
- intended optimization mode
- risk level and write-action authority
- sequencing constraints when optimization is requested after another live task

If the target skill file is unavailable, do not fabricate an exact diff. Produce an inferred improvement plan, draft replacement sections, validation cases, and assumptions.

If the user asks to optimize a skill after completing another concrete task, finish and verify the concrete task first unless they explicitly ask to pause it. Then optimize from the observed evidence. Do not interrupt the user's primary workflow just because this skill is mentioned.

## Universal optimization lens

Analyze every target skill through these lenses:

1. Purpose and scope: what job the skill owns, who it serves, and what it must not do.
2. Triggering and boundaries: description quality, should-trigger cases, near-negative cases, competing skills, and under/over-triggering risks.
3. Inputs and assumptions: required inputs, source of truth, missing-data behavior, units, locale, time horizon, and user preferences.
4. Workflow and decision rules: ordered steps, branch conditions, heuristics, stop conditions, escalation paths, and exception handling.
5. Tools and authority: required tools, permissions, external writes, approvals, dry runs, and exact operations.
6. Outputs and interfaces: templates, file formats, citations, links, machine-readable fields, handoff artifacts, and user-facing summaries.
7. Quality bar and evaluation: success criteria, deterministic verifiers, examples, regression tests, trigger evals, and human review points.
8. Safety, privacy, and policy: sensitive data, regulated advice, consent, audit trail, access control, retention, and harmful misuse.
9. Failure and recovery: blocked states, retries, rollback, partial completion, cleanup, and user-visible status.
10. Maintainability: concise instructions, bundled resources, changelog, version notes, known limitations, and portability across harnesses.

Use `references/universal-optimization-lens.md` when a deeper diagnosis is needed.

## Evidence rules

Treat the current conversation as evidence, not as a script to memorize.

For each important observation, capture:

- Evidence: what happened or what the user corrected.
- Root cause: why the current skill allowed it.
- Durable change: what should be added, removed, or clarified.
- Classification: one-off instruction, reusable workflow rule, user/team preference, conflicting instruction, or open question.

Do not overfit one unusual task into a permanent rule. Convert it into a reusable rule only when it improves future behavior.

Treat strong user corrections as high-signal evidence. Phrases like "no", "not this", "wrong direction", "first principles", or a correction from a component-level answer to a user-scenario answer usually indicate a framing failure, not just a missing detail. Capture:

- the wrong abstraction level the previous run optimized for
- the user's intended source of truth
- what should have been downstream evidence rather than the starting point
- how the target skill should avoid the same drift next time

When the evidence comes from a multi-step execution, include the verification results, not only the final prose. A durable skill change should be grounded in what was requested, what was attempted, what was corrected, and what was ultimately validated.

## Framing and abstraction checks

Before proposing a patch, ask whether the target skill optimized the right object:

- User outcome vs. UI surface: a feature or component may be only a view over a deeper workflow.
- Scenario spine vs. fixture rows: realistic data should come from causal user activity, not isolated screen states.
- Source of truth vs. derivative signal: logs, runs, issues, costs, or decisions may be primary; dashboards, calendars, and summaries may be downstream.
- Product intent vs. local convenience: read available product, requirement, or reference docs before encoding a domain rule from one conversation.

If the observed failure is "the answer satisfied the visible surface but missed the user's real scenario", make that explicit in the diagnosis and add a workflow guard to the target skill rather than only adding more examples.

## Patch rules

Prefer small, auditable patches over broad rewrites. Preserve the target skill's identity, useful examples, and safety constraints.

A patch may change:

- frontmatter description and trigger boundaries
- required inputs and assumptions
- workflow steps and decision rules
- output templates
- safety and approval requirements
- failure handling
- examples and references
- validation cases and benchmark tasks

Never silently weaken safety requirements. For write actions, publishing, financial actions, medical or legal consequences, hiring decisions, external communication, deletion, deployment, migration, or permissions changes, require explicit authority unless the target skill already has a clear safe policy.

## Trigger optimization

The frontmatter description is the primary discovery signal. After improving a skill, evaluate whether the description should change.

Create trigger evals with:

- realistic should-trigger queries
- realistic should-not-trigger near misses
- ambiguous cases where another skill might be more appropriate
- casual phrasing, typos, file paths, role context, and domain language

Optimize for accurate triggering, not maximum triggering.

## Domain adaptation

This skill is domain-general. Do not bake one domain's checklist into the core instructions.

When the domain matters, attach or consult a short domain adapter. A good adapter names:

- source of truth
- required inputs
- review owner
- consequential actions and approval gates
- privacy, confidentiality, or consent constraints
- output template
- validation cases and deterministic checks
- must-not behaviors

Use the transcript to extract observed domain markers, but do not encode hidden rubric terms or unrelated best practices as mandatory rules. Keep adapters modular so the optimizer can handle software, healthcare operations, law, finance, education, research, HR, customer support, operations, creative work, personal productivity, and other workflows.

Use `references/domain-adapter-patterns.md` when building or selecting an adapter. If a matching file exists under `references/adapters/`, consult it as a compact checklist rather than copying it wholesale into the target skill.

## Validation format

Every meaningful behavior change needs at least one validation case.

Use this format:

```md
### Case: <name>

Input:
...

Expected behavior:
...

Must not:
...
```

Include at least one normal case, one edge case, and one regression case when the change could break prior behavior.

## Benchmark reporting

When running evals, separate three scores:

1. Trigger accuracy: whether Skill Optimizer should activate.
2. Patch-quality coverage: whether the proposed change includes evidence, scope classification, patch, safety, outputs, and validation.
3. Downstream transfer: whether the optimized target skill actually improves on its own task suite.

Label synthetic verifier scores as synthetic. Do not report them as official benchmark or leaderboard results.

## Packaging expectations

When packaging a skill or skill optimizer project, include:

- `SKILL.md` and supporting references
- README with purpose, installation, usage, eval, limitations, and license
- changelog and version note
- examples of target skills and optimization outputs
- eval cases or a lightweight benchmark harness when available
- a distributable zip that contains exactly one skill folder for installation

## Final response contract

Return these sections unless the user asks for a narrower result:

1. Target skill and optimization mode
2. Diagnosis summary
3. Evidence ledger
4. Improvement categories
5. Proposed patch or revised skill draft
6. Trigger eval suggestions when discovery may change
7. Validation cases
8. Benchmark or eval result, if run
9. Assumptions, conflicts, and unresolved questions

When direct file editing is available and the user explicitly requested edits, apply the patch. Otherwise present a reviewable patch.

When optimization is part of a larger completed workflow, keep the final response proportional: report the primary task result first, then the skill changes and validation. Do not force the full nine-section contract if it would obscure the work the user was actually trying to finish.

## Quality bar

A successful optimization makes the next run of the target skill more predictable, easier to trigger correctly, safer around irreversible actions, clearer in output, and easier to verify.
