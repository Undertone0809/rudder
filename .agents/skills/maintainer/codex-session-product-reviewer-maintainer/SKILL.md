---
name: codex-session-product-reviewer-maintainer
description: >
  Review a local Codex session, task, or commit as a professional product
  manager and first-principles reviewer. Use when the user gives a Codex
  session id, asks to review another agent's task, says "PM review",
  "professional product manager", "first principles", "第一性原理",
  "作为 reviewer", "review 一下 codex session", or wants a judgment on whether
  an implemented task solved the right product problem. Pull evidence from
  local Codex logs and repo artifacts before judging.
---

# Codex Session Product Reviewer Maintainer

This skill reviews a completed or in-progress Codex task from a product
manager's point of view. It is a reviewer workflow, not an implementation
workflow.

The core question is:

> Did this session solve the right product problem, with the right scope,
> behavior, and validation?

Use it to turn a vague request like "review this Codex session as a PM" into a
grounded product review based on the session transcript, actual code changes,
tests, plan docs, and repository product standards.

## Use When

Use this skill when the user asks to:

- review a Codex session id, task, thread, or run as a product manager
- evaluate whether another agent's implementation was product-correct
- apply first-principles thinking to a shipped task
- judge whether a proposal or implementation solved the right user problem
- produce a reviewer-style accept / conditional accept / reject
- translate fuzzy dissatisfaction into explicit product critique

Common trigger phrases:

- "review 一下 codex session id ..."
- "as a 专业的产品经理 review"
- "第一性原理思考一下"
- "作为 reviewer"
- "PM review this task"
- "这个 session 做得怎么样"
- "这个实现是不是产品上对"

## Do Not Use When

Do not use this skill for:

- generic code review where the user mainly wants bugs and line comments
- debugging a failed Rudder agent run transcript
- creating a new product idea or brainstorming from scratch
- implementing the fixes found during review, unless the user explicitly asks
- summarizing a session without judgment
- judging only from the final assistant message when local evidence is
  available

If the user asks for code correctness review, use a code-review workflow.
If the user asks why a Rudder agent run failed, use the run transcript debugging
workflow first.

## Inputs

Required:

- A Codex session id, commit hash, PR, branch, or clearly identified task to
  review.

Optional:

- The review lens, such as PM, first principles, design, workflow, release, or
  founder mode.
- A desired output style, such as short verdict, detailed memo, or findings
  only.

## Evidence Collection

Never start with opinion. Build the evidence packet first.

1. Locate the Codex session.
   - Search `~/.codex/session_index.jsonl`, `~/.codex/sessions/**/*.jsonl`,
     and `~/.codex/archived_sessions/*.jsonl` for the session id or prefix.
   - Confirm the session title, timestamp, cwd, branch, and final assistant
     message.
   - If the session cannot be found, say that and review only the artifacts the
     user provided.

2. Extract the real user request and corrections.
   - Ignore injected `AGENTS.md`, environment context, skill bodies, and system
     text.
   - Capture each meaningful user prompt, especially mid-task corrections such
     as scope changes, product constraints, or "also consider..." feedback.

3. Extract what the agent actually did.
   - Summarize proposals, plans, implementation steps, changed files, commands,
     validation results, commits, and pushes.
   - Use `git show`, `git diff`, plan docs, tests, and relevant source files
     when a commit or file path is mentioned.
   - Distinguish committed changes from unrelated dirty worktree changes.

4. Read the relevant product context.
   - Start with `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`,
     and `doc/DESIGN.md` when the task affects product behavior or UI.
   - Read the task's plan doc if one exists.
   - For release, desktop, plugin, database, or CLI work, follow the relevant
     AGENTS.md doc route.

5. Check validation evidence.
   - Record which focused tests, full checks, E2E tests, builds, screenshots,
     or browser checks actually passed.
   - Treat "attempted but timed out" as unverified, not as passed.
   - For visible UI changes, look for real visual verification of the non-empty
     and edge-case states, not only empty states.

## First-Principles Review Frame

Use this frame before writing the verdict:

1. User job
   - What real user or operator problem was this task supposed to solve?
   - Was the original request a symptom of a deeper workflow or information
     architecture issue?

2. Object model
   - What is the product object really? View, navigation shortcut, workflow
     state, preference, project artifact, run, issue, or setting?
   - Did the implementation model it as the correct kind of object?

3. Core loop impact
   - Does the change help Rudder complete real agent-work loops end to end?
   - Does it reduce operator friction, improve control, or clarify agent work?

4. Scope discipline
   - Did the agent delete or avoid unnecessary surface area?
   - Did it create a new concept when an existing one should have been reused?
   - Did it handle the user's explicit edge cases?

5. Behavioral completeness
   - Are the important entry points covered?
   - Does the behavior remain correct for empty, normal, long, cross-org,
     mobile, direct-link, and legacy-link states when relevant?

6. Trust and validation
   - Did the agent prove the change works in the states users actually care
     about?
   - Are failed or skipped checks clearly separated from passing checks?

## Review Method

Follow this sequence.

1. State the evidence basis.
   - Mention the session id, title, date, commit hash if present, and files or
     plan docs inspected.

2. Give the verdict early.
   - Use one of: `accept`, `conditional accept`, `reject`, or `needs more
     evidence`.
   - Add a numeric score only if useful.

3. Explain the product essence.
   - In one paragraph, say what the task was really about.
   - Translate UI wording into product language. For example, "recent views in
     main content feels wrong" becomes "navigation history was mis-modeled as a
     workspace view."

4. Name what was right.
   - Focus on product decisions, not implementation busywork.
   - Explain why the chosen model fits or does not fit Rudder's operating
     layer.

5. Name the gaps.
   - Prioritize product correctness, behavioral gaps, missed edge cases,
     validation gaps, and scope mistakes.
   - Be concrete: cite files, lines, tests, or session events when possible.
   - Separate "not done" from "not proven."

6. Recommend the next move.
   - Give one pragmatic follow-up, not a wishlist.
   - Say whether to keep direction, patch behavior, rewrite spec, gather
     evidence, or reject and reframe.

## Output Shape

Default to Chinese when the user asks in Chinese.

Keep the final review compact:

```markdown
结论：...

我会给这次任务：7/10，conditional accept。

做得好的地方：
- ...

关键缺口：
1. ...
2. ...

下一步建议：...
```

For higher-stakes reviews, add:

- Evidence inspected
- First-principles diagnosis
- Product acceptance criteria
- Residual risks

Do not bury the verdict after a long transcript summary.

## Judgment Rules

- A session can be directionally correct and still not product-done.
- Passing typecheck/build does not prove product behavior.
- A failed E2E launch is not a product failure by itself, but it leaves the
  affected user flow unverified.
- A visible UI task is not fully reviewed unless at least the relevant rendered
  states were inspected or explicitly marked unverified.
- "Too many items" should be reviewed as an experience question, not only as a
  rendering limit.
- Compatibility paths should not preserve the old wrong mental model.
- The best review says which part to keep, which part to patch, and why.

## Common Findings To Look For

- Mis-modeled product object: history treated as a view, settings treated as
  content, workflow state treated as global preference.
- Incomplete entry points: only list clicks record behavior, but direct detail,
  board cards, sidebar links, deep links, or mobile paths do not.
- Validation mismatch: tests cover the new API but not the actual operator path.
- Edge-case theater: code handles a number limit but not whether that limit is
  the right product experience.
- Over-scoped fix: the implementation adds management UI when a small recovery
  affordance was enough.
- Under-scoped fix: the implementation moves UI but leaves the underlying
  behavioral contract inconsistent.

## Boundaries

Do not edit code during this review unless the user explicitly asks to fix the
findings. If asked to fix, switch from reviewer mode to normal implementation
mode and follow repository validation and commit rules.

Do not claim certainty about user satisfaction from logs alone. Phrase such
claims as evidence-based judgment, not truth.

Do not quote long chunks of the transcript. Summarize the evidence and cite the
local file paths or commit hashes that matter.
