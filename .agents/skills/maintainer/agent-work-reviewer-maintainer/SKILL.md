---
name: agent-work-reviewer-maintainer
description: Review Rudder agent work. Use for review/第一性原理/PM review of Codex sessions, PRs, commits, UI, releases, regressions, or agent outcomes.
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

For UI, ask whether the actual rendered state was seen. Code review alone is
not enough for layout-sensitive work.

### 6. Trust And Validation

The user is often asking "can I trust this agent work?" Answer that directly.

Look for:

- validation mismatch: tests pass but do not cover the operator path
- regression risk: a refactor deleted a previous capability
- release mismatch: npm, GitHub Release, Desktop assets, tags, and public entry
  points disagree
- branch mismatch: work landed somewhere but not on `main`
- handoff mismatch: URL exists but screenshot or real flow evidence is missing

## Lens-Specific Checks

### UI/UX And Design

- Read `doc/DESIGN.md` before judging.
- Verify rendered states with browser, screenshot, or Desktop shell evidence.
- Treat visual hierarchy, density, interaction feedback, animation, native app
  affordances, and copy clarity as product quality, not nitpicks.
- Check whether menus, hover actions, dialogs, keyboard behavior, and icons match
  expected Rudder patterns.
- If no visual evidence exists, the verdict should usually be `needs more
  evidence` or `conditional accept`.

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

这次任务本质上是在解决：...

做对的地方：
- ...

关键缺口：
1. ...
2. ...

必须补的证据：
- ...

下一步建议：...
```

Use `accept`, `conditional accept`, `reject`, or `needs more evidence`.

Only add line-anchored review findings when they are useful. In Codex app
contexts, use `::code-comment{...}` for concrete file/line findings and keep the
line range tight.

## Judgment Rules

- A task can be directionally correct and still not be done.
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
