---
title: Agent Skills And Inbox
domain: agents
status: active
coverage: detailed
contract_ids:
  - AGENT.SKILLS.001
  - AGENT.SKILL.TELEMETRY.001
  - AGENT.INBOX.001
related_code:
  - server/src/routes/agents.ts
  - server/src/services/agent-enabled-skills.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/services/knowledge-portability/organization-skills.catalog.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - ui/src/pages/AgentDetail.skills.tsx
related_tests:
  - server/src/__tests__/agent-skill-contract.test.ts
  - server/src/__tests__/heartbeat-skill-analytics.test.ts
  - server/src/__tests__/agent-inbox-reviewer.test.ts
  - tests/e2e/organization-agent-skills.spec.ts
edit_policy: user_confirmed_only
---

# Agent Skills And Inbox

## AGENT.SKILLS.001

Why:

- Skills are reusable operating procedures. Installing or discovering a skill is
  different from enabling it for a specific agent/runtime invocation.
- Global/user and adapter-native skill sources may be discovered so the Agent
  Skills page can show candidates, but discovery is not runtime enablement.
- Bundled Rudder skills define core control-plane operations and must remain
  available even when optional skills are disabled.

Product model:

- Skill sources include bundled skills, organization skill library, agent home,
  global/user skill roots, and adapter-native skill directories when supported.
- Skill state distinguishes discovered, installed, desired, enabled,
  materialized, native, prompt-injected, and unavailable entries.
- Desired skills are scoped by organization, agent, runtime type, and runtime
  capability.
- Runtime-loaded skill selection is owned by Rudder. The adapter transports or
  materializes the Rudder-resolved enabled/always-enabled set for the exact
  invocation; it does not choose additional skills from provider-native,
  operator-home, project, global, or adapter-home defaults.
- Provider-native built-in capabilities that the provider CLI always exposes
  are not Rudder-enabled skills. If they cannot be disabled by provider config,
  Rudder keeps them out of desired/materialized/loaded skill metadata and
  instructs the agent to answer Rudder skill questions from the
  Rudder-resolved set only.

Flow:

1. Organization skill library is seeded and scanned.
2. Agent skill snapshot is built from all supported sources.
3. Desired selection is validated against available/always-enabled entries.
4. Runtime skill sync/materialization prepares the runtime-side skill surface
   from the Rudder-resolved desired/always-enabled set only.
5. Instruction loading exposes desired/realized skill facts to the adapter.

Invariants:

- Bundled Rudder skills are not disabled by normal optional-skill toggles.
- A discovered skill is absent from runtime prompt text, provider-visible skill
  directories, provider-native config, and loaded-skill metadata until Rudder
  resolves it as enabled or always-enabled for that invocation.
- Adapters must prune, disable, isolate, or ignore stale Rudder-managed and
  provider-native skill entries that are not in the current selected set.
- Agent-facing skill status must separate Rudder-enabled skills from
  provider-native built-ins. Runtime prompts must not let provider-native
  built-ins appear as this agent's Rudder-loaded skills.
- Skill UI copy must not imply that a discovered skill was used in a run.

Evidence:

- Agent Detail Skills tab shows source and enabled state.
- Runtime invocation receives desired skill context.

## AGENT.SKILL.TELEMETRY.001

Why:

- Skill analytics can mislead product decisions if loaded skills are counted as
  used skills. Evidence levels must preserve the difference between available,
  requested, loaded, and actually used.

Flow:

1. Runtime invocation records desired, realized, native, prompt-injected, and
   loaded skill metadata.
2. Transcript parsing or runtime result evidence records skill usage when
   provider output proves it.
3. Analytics aggregate by strongest available evidence:
   `used > promptRequested/requested > loaded`.
4. Dashboard/Agent Detail surfaces label the evidence level instead of treating
   every loaded skill as usage.

Invariants:

- Loaded is not used.
- Provider-specific parsing must be normalized before analytics consumption.

Evidence:

- Skill analytics tests cover evidence hierarchy.
- Run events can carry skill usage evidence derived from transcripts.

## AGENT.INBOX.001

Why:

- The runtime-facing inbox is what an agent uses to decide what work is
  actionable. It must match routing contracts rather than expose every issue in
  the organization.

Product model:

- Inbox includes assignee work in actionable assignee states and reviewer work
  in reviewable states.
- If an issue appears in both assignee and reviewer paths, reviewer context can
  override relationship metadata when review is the next action.
- Reviewer-blocked rows with recorded decisions are excluded from repeated
  reviewer pickup.

Flow:

1. Agent authenticates to `/agents/me/inbox-lite`.
2. Server queries assignee and reviewer issue rows in allowed states.
3. Rows are deduped by issue id and annotated with relationship, status,
   priority, and active run facts.
4. Runtime prompts and agent CLI use the inbox as work-selection context.

Invariants:

- Agent inbox is organization-scoped to the authenticated agent.
- Inbox selection does not change issue ownership; it only exposes next-action
  candidates.

Evidence:

- Inbox reviewer tests cover assignee/reviewer merge semantics.
- Runtime prompt helpers expose inbox context to running agents.
