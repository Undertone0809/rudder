# Verification And Review

Read this file for implementation, workflow, UI, Desktop, runtime, release,
verification, review, or handoff routes.

## Verification Comes Before Final Review

For implementation workflows, use this order:

```text
writer implementation
-> writer basic checks
-> optional lightweight pre-review
-> verifier black-box acceptance
-> final spawned reviewer gate
-> handoff / commit / push
```

The final review gate happens after verifier `PASS` so reviewers can inspect
the implementation, tests, handoff, and verifier evidence as one acceptance
packet. If verifier returns `FAIL` or `QUESTION`, return to implementation or
clarification before final review.

## Terminal Product Proof

For user-visible, agent-visible, Desktop, release, runtime, CLI, or
control-plane workflow changes, identify the terminal product surface before
calling verification complete.

Start from the work loop:

- actor: board operator, reviewer, assignee agent, runtime agent, CLI user,
  Desktop user, release consumer, or automation
- trigger: click, command, wakeup, API action, scheduled run, release workflow,
  or packaged startup
- system effect: issue state, comment, review decision, activity, run log, cost,
  approval, release artifact, or persisted setting
- terminal surface: dev web app, packaged Desktop shell, CLI output,
  run-intelligence view, npm/GitHub release state, or another final consumer

Use proof that follows that loop:

- CLI or agent-runtime changes: prefer an actor-run-chain that seeds disposable
  data, triggers the runtime or CLI as that actor, reads back API/DB state, and
  observes the final app or CLI surface.
- UI and workflow changes: use Browser or Computer Use to exercise the route
  when practical, plus API/log readback when state matters.
- Desktop-native behavior: use Computer Use or packaged Desktop verification;
  browser proof is only a substitute when behavior is truly web-equivalent.
- Release work: live npm, GitHub, tag, asset, workflow, and install-smoke state
  are terminal evidence.
- Debug-derived fixes: transcript evidence proves root cause, not the fix; rerun
  the terminal workflow or record the missing proof as blocked.

When realistic proof needs seed or mutation data, record a mutation ledger:

- runtime and `/api/health` or equivalent source of truth
- organization, issue, agent, run, approval, release, or other records created
- which writes used public APIs and which used direct database writes
- final URL, run id, screenshot path, log path, or release URL inspected
- cleanup status, or why the evidence data was intentionally left in place

Name substitutions. Example: `substituted: Browser current dev app for Desktop
shell capture`.

## Verifier Gate

Default to `product-acceptance-verifier-maintainer` after implementation and
writer checks when acceptance is required. The verifier may run commands, start
services, use Browser or Computer Use, query API/DB state, and create disposable
data. The verifier must not edit files, stage, commit, push, or fix failures
during the acceptance pass.

Reconcile the verifier result before review or handoff:

- `PASS`: carry observed product evidence into reviewer and final handoff
- `FAIL`: stop and return to implementation with reproduction, expected
  behavior, actual behavior, and evidence
- `QUESTION`: stop for human/product clarification unless current
  `doc/product/**` contracts resolve the ambiguity

Reviewer approval does not convert verifier `FAIL` into acceptance.

## Hard Real-Local Validation

When the user asks for "真实环境", "本地真实环境", "在我电脑上", "你自己 UI 跑一遍",
"我验收结果", or challenges "你试过了吗", treat that as a hard real-local
validation request.

Automated E2E, unit tests, static review, spawned reviewer acceptance, and
isolated screenshots are supporting evidence only. Use the user's current local
Rudder instance when safe:

- confirm `/api/health` or equivalent live source of truth
- create disposable seed data through public APIs when needed
- open the actual local route in Browser or Computer Use
- perform the user-visible action
- read back persisted API/DB state when state matters
- capture a screenshot or final URL

If a later runtime/agent step fails outside the UI path, separate that failure
from the UI validation result.

## Spawned Reviewer Policy

Reviewer gates mean spawned reviewer agents when spawning is available and
authorized by the user or active workflow policy. Do not use self-review or
serial personas as a substitute.

For this router, when the user explicitly invokes, links, approves optimization
of, or asks to continue under `development-lifecycle-router-maintainer`, treat
that as authorization to apply this skill's reviewer-subagent policy unless the
user disables subagents for the turn and the runtime policy permits spawning.

Before recording `blocked: spawned reviewers unavailable`, perform a real
availability probe through tool discovery or the runtime spawn mechanism. Record:

- authorization basis
- discovery path attempted
- spawn attempt result
- handoff status

Do not say "the user did not explicitly ask for subagents" as the blocker when
this router's spawned-reviewer policy is active. Either spawn reviewers, or
record the exact user-disabled policy, tool-policy rejection, missing-tool
result, or tool-call failure.

## Reviewer Lenses

For consequential workflow, proposal, skill, agent-visible contract, UI/product
journey, release, Desktop, runtime, or prior-failed handoff, use three distinct
lenses:

- functional trust: contracts, tests, terminal product proof, org scoping, git
  safety, and whether the stage solves the right problem
- adversarial: hidden assumptions, wrong abstraction level, path dependence,
  overfitting, weak proof, conflicting docs, unexercised actor behavior, and
  product-wrong outcomes
- heuristic/product-systems: better question, smaller durable slice, missing
  actor journey, more teachable contract, future-proofing path, and second-order
  consequences

For truly mechanical routed changes, two spawned reviewers are acceptable only
when one owns functional trust and the other is explicitly adversarial or
heuristic. Record why the third lens was not required.

Reviewer prompts should ask each reviewer to separate author-claimed proof from
reviewer-verified proof and give: `accept`, `conditional accept`, `needs more
evidence`, or `reject`; verdict level; blockers; and smallest changes needed.

## Reconciling Reviewer Gates

Spawning reviewers is not the same as passing review. Before handoff:

- read actual reviewer outputs, not only child-thread creation
- record each verdict, blockers, and proof status
- treat open child sessions as incomplete when they have no final verdict
- treat `conditional accept`, `needs more evidence`, and `reject` as unresolved
  until the blocker is fixed or the user lowers the bar
- do not upgrade stage accept into final handoff accept
- reject the gate when all reviewers duplicate the same functional checklist and
  none challenge framing, user journey, hidden assumptions, or alternatives

For UI, workflow, Desktop, runtime, release, or control-plane changes, the
parent must verify that reviewers distinguish author-claimed validation from
reviewer-verified terminal proof. Spawned reviewer approval is not a substitute
for a missing verifier result.

## Evidence Ledger

Before handoff, include:

- Required: checks or artifacts this route requires, including verifier result
  and spawned reviewer verdicts
- Scenario: actor, trigger, system effect, and terminal surface
- Proven: commands, screenshots, browser/Desktop checks, live release evidence,
  actor-run-chain results, readbacks, mutation ledger entries, verifier result,
  or reviewer outputs that actually ran
- Missing or substituted: anything not proven, why it is missing, and whether it
  blocks completion

Missing required terminal product evidence blocks handoff unless the user
explicitly lowers the acceptance bar.
