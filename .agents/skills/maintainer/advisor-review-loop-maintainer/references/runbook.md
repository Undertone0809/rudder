# advisor-review-loop-maintainer Runbook

This file preserves the detailed pre-template maintainer instructions. Load it when the thin `SKILL.md` entrypoint does not contain enough operational detail for the active route.

---

# Advisor Review Loop Maintainer

This skill chains existing Rudder maintainer practices:

- `build-advisor`: turn fuzzy dissatisfaction or a high-stakes request into a
  grounded scenario analysis, requirement map, options, and recommended plan.
- `agent-work-reviewer-maintainer`: independently judge whether the result
  solved the right product problem with sufficient behavior, evidence, and
  validation.
- `product-acceptance-verifier-maintainer`: when the loop evaluates delivered
  product behavior rather than a proposal artifact, prove black-box acceptance
  before final review.

Use this skill when the work should not be accepted after one author pass. The
goal is to create a reviewable proposal or implementation, expose it to
independent pressure, revise it, and only hand off once the remaining risk is
explicit.

## When to Use

Use this skill for Rudder development tasks where the user asks for any of:

- Build Advisor followed by reviewer agents
- first-principles product, scenario, or requirement analysis that must pass
  independent reviewers, repeated review rounds, or an explicit acceptance gate
- deep corner-case coverage before implementation or handoff
- two review iterations before the final answer
- "no pass, keep reworking" behavior
- review of a plan, skill, workflow, feature, UI, architecture, release
  verification, or completed agent task where correctness depends on product
  judgment and an acceptance gate

Do not use this skill for a narrow bug fix, simple command, ordinary code
review, direct release execution, or a generic first-principles advisory task
where the correct specialized skill can execute directly.

If the user explicitly names this skill for a narrow screenshot-driven UI fix
but does not ask for reviewer agents, repeated rounds, "no pass then rework",
or an acceptance gate, use the lightweight route:

1. Do a short advisor check to confirm the UI problem and non-goals.
2. Hand the implementation to `rudder-ui-polish-maintainer` discipline.
3. Report that this was a lightweight advisor route, not a full reviewer loop.

Do not spend a full two-reviewer loop on small color, spacing, label, icon,
badge, menu-position, or redundant-wrapper fixes unless the user explicitly
asks for that review bar.

## Inputs

Resolve these before starting:

- Target artifact: proposal, plan doc, skill, code diff, PR, commit, release,
  UI state, transcript, or workflow.
- Requested mode: proposal-only, implementation, review-only, or
  proposal-then-implementation. Treat "给你 new worktree", "自己做实验",
  "把这个问题解决", "try harder", or equivalent escalation after prior advice as
  experiment/implementation mode unless the user explicitly says proposal-only.
- Evidence source: repo files, docs, screenshots, logs, traces, commits,
  branches, PRs, eval outputs, or user-provided artifacts.
- Review bar: what must be true before the result can be accepted.

If the user is explicit, infer reasonable defaults and proceed. Ask only when
the target artifact or requested mode cannot be determined safely.

Respect `review-only` strictly. In review-only mode, produce the advisor frame,
review findings, verdicts, and smallest changes needed, but do not edit files,
rewrite the artifact, or continue into implementation unless the user
explicitly asks for rework after seeing the findings.

When the user escalates from architecture discussion to a new worktree or asks
the agent to experiment and solve the issue, stop repeating the advisory answer.
Reclassify the loop as `proposal-then-implementation` or direct
`implementation`:

- rebuild branch and dirty state in the provided worktree
- identify the falsifiable hypothesis from the advisor pass
- run the smallest experiment that can prove or disprove it
- implement the fix only after the experiment points to a concrete change
- review the actual diff and validation evidence, not the earlier proposal
- commit and push only scoped files for the solved task

When the conversation resumes after a `turn_aborted`, `/goal`, or a long-running
implementation checkpoint, rebuild the current state before continuing:

- inspect branch and dirty state
- identify partial commits, merge/conflict state, and running verification
- restate the remaining task list and proof still missing

Do not assume the previous turn finished cleanly just because the next user
message says to continue.

## Default Workflow

### 1. Build the evidence packet

Collect the smallest set of evidence that can support real judgment:

- repo instructions and relevant docs
- current branch, dirty state, commits, PRs, or target files
- existing plans, specs, screenshots, traces, or eval results
- the two source skills when this workflow depends on their contracts:
  `.agents/skills/build-advisor/SKILL.md` and
  `.agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md`
- `.agents/skills/maintainer/product-acceptance-verifier-maintainer/SKILL.md`
  when the artifact is delivered behavior that needs black-box acceptance

For Rudder product or workflow work, read the relevant subset of
`doc/product/GOAL.md`, `doc/product/PRODUCT.md`, `doc/product/README.md` plus relevant `doc/product/domains/**`, and
`doc/engineering/DESIGN.md` when UI is involved.

Keep the packet focused. Do not scan the whole repository just to look busy.

### 2. Run the advisor pass

Follow the `build-advisor` discipline before drafting or accepting the target:

- reframe what the user is actually trying to accomplish
- diagnose the primary layer of the problem
- map actors, lifecycle states, intents, and failure modes
- collapse scenarios into requirement classes
- identify non-goals and boundaries
- cover corner cases that could change the design
- define a concrete evaluation rubric
- compare realistic options
- expand the recommended option into a decision-ready artifact

Do not claim literal "100% certainty." Instead, state the coverage boundary:
what scenarios were considered, what evidence supports them, and what new
evidence would change the conclusion.

### 3. Choose reviewer lenses

Reviewer count follows risk, not habit.

Use three distinct reviewer lenses for consequential proposals, workflow
changes, skills, agent-visible contracts, UI/product journeys, architecture,
release readiness, Desktop/runtime/CLI decisions, prior failed handoffs, or any
task where the user explicitly asks for adversarial or heuristic pressure:

- functional trust: contracts, evidence, validation, org scoping, control-plane
  invariants, implementation feasibility, and handoff trust
- adversarial: hidden assumptions, wrong abstraction level, weak proof,
  overfitting, conflicting docs, untested actor paths, and product-wrong
  outcomes
- heuristic/product-systems: whether this is the right problem, smallest
  durable slice, missing actor journey, teachable contract, second-order
  consequences, and future maintenance shape

For narrow proposal review, mechanical skill/doc changes, or low-risk
non-product artifacts, two reviewers are acceptable only when one owns
functional trust and the other is explicitly adversarial or heuristic. Record
which lens was omitted and why.

If the artifact is delivered product behavior rather than an advisory/proposal
artifact, run or route black-box acceptance through
`product-acceptance-verifier-maintainer` before final reviewer acceptance. A
reviewer verdict does not convert missing acceptance proof into product proof.

### 4. Spawn independent reviewer agents

When subagents are available and the user asked for reviewer agents, spawn the
selected reviewers in the same turn so they evaluate independently. Record the
review execution mode as `spawned reviewers`.

Functional trust reviewer:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review this artifact as the functional trust reviewer. Focus on contracts,
evidence, validation, org scoping, control-plane invariants, implementation
feasibility, rollback/recovery, and handoff trust. Separate author-claimed proof
from proof you inspected. Give accept / conditional accept / needs more
evidence / reject, blocking gaps, and the smallest changes needed to pass.
```

Adversarial reviewer:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review this artifact as the adversarial reviewer. Try to break the framing,
requirement map, evidence, and proposed execution. Focus on hidden assumptions,
wrong abstraction level, path dependence, weak proof, overfitting to examples,
conflicting docs, untested actor behavior, and product-wrong outcomes. Give
accept / conditional accept / needs more evidence / reject, blocking gaps, and
the smallest changes needed to pass.
```

Heuristic/product-systems reviewer:

```text
Use .agents/skills/maintainer/agent-work-reviewer-maintainer/SKILL.md.

Review this artifact as the heuristic/product-systems reviewer. Judge whether
the work solves the right problem in the smallest durable way. Focus on missing
actor journeys, better questions, teachable contracts, future-proofing path,
second-order consequences, and whether a narrower or different slice would
better serve Rudder's agent-work loop. Give accept / conditional accept / needs
more evidence / reject, blocking gaps, and the smallest changes needed to pass.
```

Include the same evidence packet, target artifact, user request, and evaluation
rubric in each prompt. Also include the target artifact basis, prior blockers,
changed evidence since the last round, and whether this is a stage review or a
final handoff review. Tell reviewers they are not implementers; they should
judge and identify gaps.

If subagents are unavailable, distinguish two cases:

- When the user explicitly required spawned reviewer agents, repeated reviewer
  rounds, or an acceptance gate, record
  `blocked: spawned reviewers unavailable`. You may still provide an advisor
  artifact and local validation evidence, but do not call the review gate
  passed unless the user explicitly lowers the bar for this turn.
- When the task only needs advisory pressure and the user did not require a
  spawned-reviewer gate, you may run the selected lens reviews serially
  yourself. Record the review execution mode as `serial lens fallback`, do not
  claim that agents were spawned, and treat independence confidence as lower.
  Keep the lenses separate and label them so the author pass does not silently
  grade itself.

### 5. Merge findings into a rework list

After the lens reviews return:

- normalize verdicts into `accept`, `conditional accept`, `reject`, or
  `needs more evidence`
- separate blocking gaps from non-blocking suggestions
- identify reviewer disagreements and decide which scenario, invariant, or
  validation gap owns the tie
- revise the artifact only for gaps that improve correctness or evidence
- avoid overfitting to one reviewer phrasing when a more general skill,
  workflow, or product rule is needed

In `review-only` mode, stop here with the merged findings and smallest rework
list. Do not revise the artifact or run another round unless the user explicitly
switches from review to rework.

If any selected reviewer rejects the artifact or names a blocking gap, do not
hand off as final. Rework first.

### 6. Run a targeted next review round

For high-stakes tasks, skill creation, workflow changes, or when the user asks
for two iterations, run a second reviewer round after the first revision.

The next-round prompt should include:

- the revised artifact
- round-one findings
- a short change log explaining what was changed
- explicit request to judge whether blockers were actually resolved
- unchanged blockers that should not trigger a broad new review fanout

If round two still produces a rejection or unresolved blocker, do another
targeted rework and repeat the review loop until either:

- both reviewers accept or conditionally accept with no blocking gaps
- the remaining gap requires new user judgment or external evidence
- continued iteration is no longer producing meaningful improvement

Before starting another broad reviewer round, compare target artifact basis,
acceptance bundle, prior blockers, and changed evidence. If the same blocker is
unchanged and no artifact or proof changed, reuse the prior gate state and work
the blocker first. When the delta is narrow, route only the lens that can judge
that delta.

### 7. Final handoff

The final answer should be compact but must include:

- final artifact path or summary
- review execution mode: spawned reviewers or serial lens fallback
- advisor coverage boundary: scenarios, requirements, non-goals, and key corner
  cases considered
- reviewer lens summaries and verdicts
- omitted reviewer lens and reason, if a smaller lens set was used
- what changed between rounds
- validation performed and what remains unverified
- residual risks or decisions that still need human judgment

If code, docs, or skills changed, follow repository validation, commit, and
push rules. Keep unrelated dirty worktree changes out of the commit. For skill
changes, at minimum validate JSON eval files and report whether any eval harness
or benchmark viewer was run; if not run, say why.

## Review Acceptance Bar

Treat the result as not ready when any of these are true:

- the artifact starts from implementation shape rather than user job and
  scenario pressure
- requirement classes do not trace back to scenarios or failure modes
- reviewer prompts lack the evidence packet, causing shallow opinion review
- reviewers are asked to rubber-stamp instead of reject when needed
- multiple reviewers run the same checklist instead of distinct functional,
  adversarial, and heuristic pressure
- the next round does not explicitly verify that first-round blockers were fixed
- a broad new review round is spawned with the same artifact, unchanged
  blockers, and no changed evidence
- user-visible workflow changes lack E2E or rendered evidence where the repo
  requires it
- the final handoff does not disclose whether review used spawned subagents or
  a serial fallback
- a serial fallback is presented as satisfying an explicit spawned-reviewer
  acceptance gate
- the handoff hides skipped checks or presents unverified behavior as proven

## Common Corner Cases

- Reviewer disagreement: prefer the finding tied to a concrete user scenario,
  repo invariant, or validation gap. If both are plausible, keep the issue open
  as a human decision instead of pretending consensus exists.
- Missing evidence: switch the verdict to `needs more evidence`; collect the
  missing artifact before another review when possible.
- User asked for proposal only: stop at a proposal artifact and review it. Do
  not begin implementation without confirmation.
- User asked for review only: stop at verdicts and smallest changes needed. Do
  not rework the artifact until the user asks you to switch into rework.
- User asks for adversarial or heuristic review: treat that as a request for
  explicit reviewer lenses, not a generic second opinion.
- User provides a fresh worktree or says to experiment and solve it after an
  advisor answer: switch to evidence-producing implementation. Do not keep
  debating the same architecture point unless the new experiment finds a
  product decision blocker.
- User asked for implementation: write the plan only when repo rules require
  it, implement after the advisor pass, then review the actual diff and
  validation evidence.
- Narrow UI fix with this skill explicitly invoked: use the lightweight route,
  then follow `rudder-ui-polish-maintainer` for implementation, visual proof,
  tests, commit, and handoff.
- Skill creation: create the skill in the correct global or project-local
  location, add realistic eval prompts when useful, and review trigger
  description, workflow, references, and evalability.
- Visible UI: include screenshot or browser evidence before claiming the loop
  passed.
- Release or Desktop work: validate live release surfaces or packaged behavior;
  local build success is not enough.

## Output Template

Use this structure when reporting the loop:

```markdown
结论：...

产物：
- ...

Advisor 覆盖：
- 场景/角色：...
- 需求类：...
- 非目标：...
- 关键 corner cases：...

Review 轮次：
- Round 1: functional ..., adversarial ..., heuristic ...
- Round 2: targeted lenses ..., omitted lens ...
- Execution mode: spawned reviewers / serial lens fallback

返工摘要：
- ...

验证：
- Passed: ...
- Not run / not proven: ...

剩余风险：
- ...
```

Keep the final response shorter when the work is small, but do not omit failed
checks or unresolved blockers.
