---
name: codex-session-benchmark-maintainer
description: >
  Benchmark and compare local Codex sessions for Rudder development work. Use
  when the user gives a target Codex session id or clearly asks to compare one
  session or class of sessions with recent Codex history, recent Rudder runs, or
  "最近 30/50/100 条". Cover efficiency, follow-up rate, interruption rate,
  token/cost hints, problem-resolution rate, workflow quality, or whether the
  target performed better or worse than the surrounding cohort. Produces a
  proxy-metric report with explicit caveats, failure classes, and next
  skill/workflow improvements. Prefer this over generic conversation analysis
  for target-vs-baseline comparison; do not use it alone for cohort-only skill
  hygiene prompts whose deliverable is "which skill should be optimized".
---

# Codex Session Benchmark Maintainer

Use this skill to compare one or more Codex sessions against a recent local
history cohort and turn the result into operational guidance.

The goal is not to claim true satisfaction. Codex logs usually do not contain
ground-truth success labels. The goal is to build a defensible proxy benchmark:
what happened, how much rework appeared, whether the session got to a credible
handoff, and what workflow habit should change next.

## Use When

Use this skill when the user asks for:

- "这个 session 和最近 100 条横向对比一下"
- "效率和问题处理率如何"
- "这个 Codex session 算跑得好吗"
- "看看这个对话比最近的 run 好在哪里"
- "分析这个 session 的 token / follow-up / 返工情况"
- "和最近 30 个 codex session 比一下"
- benchmarking a target Codex session against recent local Codex history
- comparing an agent-run investigation session with recent Rudder run-analysis
  work

## Do Not Use When

Do not use this skill for:

- broad usage categorization with no target session; use
  `codex-conversation-analyst`
- a single Rudder agent run root-cause investigation; use
  `debug-run-transcript-maintainer`
- review-only judgment of a session's product correctness; use
  `codex-session-product-reviewer-maintainer` or
  `agent-work-reviewer-maintainer`
- optimizing a skill from the benchmark result; use `skill-optimizer` after this
  report identifies the reusable failure class
- cohort-only skill maintenance such as "最近 30 个 Codex sessions，哪些 project
  skills 需要优化" with no target session or benchmark comparison; use
  `skill-optimizer` plus a clean recent-session evidence packet
- claiming a session was "successful" without explaining the proxy definition

If the user asks both "why did this session fail" and "how does it compare to
recent sessions", first reconstruct the target session enough to classify it,
then benchmark it against the cohort.

## Default Workflow

### 1. Resolve the benchmark target

Identify:

- target Codex session id or prefix
- project or cwd scope
- comparison window, for example recent 30, 50, or 100 unique sessions
- whether to include related worktrees
- whether Rudder agent-run history is part of the comparison or just the topic
  being discussed inside the Codex session

If there is no target session and the user asks which skills or workflows need
optimization, do not force a benchmark report. Build a brief cohort evidence
packet, then hand off to `skill-optimizer` with the failure classes and target
skill decision points.

If the user gives only a session prefix, search local Codex logs before asking:

```bash
rg "<session-prefix>" ~/.codex/session_index.jsonl ~/.codex/sessions ~/.codex/archived_sessions
```

### 2. Build a clean cohort

Read local Codex JSONL logs from:

- `~/.codex/state_5.sqlite` as the practical primary index when available
- `~/.codex/session_index.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- `~/.codex/archived_sessions/*.jsonl`

For recent-session windows:

- dedupe by `session_meta.payload.id`
- exclude the current active analysis session
- exclude spawned reviewer, sidecar, and current automation child sessions unless
  the user explicitly asks to count all agent activity
- collapse repeated retry/resume clusters when they share the same user goal and
  would otherwise dominate the cohort
- preserve exact cwd and related worktree cwd as separate labels
- include archived sessions only when the requested window or target requires
  them
- ignore injected `AGENTS.md`, environment context, developer text, and skill
  bodies when extracting user intent

Do not count resumed fragments, reviewer child sessions, or duplicated copied
rollout files as separate work unless their `session_meta.id` differs and the
user explicitly wants all agent activity.

When `stage1_outputs` or summaries are missing, read the raw rollout JSONL for
the first user request, user corrections, tool calls, final handoff, and
validation evidence. Do not infer outcomes from the thread title alone.

### 3. Extract proxy metrics

For the target and cohort, compute or estimate:

- real user request count
- number of user follow-ups after the first request
- interruptions or aborted turns
- elapsed wall-clock time from first to last event
- task category and lifecycle stage
- target artifacts changed, if any
- validation evidence reported
- commit, push, PR, or release handoff evidence
- final blocker or unfinished-work language
- model token/cost fields when present in logs or run summaries
- whether the final response looked like a credible handoff

Label every metric as one of:

- `direct`: observable from JSONL
- `derived`: computed from timestamps or event counts
- `proxy`: a stand-in for outcome quality
- `missing`: not present in the logs

### 4. Classify outcome and failure classes

Use cautious categories:

- `clean handoff`: concrete result, evidence, and no same-session correction
- `completed with rework`: final handoff after user corrections or reruns
- `partial or blocked`: explicit blocker, missing validation, or stopped state
- `diagnosis only`: useful analysis without implementation
- `ambiguous`: logs do not prove the outcome

When the target underperforms, name the reusable failure class, not only the
incident:

- wrong skill route
- skipped real scenario verification
- weak source-of-truth check
- over-broad refactor scope
- stale runtime or wrong worktree
- uncommitted or unpushed handoff
- validation gap
- unclear user-intent extraction
- tooling or permission blocker

### 5. Compare target to baseline

For small samples, prefer ranks and plain-English comparison over false
precision.

Useful comparisons:

- target follow-up count vs cohort median
- target interruption count vs cohort
- target elapsed time vs similar task category
- target validation depth vs similar successful sessions
- target handoff completeness vs cohort
- target failure class frequency in recent sessions

When the cohort mixes unlike tasks, split it by category before judging
efficiency. A release or architecture refactor should not be penalized for
having more turns than a one-line UI polish task.

### 6. Recommend the next workflow change

End with one of:

- no new skill needed; route through existing skill
- optimize an existing skill and name the target
- create a new skill, with a short abstraction brief
- change the review or validation gate for a task class
- rerun the target work with a corrected route

If the recommendation is skill optimization, hand off to `skill-optimizer` with:

- evidence
- failure class
- target skill
- exact decision point
- proposed eval case

For cohort-only skill-maintenance prompts, the handoff itself is the main
deliverable. Include:

- cohort construction rules and explicit exclusions
- recurring failure class or success pattern
- target skill and exact decision point
- small proposed patch area
- trigger or behavior eval that would prevent the recurrence

## Output Shape

Use this shape unless the user asks for another format:

```markdown
Verdict: <clean / mixed / weak / ambiguous>

Sample:
- Target: <session id>
- Baseline: <N unique sessions, cwd scope, date range>
- Caveat: <proxy limitation>

Metrics:
| Metric | Target | Baseline | Read |
| --- | ---: | ---: | --- |
| User follow-ups | ... | ... | ... |
| Interruptions | ... | ... | ... |
| Elapsed time | ... | ... | ... |
| Validation evidence | ... | ... | ... |
| Handoff state | ... | ... | ... |

Findings:
1. ...
2. ...
3. ...

Next workflow change:
- ...
```

Keep numbers honest. If a metric is missing, say it is missing instead of
inventing a score.

## Safety Rules

- Read-only by default.
- Do not edit repo files during a benchmark unless the user explicitly asks to
  turn the result into a skill or patch.
- Do not expose unrelated private conversation content beyond the evidence
  needed for the user's requested comparison.
- Do not treat one-message sessions as true success; call it "no same-session
  rework" or another explicit proxy.
- Do not overfit repeated resumed copies of one conversation into a broad
  conclusion.
