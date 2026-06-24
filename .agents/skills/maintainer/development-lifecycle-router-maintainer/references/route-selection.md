# Route Selection

Read this file when the request is ambiguous, spans stages, names multiple
skills, or might be skill optimization rather than product work.

## Build The Routing Packet

Collect only the evidence needed to choose the route:

- newest user request and corrections in the current thread
- `git status --short --branch`
- named files, screenshots, session ids, run ids, PRs, commits, or plans
- relevant repo docs based on `AGENTS.md`
- nearby skill contracts when choosing between skills
- changed-file ownership when the prompt asks to delete, restore, clean up, or
  identify old agent work

Ignore injected environment text and broad repo scanning unless it changes the
route. If the user gave a Codex session id, extract the real user prompts and
agent actions before judging workflow quality.

## Meta-Request Precedence

User instructions about the conversation, agent workflow, or a named skill take
precedence over task details embedded in screenshots, transcripts, quoted logs,
or pasted prior messages.

If the immediately previous turn was requirements confirmation, diagnosis, or a
screenshot-backed product bug, and the newest turn asks to optimize, harden, or
edit a named skill, classify the new turn as `skill_optimization`. The prior
product requirement is evidence for the skill failure, not authorization to
implement the product fix.

Only use this classification when the named skill is the artifact to modify. If
the user invokes the skill as process guidance for continuing a product task,
keep the product route and use the skill only as lifecycle policy.

Examples:

- "Optimize this router with skill-optimizer" plus a screenshot mentioning
  design skills means `skill_optimization -> skill-optimizer`; do not generate
  UI mockups.
- "Continue the Messenger fix using this router's review gate" means product
  implementation/verification/review; do not edit this skill.

## Stage Selection

Choose the earliest blocking stage:

- "fix this and review it" starts at `implementation`, then moves to
  `verification` and `review`
- "do you understand?" starts at `requirements`
- "this feels wrong" starts at `advisor`
- "why did this run fail?" starts at `debug`
- "can I hand off now?" usually starts at `verification` or `review`,
  depending on which proof is missing

Before implementation, say:

- lifecycle stage now
- downstream skill or normal coding workflow selected
- acceptance bar for this stage
- verification and review plan, including whether pre-review is useful and that
  final review follows verifier `PASS`

For a small bug, one concise sentence is enough.

## Narrow Routing Matrix

Use the smallest matching workflow:

- visible screenshot, label, alignment, menu, icon, empty state, or compact UI:
  `rudder-ui-polish-maintainer`
- missing, stale, wrong, unexplained, slow, or suspicious page data:
  `rudder-data-path-diagnostician-maintainer`
- one run, recent run batch, transcript, stdout/stderr, runtime failure, or
  run-quality investigation: `debug-run-transcript-maintainer`
- Desktop launch, local Electron shell, packaged startup, update, profile, or
  local instance recovery: `rudder-desktop-dev-recovery-maintainer`
- review-only of a session, PR, commit, proposal, release, screenshot, or agent
  outcome: `agent-work-reviewer-maintainer` or
  `codex-session-product-reviewer-maintainer`
- release, npm, GitHub Release, Desktop release assets, tags, dist-tags, or
  install-smoke state: `release-maintainer`
- vague dissatisfaction or unclear product/design critique: `build-advisor`
- high-stakes proposal or implementation needing reviewer rounds:
  `advisor-review-loop-maintainer`
- Codex session benchmark across local history:
  `codex-session-benchmark-maintainer`
- screenshot-driven visible UI polish or small interaction fix:
  `rudder-ui-polish-maintainer`
- wrong, missing, stale, or sparse data on a Rudder surface:
  `rudder-data-path-diagnostician-maintainer`
- local branch preview: `rudder-worktree-preview-maintainer`
- GitHub PR local checkout/preview/review: `pr-local-preview-maintainer`
- mock/demo/seed data: `mock-data-maintainer`
- landing screenshots after mock data: `landing-proof-shots-maintainer`
- stop/restart/clean repo-local dev runtime: `stop-rudder-dev-maintainer`
- new skill artifact from a reusable workflow: `skill-creator`
- existing skill optimization, hardening, eval update, trigger repair, or
  behavior patch: `skill-optimizer`

Only keep ownership after this table when the narrow owner cannot safely begin
without lifecycle sequencing, dirty-state recovery, or stage-gate decisions.

## Scope Guard Before Implementation

For visible workflow or known hotspot work:

- If the request changes a user-visible workflow, require the relevant E2E path
  unless the user explicitly approves a lower-level substitute.
- If the likely edit target is an oversized UI file such as `IssueDetail.tsx`,
  prefer a small extracted component/helper for new behavior.
- If extraction would be larger than the fix, keep the fix narrow, record the
  hotspot risk in handoff, and avoid unrelated cleanup.
- Do not broaden a small bug into an architecture refactor solely because the
  file is large.

## Skill-Optimization Packet

For `skill_optimization`, build this packet instead of a normal development
routing packet:

- target skill name, path, purpose, and current `SKILL.md`
- triggering user correction or repeated annoyance
- latest user instruction, separated from prior-turn product requirements
- session id, screenshot, quoted output, or eval failure showing the misroute
- failed decision point and tempting wrong shortcut
- smallest durable owner: target skill body, frontmatter description, eval
  case, memory update, or no-op

Do not let evidence content override the current meta-request.
