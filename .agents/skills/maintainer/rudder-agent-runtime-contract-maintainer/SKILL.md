---
name: rudder-agent-runtime-contract-maintainer
description: >
  Maintain Rudder external-agent runtime contracts across Codex, Claude Code,
  Cursor, OpenCode, Pi, Gemini-style local adapters, and similar process
  runtimes. Use when a task mentions runtime parity, skill isolation,
  HOME/profile boundaries, adapter skill sync, tool-call skill usage
  analytics, stdout/stderr/transcript semantics, local runtime cleanup, or
  proving that the same agent behavior works across multiple providers. Owns
  the cross-runtime contract; routes ordinary run debugging, Desktop recovery,
  release work, and one-off UI review to narrower skills.
---

# Rudder Agent Runtime Contract Maintainer

Use this skill when the problem is not just "a run failed", but "Rudder's
contract with external agent runtimes may be inconsistent, leaky, or
under-proven."

The goal is to protect the operator/runtime boundary: Rudder should control
which skills, session state, environment variables, transcripts, stdout/stderr,
and workspace paths an agent runtime can see and write, regardless of the
provider adapter.

## Use When

Use this skill for prompts like:

- "Claude Code 驱动 Agent 难道没做 skill 隔离吗？"
- "Pi local runs should not read my normal Pi CLI skills or sessions"
- "Codex can infer skill usage this way, but Claude/OpenCode/Gemini use tool calls"
- "Make runtime behavior consistent across Codex, Claude, Cursor, OpenCode, Pi"
- "Does this adapter write to the user's real HOME / CODEX_HOME / skill dir?"
- "Skill usage analytics are wrong for non-Codex providers"
- "Runtime stdout/stderr/transcript parsing differs between providers"
- "Prove the same agent task works through this runtime adapter"

Also use it when a reviewer finds a P1/P2 issue around external-agent runtime
isolation, runtime HOME semantics, adapter skill injection, or provider parity.

## Do Not Use When

Do not use this skill for:

- diagnosing one failed run without changing a runtime contract; use
  `debug-run-transcript-maintainer`
- local Desktop startup, embedded Postgres, packaged boot, or update recovery;
  use `rudder-desktop-dev-recovery-maintainer`
- npm/GitHub/Desktop publishing; use `release-maintainer`
- visible UI-only changes to runtime settings; use
  `rudder-ui-polish-maintainer` or the lifecycle router
- broad lifecycle sequencing where the runtime contract is only one later
  stage; let `development-lifecycle-router-maintainer` route first

If a run diagnosis reveals a runtime-contract bug, use
`debug-run-transcript-maintainer` for the transcript evidence, then switch to
this skill for the contract repair and parity proof.

## Contract Invariants

Preserve these invariants unless a plan explicitly changes the product
contract:

- Runtime adapters must not read or mutate the user's normal CLI skill/session
  state when Rudder intends an isolated managed runtime.
- Runtime-specific home/profile variables must be explicit, testable, and kept
  separate from the operator's normal shell environment.
- Skill injection, skill sync, and skill-usage analytics must account for both
  filesystem-loaded skills and tool-call style "skill" invocations.
- Transcript, stdout, stderr, and result parsing must preserve enough provider
  detail for run-intelligence and reviewer evidence.
- Runtime cleanup must remove only Rudder-owned runtime state and must not
  delete user-owned provider state.
- A parity-sensitive fix is not done until at least one affected runtime path is
  exercised through the real adapter boundary or the strongest available
  targeted substitute.

## Default Workflow

### 1. Build a runtime contract packet

Before editing, identify:

- affected provider adapters, for example Codex, Claude Code, Cursor,
  OpenCode, Pi, Gemini, or a generic process runtime
- the contract class: skill isolation, HOME/profile routing, skill sync,
  transcript parsing, stdout/stderr handling, cleanup, analytics, or adapter
  config
- the actor path: operator action, server/runtime service, adapter process,
  persisted run record, and UI/readback surface
- exact evidence from user prompt, logs, transcript, tests, or reviewer notes
- whether this is a parity issue across providers or a single-provider bug

Do not start by patching one adapter until you know whether a shared contract
helper or shared test fixture should own the behavior.

### 2. Read the executable contract

Prefer current code and tests over memory:

- `doc/spec/agents-runtime.md`
- `server/src/local-runtime.ts`
- `server/src/services/workspace-runtime*.ts`
- `server/src/services/runtime-kernel/*`
- `server/src/services/agent-enabled-skills.ts`
- `server/src/services/runtime-trace-metadata.ts`
- `packages/run-intelligence-core/src/*`
- `ui/src/agent-runtimes/**`
- adapter tests under `server/src/__tests__/*-local-adapter*.test.ts`
- skill sync tests under `server/src/__tests__/*-local-skill-sync.test.ts`
- environment tests under `server/src/__tests__/*-adapter-environment.test.ts`

Read only the relevant adapter family plus the shared helper layer. If multiple
providers are affected, build a small matrix instead of scanning every file.

### 3. Design the narrow contract fix

Prefer changes in shared helpers when the invariant is provider-independent.
Use adapter-specific code only when the provider's CLI semantics differ.

For every fix, decide:

- where the contract should live: shared runtime helper, adapter config,
  transcript parser, analytics inference, cleanup utility, or docs
- which provider-specific behavior must remain different
- whether legacy `paperclip*` identifiers or config keys need compatibility
- what data proves the fix: env snapshot, generated command, transcript
  outline, skill directory listing, DB readback, UI readback, or run log

Do not hide provider differences behind a generic abstraction if the runtime
needs explicit handling to be safe.

### 4. Prove parity and isolation

Validation should match the contract class:

- adapter command/env changes: run the affected adapter environment tests
- skill injection/sync: run the relevant `*-local-skill-sync` tests and inspect
  generated skill paths when possible
- transcript/stdout/stderr semantics: run run-intelligence parser/trace tests
  plus a representative adapter transcript fixture
- analytics: assert both filesystem skill loading and tool-call skill usage
  cases
- cleanup/profile isolation: assert Rudder-owned paths are removed or isolated
  while user-owned provider paths are untouched

When a real provider run is feasible, capture a short actor-run-chain:

1. Rudder starts or configures the runtime.
2. The adapter receives the intended env/profile/skill state.
3. The run produces transcript or usage evidence.
4. Rudder stores and displays the expected result.

If a real provider run is not feasible, state the missing provider proof and use
the strongest targeted substitute.

### 5. Handoff

Report:

- contract invariant protected
- affected providers
- code and test surfaces touched
- runtime evidence collected
- remaining provider or platform proof gaps
- whether follow-up belongs to run debugging, Desktop recovery, release, or UI

For high-risk parity changes, use `agent-work-reviewer-maintainer` before
handoff and ask reviewers to focus on isolation leaks, provider asymmetry, and
evidence strength.

## Common Failure Modes

- assuming Codex skill/session behavior generalizes to Claude Code, Pi,
  OpenCode, Cursor, or Gemini-style tool calls
- fixing one adapter while leaving another adapter's skill sync or HOME
  behavior inconsistent
- using DB rows or UI badges as proof of runtime behavior without adapter-side
  env/log evidence
- treating benign stderr filtering as transcript semantics
- cleaning a runtime directory without proving it is Rudder-owned
- calling a parity fix done after typecheck only
