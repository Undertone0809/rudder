# Special Routes

Read this file only for recovery, component-lab, performance, runtime/provider,
or hard proof routes.

## Continuation Recovery

When the thread resumes after `turn_aborted`, rollback, compaction, a long goal
run, unexpected stash creation, or multi-session work, rebuild state before
editing or handing off:

- compare the newest user request with the original task
- check `git status --short --branch`, recent commits, stashes, and relevant
  touched files
- inspect prior session evidence when the user names sessions or says "刚才",
  "之前", "正在处理", or "别把功能弄没了"
- reconstruct current phase, files changed, validation already run, blockers,
  and next safe command
- verify final answer, commit, and push state correspond to the latest request

Classify any stash before applying or dropping it: source session, files
included, overlap with current task, and whether applying it would overwrite
unrelated work.

## Dirty-Worktree Cleanup

For prompts like "这些删了", "only delete package.json changes", "what is this
code", or "is this previous Codex uncommitted work", enter `recovery` before
destructive action.

Build a changed-file ownership packet:

- current branch, upstream, and ahead/behind state
- every modified and untracked path grouped by likely feature or source session
- relevant recent sessions, branch names, commits, and screenshots when the
  user references previous work
- files safe to restore, files to preserve, and unknown files

Do not delete, restore, stash-pop, or commit until the target group is clear. If
the user narrows the scope mid-run, stop and reclassify before touching more
paths.

## Component Lab

UI Lab, component catalog, fixture coverage, and design-system inventory work is
not narrow UI polish.

Define:

- coverage target: hand-authored fixtures, auto-discovered components,
  context-required components, or all of them
- how context-required components are labeled instead of faked
- user-visible route and browser proof
- focused page/unit tests and E2E coverage when navigation or filtering changes
- reviewer gate for coverage quality before handoff

Use `rudder-ui-polish-maintainer` only after the component-lab scope is settled
and the remaining task is a concrete rendered-state fix.

## Performance Benchmark

For app benchmark, control-plane optimization, or "做一下 Rudder 性能优化分析",
start with `performance_benchmark` unless the user names an already-proven
bottleneck.

Before implementation, record:

- workload shape, dataset size, route/API surface, and user scenario
- baseline measurement and the tool/script that produced it
- dependency/cache readiness for intended checks
- one scoped first slice with expected impact and rollback boundary
- verification plan and re-measurement target

Do not promise full validation if dependency install, registry, browser, or
runtime setup is blocked. Report validation readiness before long
implementation.

## Runtime And Provider Contracts

For runtime, provider-adapter, transcript-parser, tool-call, skill-usage,
agent-comment, CLI, or run-analytics contract work, build a provider matrix.

Name:

- runtimes in scope: Codex, Claude, Gemini, OpenCode, Pi, Cursor, or any
  user-named adapter
- actor path: command, heartbeat, CLI invocation, chat action, or runtime wakeup
- transcript/parser evidence: raw log or parsed steps showing the relevant
  tool call, skill call, message, output, or error shape
- persisted Rudder evidence: run record, analytics field, comment, issue,
  message, cost, usage, or activity readback
- terminal surface: run-intelligence view, UI state, CLI output, or API response
- unsupported or blocked providers, with exact blocker evidence

Do not accept "works for Codex" as proof for other providers when the user
raised provider parity. If a runtime cannot be launched locally, preserve the
contract with a parser fixture or recorded log and label the missing
actor-run-chain as blocked/substituted.

For skill-usage analytics, verify both sides:

- ingestion: provider-specific raw transcript/tool-call shape is normalized
- consumption: stored analytics/readback/UI surface reports expected skill usage
  without relying on a Codex-only `SKILL.md` read heuristic

## Reviewer Lens Validation Cases

Use these cases to sanity-check review gate behavior:

- Agent-writable protocol: renderer tests and screenshots are not enough; ask
  whether real agents can discover and author the token through CLI, skills,
  runtime context, docs, or API output.
- UI looks correct but journey is wrong: reconstruct actor, trigger, persisted
  effect, and terminal surface.
- Narrow mechanical patch: two spawned reviewers can be enough, but one must
  challenge scope, command meaning, docs consistency, or hidden side effects.
- Prior requirement becomes skill evidence: if the newest turn asks to optimize
  this router, prior product requirements are evidence, not the active fix.
- Explicit router invocation: apply the spawned reviewer policy unless the user
  disables it or the runtime/tool policy rejects spawning after a real probe.
