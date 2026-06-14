---
title: Runtime heartbeat prompt and Rudder Studio practice cases
date: 2026-06-14
kind: implementation
status: in_progress
area: agent_runtimes
entities:
  - heartbeat_runs
  - agent_operating_contract
  - agent_runtime_instructions
  - rudder_studio
issue:
related_plans:
  - 2026-05-04-agent-operating-contract-runtime.md
  - 2026-06-03-heartbeat-instructions-scene-gate.md
  - 2026-06-14-rudder-operating-skill-reframe.md
supersedes: []
related_code:
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - packages/agent-runtime-utils/src/server-utils.instructions.ts
  - packages/agent-runtime-utils/src/server-utils.test.ts
  - server/resources/bundled-skills/rudder/SKILL.md
  - server/src/__tests__/bundled-rudder-skill-docs.test.ts
  - server/src/services/default-agent-instructions.ts
  - server/src/onboarding-assets/default/HEARTBEAT.md
  - server/src/onboarding-assets/ceo/HEARTBEAT.md
  - doc/SPEC-implementation.md
  - .agents/skills/maintainer/mock-data-maintainer/data/rudder-studio
  - .agents/skills/maintainer/mock-data-maintainer/references/rudder-studio-scenario.md
  - .agents/skills/maintainer/mock-data-maintainer/scripts/seed-rudder-studio.ts
commit_refs: []
updated_at: 2026-06-14
---

# Runtime Heartbeat Prompt And Rudder Studio Practice Cases

## Problem

`HEARTBEAT.md` currently acts like a per-agent instruction file, but the
behavior it carries is really Rudder's fixed timed-wakeup pipeline: wake an
agent, inspect assigned or reviewer work, checkout, do one bounded chunk, and
leave a durable close-out signal. That pipeline belongs to runtime-owned Rudder
instructions, not to an agent-local Markdown file that can drift from the
bundled `rudder` skill.

Rudder Studio also needs stronger example data. Its purpose is not only to make
screens non-empty; it should teach agents what good and bad Rudder practice
looks like across realistic control-plane scenarios.

## Route

`development-lifecycle-router-maintainer` is the workflow controller for this
change. Primary stage is `runtime_contract -> implementation -> verification ->
review -> handoff`.

## Proposed Change

1. Add a code-owned `RUDDER_AGENT_HEARTBEAT_INSTRUCTION` prompt beside
   `RUDDER_AGENT_OPERATING_CONTRACT`.
2. Inject that prompt only when `includeHeartbeatInstructions` is true for a
   heartbeat scene.
3. Stop treating sibling or entry `HEARTBEAT.md` files as the default heartbeat
   behavior.
4. Stop creating default `HEARTBEAT.md` files in managed onboarding bundles.
5. Update docs/tests that currently describe `HEARTBEAT.md` as the heartbeat
   operating protocol.
6. Thin the bundled `rudder` skill so it no longer carries the full heartbeat
   flow. It should point heartbeat-scene execution to the runtime prompt and
   retain detailed Rudder control-plane best practices, reference pointers,
   Library handoff rules, reviewer decision semantics, and organization-skill
   workflow rules.
7. Add Rudder Studio best-practice Good/Bad cases as causal scenario data
   through fixture JSON, seeded issues/chats/runs/comments, and dry-run
   assertions.

## Legacy `HEARTBEAT.md` Handling

Runtime-owned heartbeat instructions become authoritative for the fixed
pipeline. Existing user-authored `HEARTBEAT.md` files are not deleted.

Compatibility policy:

- Managed default bundles stop creating `HEARTBEAT.md`.
- For heartbeat scenes, a sibling or explicit-entry `HEARTBEAT.md` may still be
  loaded only as supplemental custom heartbeat notes after the code-owned
  runtime heartbeat prompt.
- Command notes must make precedence explicit: runtime heartbeat instructions
  loaded from code; custom `HEARTBEAT.md` loaded as supplemental notes.
- For non-heartbeat scenes, `HEARTBEAT.md` remains skipped.
- `HEARTBEAT.md` content must not be described in docs or metrics as the
  platform heartbeat operating protocol.

## Runtime Prompt Assembly And Observability

Prompt order for heartbeat scenes:

1. `RUDDER_AGENT_OPERATING_CONTRACT`
2. `RUDDER_AGENT_HEARTBEAT_INSTRUCTION`
3. configured entry instructions and sibling `SOUL.md` / `TOOLS.md` /
   `MEMORY.md`
4. supplemental `HEARTBEAT.md` notes, if present
5. wake-trigger prompt with dynamic issue/comment/recovery context
6. enabled skills, including bundled `rudder`

Observability contract:

- Add a command note such as `Loaded Rudder heartbeat instructions from runtime
  code`.
- Keep a distinct metric for runtime heartbeat prompt bytes, for example
  `runtimeHeartbeatChars`.
- Keep file-backed supplemental `HEARTBEAT.md` bytes separate, for example
  `heartbeatFileChars`, or clearly redefine the existing metric without
  implying it came from a file.
- `heartbeatFilePath` should stay `null` when only the runtime prompt is
  injected.

## Actor Journey

- Timer heartbeat: runtime prompt tells the agent to inspect inbox, prioritize
  reviewer close-out / in-progress / todo, checkout before domain work, and
  leave one close-out signal.
- Assignment wake: dynamic wake prompt names the issue; runtime heartbeat prompt
  supplies the ordering; bundled `rudder` skill supplies command details.
- Reviewer wake: runtime prompt requires structured review close-out; bundled
  `rudder` skill preserves review decision semantics.
- Mention wake: dynamic wake prompt carries the comment; runtime heartbeat
  prompt and `rudder` skill preserve attention-versus-ownership transfer.
- Passive follow-up: dynamic passive prompt names the close-out gap; runtime
  heartbeat prompt keeps it as governance, not new work discovery.
- Non-heartbeat chat or manual CLI context: runtime heartbeat prompt is absent;
  `rudder` skill still provides control-plane guidance when explicitly used.

## Source Of Truth Split

- Runtime operating contract: cross-scene path, Library, renderable-link,
  memory, and safety invariants.
- Runtime heartbeat instruction prompt: heartbeat-scene pipeline and ordering.
- Bundled `rudder` skill: detailed Rudder control-plane best practices and
  reference guidance that can be used from heartbeat, chat, or manual CLI
  contexts. It should not duplicate the full heartbeat scene pipeline once the
  runtime heartbeat prompt owns that flow.
- Bundled `rudder` skill must retain scene-independent rails: checkout before
  task work, no `409` retry, structured reviewer decisions, Library
  `markdownLink`, screenshot `--image`, mention ownership transfer boundary,
  and `skills enable` versus `skills sync`.
- Agent `SOUL.md` / role config: persona and role-specific responsibilities.
- Rudder Studio fixtures: realistic examples that help agents learn good and
  bad operating patterns from durable records.

## Rudder Studio Practice Case Coverage

Add cases covering:

- Good: atomic checkout before implementation.
- Bad: self-assigning from a mention without explicit ownership transfer.
- Good: reviewer uses structured review decision.
- Bad: reviewer leaves free-form "looks good" and causes review close-out
  follow-up.
- Good: durable Library artifact cited with `markdownLink`.
- Bad: screenshot or local file path mentioned without attachment or durable
  reference.
- Good: blocked work names the human/external blocker and next action.
- Bad: agent creates unparented work or vague follow-up without `parentId` /
  `goalId`.
- Good: organization-skill work uses agent-private skill for self-use and
  organization-skill workflow only when authorized.
- Bad: `skills sync` used when additive `enable` was intended.

Each case must have a stable `practiceCaseKey` and a visible seeded surface:
issue description, issue status, comments, chat messages, run/event evidence,
approval/blocker state, activity log, or artifact reference. Dry-run validation
must assert the required case keys exist so the scenario cannot silently lose
its teaching examples.

## Validation

- Runtime instruction loader tests should prove the code-owned heartbeat prompt
  appears for heartbeat scenes and `HEARTBEAT.md` no longer auto-loads.
- Runtime execution tests should prove a heartbeat scene includes the code-owned
  heartbeat prompt and reports heartbeat prompt metrics/notes.
- Default agent bundle tests should prove managed bundles no longer include
  `HEARTBEAT.md`.
- Bundled `rudder` skill doc tests should prove the skill references the
  runtime-owned heartbeat prompt instead of carrying a full heartbeat operating
  loop or decision table.
- Rudder Studio fixture validation should continue to pass in dry-run mode and
  should assert the new `practiceCaseKey` coverage.

## Non-Goals

- No UI redesign in this slice.
- No change to the `rudder` CLI command contract.
- No new agent skill.
- No removal of arbitrary user-authored files from existing workspaces.
