# Handoff And Git

Read this file before final handoff, commit, push, or dirty-worktree cleanup.

## Git Safety

Always inspect branch and dirty state before edits and before commit.

- Stage only files from the current task.
- Preserve unrelated dirty files as user or parallel-agent work.
- Split large refactors or long goal runs into coherent phase commits when each
  phase can stand alone.
- When the user says "分批 commit" or "不要一个很大的 commit", make a phase
  checklist before the first commit and preserve a resumable checkpoint after
  each phase.
- Do not amend unless HEAD is confirmed to be your own just-created commit and
  no parallel commits appeared.
- Prefer follow-up commits over history rewrite in a shared workspace.
- Do not push when the branch is behind, non-fast-forward, or includes unrelated
  local commits the user did not ask to publish.
- If push is blocked, still make the scoped local commit when repo rules require
  it and explain the branch state.

## Acceptance Blockers

Do not hand off as complete when any of these are true:

- route was never stated and the agent silently jumped stages
- a narrow specialized skill was bypassed for a heavyweight advisor loop
- spawned reviewer evidence is missing for a routed artifact, decision, diff,
  validation bundle, or handoff when review is required
- reviewer child sessions have no final verdict, or verdicts are unresolved
  `conditional accept`, `needs more evidence`, or `reject`
- "review" only means the author reread the diff
- reviewers duplicate author-claimed validation without terminal proof
- user-visible UI lacks rendered or screenshot evidence when required
- agent-visible, CLI, runtime, Desktop, release, or control-plane workflow lacks
  terminal product proof or a named blocked/substituted proof
- feature/workflow changes skip required E2E coverage without explicit approval
- Desktop/release/package work lacks required packaged or live checks
- git history includes unrelated files or unsafe amend in a shared worktree
- final answer hides failed checks, skipped evidence, or push blockers

## Final Handoff

Include:

- route taken and stages completed
- downstream skills used or deliberately skipped
- review execution mode
- files or artifacts changed
- validation passed and not run
- commit and push status
- remaining blockers or human decisions

Use this compact shape:

```markdown
Route: ...
Stage exits:
- ...

Used:
- ...

Review:
- Mode: spawned reviewers / blocked: spawned reviewers unavailable / not a routed review gate
- Lenses: functional trust / adversarial / heuristic, or mechanical exception rationale
- Verdict: ...

Validation:
- Passed: ...
- Not run / not proven: ...

Evidence:
- Required: ...
- Scenario: ...
- Proven: ...
- Missing or substituted: ...

Git:
- Commit: ...
- Push: ...

Residual risk:
- ...
```

## Common Routes

Small UI bug with review requested:

```text
implementation -> verification -> review -> handoff
```

Use the UI or Desktop workflow needed for the bug. Review after diff, writer
checks, and verifier evidence exist. Avoid a full advisor loop unless product
requirements are unclear.

Small UI bug without explicit review request:

```text
implementation -> verification -> review -> handoff
```

Default review still applies when routed review is required. Keep it lightweight
for narrow bugs, but final review follows verifier `PASS`.

Visible workflow change in a hotspot file:

```text
implementation -> verification -> review -> handoff
```

Require E2E or an explicitly justified lower-level substitute. Prefer a small
component/helper extraction when new logic would deepen an oversized page.

Proposal-only request:

```text
requirements -> advisor -> review -> handoff
```

Do not implement. Produce the decision artifact, run reviewer gates by default,
and stop with verdicts, blockers, and next decision.

Codex session audit:

```text
review
```

Use `codex-session-product-reviewer-maintainer`, extract real user requests and
agent actions from local session logs, and give a verdict. Do not edit files
unless the user later switches to rework.

Failed run or transcript problem:

```text
debug -> review or implementation
```

Use `debug-run-transcript-maintainer` first. Only switch to implementation after
root cause and target fix are clear. After a fix, prove the affected terminal
workflow.

Agent-visible CLI or runtime workflow regression:

```text
debug or implementation -> verification -> review -> handoff
```

Prefer a real agent work loop: seed a disposable issue, trigger runtime or CLI
as that actor, read back persisted state, and inspect the terminal app or CLI
surface.

Runtime/provider contract change:

```text
runtime_contract -> implementation or debug -> verification -> review -> handoff
```

Build the provider matrix first. Prove provider raw output, Rudder
normalization/persistence, and terminal operator/reviewer surface.

Release request:

```text
release
```

Use `release-maintainer` directly. Live remote state is the source of truth.
