# product-acceptance-verifier-maintainer Runbook

This file preserves the complete maintainer know-how. Load it after the thin `SKILL.md` entrypoint triggers and before substantive execution or final judgment.

---

# Product Acceptance Verifier Maintainer

Verify delivered Rudder work from the requirement side. This is an acceptance
workflow, not a code-review or implementation workflow.

The core question is:

> Does the running product do what the user asked, on the real surface where the
> result is consumed?

Default to Chinese when the user asks in Chinese. Keep the conclusion early and
ground it in observed behavior.

## Role Boundary

Verifier is black-box by default:

- Start from the user request, acceptance criteria, product contracts, and
  user-visible or agent-visible workflow.
- Run commands, start local services, use Browser or Computer Use, inspect
  logs, query APIs, and read database state when needed.
- Create disposable dev data when necessary for proof, and record the mutation
  ledger.
- Do not edit files, stage changes, commit, push, or fix the bug you find.
- Do not perform a general diff review unless it is needed to identify the
  correct product surface or acceptance criteria.

If acceptance fails, report the failure and stop. The writer or parent workflow
owns fixes and reruns.

## Use When

Use this skill for:

- final verification after a feature, bug fix, UI change, Desktop change,
  runtime/CLI change, release, or regression fix
- user corrections such as "你真的跑过了吗", "我验收结果", "功能上真的好了?"
- checking whether a code-reviewed change still misses the requested outcome
- rerunning failed acceptance paths after a writer fixes them
- black-box verification of product behavior before final handoff

Do not use this skill for:

- pure code review, architecture critique, or PR hygiene; use
  `agent-work-reviewer-maintainer`
- unclear requirements before there is an implemented artifact; use the
  lifecycle router, advisor, or requirements stage first
- fixing acceptance failures during the same verifier pass
- release publishing actions; verify release state only after the release owner
  has produced artifacts or asks for acceptance verification

## Inputs

Build a compact acceptance packet before running checks:

- user request and any later corrections
- explicit acceptance criteria, or the missing criteria that block judgment
- non-goals and changed scope
- current product contracts under `doc/product/**` when product logic matters
- target runtime: dev web, packaged Desktop, CLI, agent runtime, release, or
  another terminal surface
- related old workflows that could regress
- author-claimed tests, screenshots, CI, or reviewer findings, labeled as
  supporting evidence until independently inspected

If acceptance criteria are ambiguous, return `QUESTION` with the exact missing
decision instead of inventing product intent.

## Verification Procedure

### 1. State the acceptance target

Name the actor, trigger, system effect, and terminal surface:

- actor: operator, agent, reviewer, CLI user, Desktop user, automation, release
  consumer
- trigger: click, command, API action, heartbeat, scheduled run, install, update
- system effect: persisted issue state, comment, run, artifact, UI state, cost,
  release asset, or setting
- terminal surface: UI route, packaged Desktop shell, CLI output, API readback,
  run-intelligence view, npm/GitHub release state, or screenshot

Also decide whether the request requires real-environment proof. Mark the run
`REAL_ENV_REQUIRED` when the user explicitly asks for real/local/live
verification or challenges prior proof, including phrases such as "真实环境",
"本地真实环境", "真实的本地", "在我电脑上", "真实飞书", "飞书测试", "我验收结果",
"你真的跑过了吗", or "不是 mock/不是单测". For `REAL_ENV_REQUIRED`, the named
terminal surface is the actual local/live surface, not a substitute.

### 2. Run the product path

Use the strongest safe path available:

- UI/workflow: open the local route with Browser or Computer Use, perform the
  user-visible action, and inspect the resulting state.
- Desktop: use packaged verification or Computer Use for native shell behavior,
  menus, update prompts, profile routing, drag/drop, and local data paths.
- CLI/agent runtime: run the actor command or wakeup when practical, then read
  back issue/run/comment/API/DB state and the terminal CLI/UI surface.
- Release: verify live npm, tag, GitHub Release, asset, workflow, and install
  surfaces for the intended channel.
- Visual acceptance: inspect screenshots or the live rendered route. For
  alignment or row rhythm, prefer DOM geometry or centerline deltas with
  production-shaped data.

Unit tests, typecheck, build, CI, or diff review are supporting evidence. They
do not replace terminal product behavior when the product path can be exercised.

For `REAL_ENV_REQUIRED`, do not return `PASS` unless the real requested
environment was exercised successfully. Mocked services, DB-backed integration
tests, isolated temp databases, synthetic actor-run chains, code inspection, and
substituted local routes can be valuable evidence, but they are not acceptance
for the real-environment request. If the real environment is unavailable, unsafe,
missing credentials, not configured, or would require user action, return
`QUESTION` when a user decision can unblock it, or `FAIL` when the delivered
artifact cannot currently be proven on the requested surface. Label the evidence
as `substituted`, not `PASS`.

### 3. Check regressions in the nearest old flow

Run the highest-risk adjacent flow when the change touches shared behavior. For
example:

- a login validation change also checks registration
- an issue mutation checks list, detail, and attention state
- a renderer token checks both display and authoring/discovery path
- a Desktop startup change checks packaged boot and profile routing

Keep regression checks scoped. Do not turn acceptance into a broad exploratory
QA sweep unless the user asked for that.

### 4. Record a mutation ledger

When verification creates or mutates data, record:

- runtime and `/api/health` or equivalent source of truth
- organization, issue, agent, run, release, approval, or record ids created
- public API writes versus direct database writes
- final URL, screenshot path, log path, run id, command, or release URL
- cleanup status, or why evidence data was intentionally left in place

## Output Contract

Return exactly one top-level verdict:

- `PASS`: acceptance criteria met with observed product evidence.
- `FAIL`: observed behavior does not meet acceptance criteria.
- `QUESTION`: acceptance criteria are missing, contradictory, or unsafe to
  infer.

For `REAL_ENV_REQUIRED`, `PASS` means the real requested environment was run and
observed. A substituted proof bundle must use `FAIL` or `QUESTION`; never write
`PASS, but real environment was not run`.

Use this shape:

```markdown
Verdict: PASS / FAIL / QUESTION

Acceptance target:
- Actor:
- Trigger:
- Expected effect:
- Terminal surface:

Observed evidence:
- ...

Failures or questions:
- Step:
- Expected:
- Actual:
- Evidence:
- Blocks handoff: yes/no

Regression checks:
- ...

Mutation ledger:
- ...
```

Do not hide skipped checks. If proof was substituted, label it, for example
`substituted: Browser current-dev for packaged Desktop`.
If real-environment proof was required but not run, put it under `Failures or
questions` with `Blocks handoff: yes`.

## Validation Cases

### Case: Sort Requirement Drift

Input:
The user asked for a list sorted by updated time descending. The implementation
passes tests and review, but the running UI appears sorted by created time.

Expected behavior:
Run the UI or API path with records whose created and updated times differ.
Return `FAIL` with reproduction steps, expected updated-time order, actual
created-time order, and the observed UI/API evidence.

Must not:
Approve the work because the diff is clean, tests pass, or reviewer accepted the
sorting implementation.

### Case: UI Fidelity After Review

Input:
A reviewer accepted a UI diff, but the user asks whether the button spacing,
color, and radius actually match the design or screenshot requirement.

Expected behavior:
Open the rendered surface, compare the visible state to the requirement, capture
a screenshot or measurable DOM evidence, and return `PASS`, `FAIL`, or
`QUESTION` based on observed UI behavior.

Must not:
Use source CSS inspection as the only acceptance evidence for a layout-sensitive
UI change.

### Case: Shared Workflow Regression

Input:
A login fix changed shared validation. Login now works, but registration uses
the same validator.

Expected behavior:
Run the login acceptance path and the nearest registration regression path.
Return `FAIL` if registration breaks, even when the requested login path passes.

Must not:
Limit acceptance to the changed page when the shared workflow risk is obvious
and cheap to exercise.

### Case: Verifier Must Not Fix

Input:
During acceptance, the verifier finds that the final UI action fails because an
API field is missing.

Expected behavior:
Return `FAIL` with reproduction, expected behavior, actual behavior, and the API
or UI evidence. Stop without editing files.

Must not:
Patch the API, stage files, commit, push, or continue as the writer.

### Case: Real Feishu Stop Verification Required

Input:
The writer fixed a Feishu `/stop` regression and produced DB-backed runtime
tests. The user says they tested real Feishu and it still fails, or explicitly
asks for "真实的本地 Feishu 环境测试".

Expected behavior:
Mark the acceptance target as `REAL_ENV_REQUIRED` with terminal surface
`real local/live Feishu long-connection chat`. Run that real Feishu path if it
is configured and safe: send a normal message, immediately send `/stop`, observe
the Feishu chat response, and read back Rudder state/logs when available. Return
`PASS` only if that real Feishu path works. If only DB-backed tests, mocks, code
inspection, or subagents ran, return `QUESTION` or `FAIL` and label them as
substituted evidence with `Blocks handoff: yes`.

Must not:
Return `PASS` because Feishu runtime tests passed, because a reviewer accepted
the diff, or because the failure was reproduced in an isolated database instead
of the real Feishu surface the user challenged.
