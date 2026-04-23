---
title: Rudder core tools hybrid surface
date: 2026-04-17
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - rudder_core_tools
  - agent_run_context
  - runtime_skills
issue:
related_plans:
  - 2026-04-05-run-detail-transcript-v2.md
  - 2026-04-12-agent-skill-loading-boundary.md
  - 2026-04-14-codex-managed-skill-materialization.md
  - 2026-04-16-unify-chat-agent-run-semantics.md
supersedes: []
related_code:
  - server/resources/bundled-skills/rudder/SKILL.md
  - desktop/.packaged/server-package/resources/bundled-skills/rudder/SKILL.md
  - cli/src/client/http.ts
  - cli/src/commands/client/common.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/gemini-local/src/server/execute.ts
  - server/src/services/plugin-tool-dispatcher.ts
  - ui/src/components/transcript/RunTranscriptView.tsx
commit_refs:
  - docs: propose rudder core tools hybrid surface
updated_at: 2026-04-17
---

# Rudder Core Tools Hybrid Surface

## Overview

Introduce a built-in Rudder core-tool surface for high-frequency control-plane
actions during agent runs, while keeping the bundled `rudder` skill as the
workflow-policy layer and keeping the `rudder` CLI as a debug/manual/fallback
surface.

This proposal does not remove the CLI or skill system.
It changes which layer owns trusted execution of core Rudder actions inside a
run.

## What Is The Problem?

Current agent runs use the bundled `rudder` skill to teach the model to call
`rudder ... --json` through shell tools.

That works, but it creates a poor boundary for core control-plane actions:

- run-scoped auth is already injected by the runtime, but each action still
  replays the full `CLI process -> HTTP request -> server route` path
- the agent must reason about transport details such as command spelling,
  env defaults, and fallback behavior
- transcript review loses semantic meaning because actions such as
  `issue checkout` render as generic `bash`
- workflow policy, command catalog, and trusted host capability are all mixed
  into one skill

The result is not a missing-auth bug.
It is a host-capability problem being expressed through prompt instructions.

## What Will Be Changed?

- Add a built-in Rudder core-tool surface owned by the host/runtime layer.
- Use that surface for a narrow first batch of governance-sensitive and
  high-frequency actions:
  - `agent.me`
  - `agent.inbox`
  - `issue.context`
  - `issue.checkout`
  - `issue.comment`
  - `issue.done`
  - `issue.block`
  - `issue.documents.get`
  - `issue.documents.put`
- Keep the bundled `rudder` skill, but rewrite it so it teaches:
  - workflow ordering
  - escalation rules
  - comment style
  - when to use core tools vs CLI fallback
- Keep the `rudder` CLI as:
  - manual local operator surface
  - compatibility surface
  - fallback for long-tail commands not promoted to core tools
- Make run transcript rendering recognize Rudder core-tool actions as
  first-class execution semantics instead of generic shell activity.

## Success Criteria For Change

- Core Rudder actions no longer require the agent to compose shell commands in
  the common heartbeat path.
- Host-owned run context supplies trusted `orgId`, `agentId`, and `runId`
  directly to core actions.
- Run detail shows a readable Rudder action timeline such as
  `Rudder action: issue.checkout` instead of `/bin/zsh -lc 'rudder ...'`.
- The bundled `rudder` skill becomes shorter and more policy-focused.
- CLI and tool behavior stay aligned through shared server-side action logic
  rather than duplicated product rules.

## Out Of Scope

- Full replacement of the entire `rudder` CLI surface with tools
- Exposing these actions as plugin-owned tools
- Replacing organization skills or the general skills loading model
- Reworking human board auth or CLI board-login UX
- Adding remote-cloud runtime auth changes beyond the existing run token model

## Non-Functional Requirements

- security:
  - core Rudder actions must remain host-owned and must not weaken existing
    organization or agent scoping rules
  - plugin tools must not gain authority over checkout, approval, or other
    control-plane invariants through this proposal
- maintainability:
  - the same server-side service methods should back both CLI commands and
    core tools where possible
  - avoid creating a second independent contract that drifts from the CLI
- usability:
  - the default run path should reduce prompt burden and remove transport noise
  - transcript inspection should become more understandable for operators
- observability:
  - core-tool calls should carry stable semantic names and structured input/output
    for transcript, logs, and future tracing

## User Experience Walkthrough

1. A heartbeat starts and Rudder injects the normal run context.
2. The bundled `rudder` skill tells the agent to follow the heartbeat workflow
   and use Rudder core tools for standard control-plane actions.
3. The agent asks for `issue.checkout` through the built-in tool surface.
4. The host executes the action directly against Rudder services using trusted
   run context.
5. The transcript records a semantic Rudder action entry, not a generic shell
   command.
6. If the agent needs a long-tail command that does not exist as a core tool,
   it can still use `rudder ... --json` through the CLI fallback path.

## Implementation

### Product Or Technical Architecture Changes

Introduce a new internal distinction:

- `Rudder core tools`
  - built-in, host-owned, trusted
  - available during agent runs
  - typed and semantically named
- `skills`
  - prompt-level workflow guidance
  - explain order, policy, and when to escalate
- `CLI`
  - debug/manual/fallback transport

This is a hybrid model, not a replacement model.

### Breaking Change

No external product or API breaking change is required for the first phase.
The CLI remains supported.
The skill remains present.
The change is in preferred execution path during agent runs.

### Design

#### 1. Ownership

Rudder core tools should be built-in host capabilities, not plugin tools.

Reasoning:

- checkout, issue mutation, and approval-adjacent actions are core governance
  surfaces
- plugin tools are intentionally additive and must not own core invariants
- the host already has the trusted run context needed to execute these safely

#### 2. Surface Shape

Use the same general design language as the existing tool dispatcher:

- stable tool name
- JSON-schema-like input contract
- trusted run context supplied by host
- structured result payload

But keep this as a separate built-in registry/dispatcher for core actions so the
platform does not pretend that checkout semantics are just another plugin.

#### 3. Service Reuse

Avoid implementing business rules twice.

- core tools should call the same server services used by the CLI-backed routes
- the CLI should continue to call HTTP routes or a shared client stack
- product rules should live in services, not in the skill text, CLI parser, or
  transcript heuristics

#### 4. Skill Rewrite

The bundled `rudder` skill should stop being the primary command catalog for
common heartbeats.

It should primarily describe:

- heartbeat order
- approval-first and checkout-first policy
- escalation rules
- comment style
- fallback guidance when a needed action is not available as a core tool

#### 5. Transcript Semantics

Add a Rudder-specific semantic block so the operator sees control-plane work as
platform actions, not shell trivia.

Examples:

- `Rudder action: agent.inbox`
- `Rudder action: issue.checkout`
- `Rudder action: issue.documents.put`

This aligns the run surface with Rudder's product promise of human-readable
execution review first, raw debug detail second.

#### 6. First Batch Boundary

Promote only the repeated, heartbeat-critical commands first.

Keep these on CLI fallback in phase one:

- organization skill scanning/import workflows
- long-tail admin/diagnostic commands
- commands mainly used by humans outside heartbeat runs

### Security

- No new remote trust boundary is introduced in phase one.
- Core tools use the already-trusted run context assembled by Rudder.
- Existing organization checks, assignee checks, and activity logging remain in
  the called services.
- Do not expose core checkout or approval semantics through plugin-owned tool
  registration.

## What Is Your Testing Plan (QA)?

### Goal

Prove that the common heartbeat control-plane path uses built-in Rudder tools,
preserves current governance behavior, and improves transcript semantics.

### Prerequisites

- one local runtime with run-scoped agent auth injection working
- one test agent with the bundled `rudder` skill enabled
- at least one assigned issue with comments and a plan document

### Test Scenarios / Cases

- heartbeat run uses `agent.inbox`, `issue.context`, and `issue.checkout`
  through built-in tools
- checkout conflict still returns the same semantic failure behavior as today
- comment/done/block actions still attach run metadata and create activity log
  records
- issue document read/write works through the core-tool path
- long-tail `rudder` CLI fallback still works when a command is not promoted
- run transcript renders Rudder actions distinctly from bash
- packaged desktop path and dev path both expose the same built-in Rudder tool
  surface

### Expected Results

- common heartbeat flows do not need shell-wrapped `rudder ... --json`
- transcript is easier to review
- CLI remains valid for fallback/manual use
- no regression in org scoping, assignee enforcement, or completion/block rules

### Pass / Fail

- Pending implementation

## Documentation Changes

- `server/resources/bundled-skills/rudder/SKILL.md`
- `desktop/.packaged/server-package/resources/bundled-skills/rudder/SKILL.md`
- `server/resources/bundled-skills/rudder/references/cli-reference.md`
- runtime-specific execution notes that currently instruct agents to use
  `run_shell_command({ command: "rudder ..." })`
- transcript/run-detail docs if the new semantic block needs explicit guidance

## Open Issues

- Whether the built-in core-tool registry should share infrastructure with the
  plugin tool dispatcher or stay fully separate
- How much of the CLI command naming should be preserved verbatim in tool names
  vs normalized dot-path names
- Whether chat should consume the same core-tool surface in the same phase or
  only after heartbeat integration proves stable
- Whether some document and approval operations should remain CLI-only until
  transcript semantics are updated
