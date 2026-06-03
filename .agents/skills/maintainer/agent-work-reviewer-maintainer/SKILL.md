---
name: agent-work-reviewer-maintainer
description: Review Rudder agent work. Use for review/第一性原理/PM review of Codex sessions, PRs, commits, UI, releases, regressions, or agent outcomes. Separates author-claimed proof from reviewer-verified proof. For functional or UI reviews, run the real Rudder scenario with Browser or Computer Use when available instead of accepting from diffs.
---

# Agent Work Reviewer Maintainer

Review completed or in-progress Rudder agent work. This is a reviewer workflow,
not an implementation workflow.

The core question is:

> Did the agent solve the right product problem, with the right object model,
> complete behavior, credible validation, and a clean handoff?

Default to Chinese when the user asks in Chinese. Keep the verdict early and
ground every judgment in evidence.

## Use When

Use this skill when the user asks to review:

- a Codex session, Rudder agent run, task, or transcript
- a local branch, commit, diff, pull request, or implementation
- a product proposal, plan doc, feature spec, or UI direction
- a release verification, Desktop install path, npm publish, or canary/stable
  handoff
- a screenshot, browser state, visual interaction, or workflow that "feels
  wrong"

Common trigger phrases:

- "review 一下 codex session id ..."
- "as a 专业产品经理 review"
- "第一性原理思考一下"
- "作为 reviewer"
- "这个实现是不是产品上对"
- "这个 PR 本地跑起来看一下有没有问题"
- "这次 release 验证做完了吗"
- "我觉得这个功能之前有，现在没了"

## Do Not Use When

Do not use this skill for:

- fixing the findings during the same reviewer pass, unless the user explicitly
  asks to implement fixes
- generic line-by-line code review where product judgment is irrelevant
- debugging a failed Rudder agent run root cause only; use the run transcript
  debugging workflow first, then return here for product/workflow judgment
- summarizing logs without verdict or acceptance criteria

If the user asks to fix findings after the review, switch to normal
implementation mode and follow repository validation, commit, and push rules.

### Read-Only Guard

Reviewer mode is read-only by default. Do not edit files, stage changes,
restore files, commit, push, start destructive cleanup, or "just fix" findings
while reviewing unless the user explicitly changes the task from review to
implementation.

If the user says "do not implement", "review only", or assigns a reviewer role,
that instruction is binding for the whole reviewer pass. Use tools only to
inspect evidence.

Direct UI inspection with Browser, Desktop, or Computer Use is still reviewer
work when it only observes or exercises low-risk local/dev flows. If a realistic
scenario requires mutating Rudder data, prefer an isolated dev org, disposable
test records, or an existing preview instance, and report what was created or
changed. Do not delete data, publish, submit external communication, install
software, change system settings, or perform other risky UI actions without the
appropriate user confirmation.

## Evidence Packet

Never start with opinion. Build the smallest evidence packet that can support a
real judgment.

### 1. Identify The Target

Resolve what is being reviewed:

- Codex session id or prefix
- Rudder run id or transcript
- PR number or URL
- branch name, commit hash, staged/unstaged diff
- plan doc, proposal, screenshot, or browser URL
- release version, tag, workflow run, npm dist-tag, or Desktop asset set

If the user is vague, infer from current branch, recent commits, open browser
state, or named files before asking.

### 2. Collect Task Intent

For Codex sessions, search:

```bash
rg "<session-id-or-prefix>" ~/.codex/session_index.jsonl ~/.codex/sessions ~/.codex/archived_sessions
```

Extract real user requests and corrections. Ignore injected `AGENTS.md`,
environment context, skill bodies, and system/developer text.

For branches, PRs, commits, or diffs, inspect:

```bash
git status --short --branch
git log --oneline --decorate -12
git diff --stat
git diff
git show --stat <commit>
git show <commit>
```

For commit or session reviews, also compare the changed-file set against the
stated task. Classify every surprising file as one of:

- required for the requested behavior
- test, docs, or contract evidence for the requested behavior
- pre-existing unrelated dirty work
- unrelated change mixed into the reviewed commit or handoff

Unrelated changes mixed into a product fix are review findings, not cleanup
details. If they change skills, release state, generated files, dependencies,
or broad runtime behavior outside the task, usually treat that as at least a
`conditional accept` blocker until the scope is split or justified.

For PRs, read the PR description, changed files, review comments, and CI status
when available.

### 3. Read Product Context

For most Rudder product work, read only the relevant sections of:

- `doc/GOAL.md`
- `doc/PRODUCT.md`
- `doc/SPEC-implementation.md`
- `doc/DESIGN.md` for visible UI and interaction work
- the task's plan doc under `doc/plans/` when one exists

For release/Desktop/package work, also use:

- `doc/RELEASING.md`
- `doc/PUBLISHING.md`
- `doc/DESKTOP.md`
- `.github/workflows/release.yml`
- `.github/workflows/desktop-release.yml`

For database/API behavior, check the cross-layer contract:

- `packages/db`
- `packages/shared`
- `server`
- `ui`

### 4. Verify What Was Proven

Separate "implemented" from "proven".

Also separate `author-claimed proof` from `reviewer-verified proof`.

`author-claimed proof` includes validation listed in the prompt, final handoff
text, copied terminal output, screenshots the reviewer did not inspect, and
test names the implementer says were run.

`reviewer-verified proof` includes commands, logs, screenshots, browser/Desktop
state, API readbacks, git evidence, CI state, or release surfaces that this
reviewer actually inspected during the review pass.

Do not convert author-claimed proof into reviewer-verified proof. It can support
the review, but it cannot close a final handoff gap for UI, workflow, release,
Desktop, runtime, or control-plane behavior when the reviewer could cheaply
verify the real surface.

Record which evidence exists:

- typecheck, unit tests, build
- E2E tests or release smoke tests
- browser or Desktop visual verification
- screenshots for visible UI
- packaged Desktop verification for startup, migrations, profile routing, or
  installer changes
- npm/GitHub Release/live workflow checks for release tasks
- commits, pushes, branch state, PR URL, and merge state

Treat timed-out, skipped, or attempted checks as unverified. Do not convert
"looked plausible in code" into product proof.

For spawned child reviewers, full-history forks may include the parent agent's
prior commands, screenshots, tests, or edits. Treat inherited history and prompt
claims as author-claimed proof unless the child reviewer performs or explicitly
re-inspects the evidence after the review assignment starts.

When reviewing in-progress work, spawned reviewer child sessions, or a branch
with unrelated dirty feature groups, use a mixed-state verdict instead of a
binary pass/fail. Examples:

- `accept`: no blocking product, behavior, validation, or handoff gaps remain
  for the requested scope and verdict level.
- `conditional accept`: the artifact direction is sound, but merge/handoff is
  blocked by missing proof, unrelated dirty work, or explicit reviewer follow-up.
- `needs more evidence`: the required scenario, diff, source data, or validation
  is not available enough to judge.
- `reject`: the artifact solves the wrong problem or introduces a blocking
  regression.

Every verdict must declare its level:

- `stage verdict`: judges whether the current requirements, proposal, design,
  implementation slice, or review artifact is good enough to proceed to the
  next stage.
- `final handoff verdict`: judges whether the requested work can be accepted as
  done, merged, released, or handed to the user with no blocking evidence gap.

Do not let a `stage accept` read like a final handoff. If terminal product
proof, commit/push state, public release evidence, or reviewer follow-up is
still missing, the final verdict cannot be `accept` even when the stage verdict
is positive.

For child-reviewer outputs, preserve the parent task boundary. Do not turn the
review into implementation and do not judge sibling or unrelated dirty work as
part of the artifact unless it affects merge/handoff safety.

### 4.1 Evidence Freshness Guard

Before writing the verdict, state the evidence baseline being reviewed. This
prevents repeated reviewer child sessions from re-judging stale or mismatched
artifacts.

Include the relevant subset:

- target id: session, run, PR, commit, branch, diff, proposal, release, or
  screenshot
- git basis: current branch and commit SHA, plus whether the worktree is dirty
- diff basis: changed files or `git diff --stat` scope inspected
- artifact basis: plan/proposal/screenshot/log path and timestamp when relevant
- validation basis: checks, browser/Desktop evidence, CI, release workflow, or
  product proof actually inspected
- proof split: which evidence was author-claimed versus reviewer-verified
- review round: first pass, delta review, second round, or final review

If a prior reviewer already judged the same target, same git SHA, and same
artifact basis, run a delta review against the changed evidence instead of
repeating the full review. If there is no changed evidence, say that the prior
verdict still applies and name the missing proof instead of producing a fresh
confident verdict.

For spawned reviewer or sub-review work, explicitly say which artifact is being
reviewed. Do not silently upgrade the scope from "this proposal" or "this diff"
to the whole dirty worktree.

### 4.2 Run The Real Scenario When It Matters

For functional review, UI review, Desktop review, agent-visible workflow review,
or workflow-regression review, prefer direct scenario verification over
code-only inference:

- Use Browser for local web targets such as `localhost`, `127.0.0.1`, or file
  previews when the browser can exercise the path.
- Use Computer Use for the packaged Rudder Desktop app, native dialogs, update
  prompts, menus, resident shell behavior, drag/drop, or any flow that is only
  visible in the local Mac UI.
- Use API/log/database checks as supporting evidence, not a replacement for the
  real operator path when the user's question is about behavior.
- For CLI or runtime-agent changes, ask whether the actor that will use the
  feature actually exercised it. A realistic proof usually includes a disposable
  org/issue/agent or equivalent fixture, the actor command or wakeup, persisted
  issue/run/comment readback, and the terminal app or CLI surface.
- If the app is not running, start the appropriate local or packaged Rudder path
  when that is safe and within the review scope. If startup would be expensive
  or risky, say exactly why the review is limited.
- When a real scenario is skipped, the verdict should usually be
  `needs more evidence` or `conditional accept`, and the missing scenario must
  be named.

For user-visible work, do not accept "tests pass" as enough proof when Computer
Use or Browser could cheaply verify the actual Rudder interaction. The minimum
credible evidence is the observed workflow state plus any relevant logs, API
responses, screenshots, or failure messages.

If the reviewer does not personally inspect the rendered or interactive state
for a layout-sensitive UI or functional workflow, the final handoff verdict
cannot be `accept`. Use `conditional accept` for a sound implementation slice,
or `needs more evidence` when the missing scenario is required to judge the
change.

For agent-visible or control-plane work, do not accept direct database
assertions, unit tests, or docs updates as the whole proof when a realistic
actor-run-chain could cheaply exercise the behavior. Missing terminal product
proof should usually make the verdict `conditional accept` or
`needs more evidence`, even if the diff itself looks correct.

If the user explicitly says the reviewer can use Computer Use or Browser to
test a real scenario, treat that as part of the review assignment. If direct
scenario verification is skipped or blocked, the verdict should normally be
`conditional accept` or `needs more evidence`, and the missing interaction must
be named.

### 5. Assemble The Review Packet

Before writing the verdict, make the review packet explicit. It should include
the relevant subset:

- target: session, run, PR, branch, commit, diff, proposal, screenshot, release,
  or browser state
- evidence baseline: git SHA/branch, dirty state, diff scope, artifact timestamp,
  and review round when available
- user intent: original request plus important corrections or constraints
- changed object: the product/workflow/code object being reviewed
- evidence inspected: files, diffs, logs, screenshots, docs, plans, tests, CI,
  browser/Desktop state, release artifacts, or sub-reviewer notes
- proof split: author-claimed proof versus reviewer-verified proof
- validation status: what passed, what failed, what timed out, what was skipped,
  and what was only inferred
- product proof status: actor, trigger, system effect, terminal surface, and any
  seed/mutation records created for the review
- unresolved evidence gaps: missing screenshots, missing E2E, unchecked
  downstream consumers, branch/CI uncertainty, or unverified public surfaces

If any packet item needed for a trustworthy judgment is missing, use
`needs more evidence` or `conditional accept`; do not fill the gap with
confidence.

## First-Principles Review Frame

Use this frame before writing the verdict.

### 1. User Job

What real operator or contributor problem was this task supposed to solve? Was
the request a symptom of a deeper workflow issue?

Examples:

- "Move recent views" may really mean navigation history was modeled as content.
- "Where did my draft issue go" is a lifecycle and recovery problem, not just a
  sidebar rendering bug.
- "Calendar blocks are unreadable" is a time-density visualization problem, not
  a card styling problem.

### 2. Product Object Model

Identify the object being changed:

- view or navigation shortcut
- workflow state
- draft, issue, goal, project, run, or artifact
- external source
- preference or setting
- release/version/install surface
- agent memory, instruction, skill, or operating contract

Judge whether the implementation modeled it as the right kind of object. Many
Rudder regressions come from treating a workflow state as a static view, a
setting as content, or an external source as an imported local object too early.

### 3. Core Loop Impact

Ask how the work affects Rudder's north-star loop: real agent work completed
end to end.

Good changes reduce operator friction, clarify agent state, preserve control,
or make review and handoff easier. Weak changes add surface area without making
the agent-work loop more controllable.

### 4. Scope Discipline

Check whether the work:

- preserved organization scoping and permissions
- reused existing product concepts instead of inventing new ones
- removed half-built surface area when deletion was the right product move
- preserved legacy `paperclip*` compatibility where required
- avoided hiding complexity behind vague copy or fake affordances
- respected the user's explicit corrections during the session

### 5. Behavioral Completeness

For user-visible work, inspect the important states:

- empty, normal, long, loading, error
- direct link, sidebar link, board card, detail page, and modal entry points
- cross-organization behavior
- mobile or constrained width when relevant
- legacy links and previously shipped features

For UI and functional reviews, ask whether the actual rendered or interactive
state was seen. Code review alone is not enough for layout-sensitive work,
native Desktop behavior, update flows, chat/issue workflows, or any path where
the product claim depends on clicks, typing, selection, focus, async state, or
cross-page navigation.

### 6. Trust And Validation

The user is often asking "can I trust this agent work?" Answer that directly.

Look for:

- validation mismatch: tests pass but do not cover the operator path
- regression risk: a refactor deleted a previous capability
- release mismatch: npm, GitHub Release, Desktop assets, tags, and public entry
  points disagree
- branch mismatch: work landed somewhere but not on `main`
- handoff mismatch: URL exists but screenshot or real flow evidence is missing
- hygiene mismatch: the implementation artifact is plausible, but unrelated
  dirty files, child-session duplication, or pending validation means it cannot
  be safely merged or handed off as complete

## Multi-Round Review

When reviewing a proposal, plan, or agent output across multiple rounds, keep a
blocker ledger instead of relying on memory or tone.

Use this shape when it is useful:

```markdown
Blocker ledger:
| blocker | severity | round-one evidence | revised answer | status |
| --- | --- | --- | --- | --- |
| ... | P1 | ... | ... | resolved / unresolved |
```

Second-round review must judge each prior blocker explicitly. An `accept`
verdict means no unresolved blockers remain for the requested scope; it does not
mean the proposal is fully implemented or validated.

For reviewer-loop orchestration, disclose whether the review used real spawned
reviewers or a serial two-role fallback when that distinction affects trust.

## Lens-Specific Checks

### UI/UX And Design

- Read `doc/DESIGN.md` before judging.
- Verify rendered states with Browser, screenshot, Desktop shell evidence, or
  Computer Use against the real packaged app when native behavior matters.
- For alignment, row rhythm, avatar/text/time centering, truncation, or
  column-layout reviews, require production-shaped fixture data and measurable
  proof when practical. Strong evidence includes real agent avatars, long labels
  or message text, timestamps/action controls, a screenshot, and DOM bounding
  boxes or centerline deltas for the elements being aligned.
- Treat visual hierarchy, density, interaction feedback, animation, native app
  affordances, and copy clarity as product quality, not nitpicks.
- Check whether menus, hover actions, dialogs, keyboard behavior, and icons match
  expected Rudder patterns.
- If no visual evidence exists, the verdict should usually be `needs more
  evidence` or `conditional accept`.
- If the claimed fix is "aligned" but the proof only uses placeholder data,
  isolated component tests, or screenshots that hide the relevant avatar,
  timestamp, action, or long-text state, the verdict should usually be
  `conditional accept` until the real row shape is verified.

### Functional Workflow Review

- Reconstruct the user's real scenario as a short workflow, then run it when
  the local app, preview, or packaged Desktop is available.
- Prefer scenario steps such as "open Messenger, send a message, approve the
  proposal, confirm the issue state" over isolated API calls when the behavior
  is operator-facing.
- Use API, logs, DB rows, and code paths to explain why the observed behavior
  happened after the UI behavior is known.
- If the scenario would mutate shared or production-like data, use a disposable
  dev record or ask before the risky step. State any mutation in the review
  packet.
- A functional verdict should separate observed user behavior from inferred
  internal correctness.

### Release And Desktop

- Confirm the relevant version, git tag, npm dist-tag, GitHub Release assets,
  Desktop portable assets, and install command.
- For Desktop startup, migrations, profile routing, installer assets, or
  prod-local paths, packaged verification is required before calling it done.
- A dry-run does not prove public install. Say exactly which platform and
  command were actually verified.

### Git, PR, Branch, And Worktree

- Confirm where the change landed and whether it was pushed.
- If the user expected `main`, verify `main` contains the commit.
- Distinguish the user's unrelated dirty work from the reviewed changes.
- Check commit hygiene: the changed files should match the requested product
  object, tests/docs for that object, and necessary contracts. Flag mixed
  unrelated edits, accidental skill renames, version bumps, generated artifacts,
  or broad dependency churn inside narrow fixes.
- When reviewing a Codex session, do not rely only on the final summary saying
  "committed and pushed"; verify the commit or diff when the local repo is
  available.
- For PR preview work, check whether the app was started in an isolated worktree
  and whether the user received a URL plus screenshots when UI changed.

### Agent Skill Or Operating Contract Work

- Check trigger description, expected workflow, bundled references/scripts, and
  eval prompts.
- Verify that repo-local development and maintenance skills use the
  `*-maintainer` suffix and live under `.agents/skills/maintainer/`.
- Check whether the skill preserves the user's actual repeated corrections
  rather than only encoding generic best practices.
- Prefer eval prompts drawn from real Rudder tasks.

## Output Shape

Keep the review compact. Lead with the verdict.

```markdown
结论：conditional accept。

评分：7/10。

证据基础：
- Session/commit/PR: ...
- Inspect: ...
- Validation: ...
- Gaps: ...

这次任务本质上是在解决：...

做对的地方：
- ...

关键缺口：
1. ...
2. ...

必须补的证据：
- ...

Blocker ledger:
- ...

下一步建议：...
```

Use `accept`, `conditional accept`, `reject`, or `needs more evidence`.

Only add line-anchored review findings when they are useful. In Codex app
contexts, use `::code-comment{...}` for concrete file/line findings and keep the
line range tight.

## Judgment Rules

- A task can be directionally correct and still not be done.
- A stage can pass while final handoff is still blocked.
- Passing typecheck/build does not prove product behavior.
- A visible UI task is not done without rendered-state evidence.
- A release task is not done until npm, tags, GitHub Release, Desktop assets,
  and public install entry points agree for the intended release surface.
- Multi-message sessions are not automatic failures; they may be intentional
  product iteration. Treat repeated corrections as evidence of where the review
  bar should be raised.
- "Implemented" means code or docs changed. "Accepted" means the right behavior
  was proven for the relevant user path.
- Prefer one pragmatic next move over a long wishlist.

## Validation Cases

### Case: Two-Round Proposal Review

Input:
"Review this proposal as Reviewer A. Do not implement." Then later: "Round 2
review. Judge whether this revised proposal resolves your round-one blockers."

Expected behavior:
Round one produces a verdict plus blocker ledger. Round two explicitly checks
each blocker against the revised proposal and marks it resolved or unresolved
before giving the final verdict.

Must not:
Edit files, skip the blocker ledger, or say `accept` without showing why prior
blockers were closed.

### Case: Functional Review Of A Shipped Workflow

Input:
"功能性上 review 一下 reviewer routing，现在是不是产品上对？"

Expected behavior:
The review starts from user intent and workflow semantics, then traces every
downstream consumer of the relevant object or field, such as attention, filters,
wakeups, UI state, and recovery paths. When Rudder is available locally, it also
uses Browser or Computer Use to exercise the real operator path or clearly names
why live scenario testing was skipped. The verdict separates observed semantic
behavior from schema/type correctness.

Must not:
Stop after checking schema, route validation, or the obvious happy-path test.

### Case: Functional Review With Computer Use

Input:
"review 一下最新版 Desktop update 为什么失败，功能上是不是已经好了."

Expected behavior:
The review inspects release and code evidence, then uses Computer Use or an
equivalent packaged Desktop run to exercise the actual update interaction when
safe. It reports the observed app version, update channel, prompt/toast state,
and any supporting health/API/log evidence before judging whether the function
is proven.

Must not:
Call the update flow accepted from release assets or code inspection alone when
the packaged Desktop scenario can be tested.

### Case: UI Review Without Rendered Evidence

Input:
"review 一下这个 UI 改动有没有问题." The diff is available, but no screenshot,
browser state, or Desktop state was captured.

Expected behavior:
The review can comment on code and likely risks, but the verdict is
`conditional accept` or `needs more evidence` if layout, dark/light behavior,
overflow, hover, dialog, or responsive state matters.

Must not:
Call a layout-sensitive UI change fully accepted from code review alone.

### Case: Alignment Review With Placeholder Proof

Input:
"这里行对齐没有做好. Review the fix." The submitted proof includes a component
test with placeholder icons but no real agent avatar, no timestamp, and no
browser geometry or screenshot of the production row.

Expected behavior:
The review treats the fix as directionally plausible but not fully proven. It
asks for production-shaped fixture proof, ideally a browser screenshot plus DOM
bounding boxes or centerline deltas for avatar, text, timestamp, and row
container.

Must not:
Accept the alignment fix as final from placeholder component tests or a cropped
screenshot that does not show the elements whose alignment was questioned.

### Case: Explicit Review-Only Guard

Input:
"Use agent-work-reviewer-maintainer. Review this proposal. Do not implement or
edit files."

Expected behavior:
The reviewer inspects evidence and returns a verdict, findings, blocker ledger
when useful, and next evidence/fix recommendations. It performs no write action.

Must not:
Patch files, stage changes, commit, push, or run destructive cleanup.

### Case: Author-Claimed UI Proof Is Not Reviewer Proof

Input:
"Review this UI workflow. The implementer says Playwright passed and a
screenshot was captured, but you have not opened the app or inspected the
screenshot yourself."

Expected behavior:
The review may use the claimed checks as supporting context, but it labels them
as author-claimed proof. If Browser, Computer Use, screenshot inspection, or a
current local preview is available, the reviewer either verifies the real UI
state or returns `conditional accept` / `needs more evidence` for final handoff.

Must not:
Give a final `accept` by repeating the implementer's claimed Playwright,
screenshot, or dev-server evidence as if the reviewer personally verified it.

### Case: Spawned Reviewer Full-History Contamination

Input:
"You are a spawned reviewer. The inherited transcript includes the author's
tests, screenshots, and edits before your assignment. Review the current diff."

Expected behavior:
The review treats inherited commands and prompt-provided validation as
author-claimed proof unless it reruns or re-inspects them after the review task
starts. The verdict says exactly which proof was reviewer-verified and which
was inherited.

Must not:
Count pre-assignment parent commands as reviewer-verified evidence or call a UI
workflow fully accepted from inherited proof alone.
