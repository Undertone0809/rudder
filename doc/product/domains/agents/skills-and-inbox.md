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
  - packages/shared/src/organization-skill-reference.ts
  - server/resources/bundled-skills/browser/SKILL.md
  - server/resources/bundled-skills/rudder-docs/SKILL.md
  - server/resources/bundled-skills/skill-creator/SKILL.md
  - server/resources/bundled-skills/skill-creator/references/rudder.md
  - server/resources/bundled-skills/rudder-docs/references/agent-creation.md
  - server/resources/bundled-skills/rudder-docs/references/plugin-authoring.md
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - server/src/routes/agents.ts
  - server/src/services/runtime-kernel/heartbeat.misc.ts
  - server/src/services/agent-run-context.ts
  - server/src/services/agent-enabled-skills.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/services/knowledge-portability/organization-skills.catalog.ts
  - packages/agent-runtime-utils/src/server-utils.prompts.ts
  - ui/src/components/ActivityCharts.tsx
  - ui/src/pages/AgentDetail.tsx
  - ui/src/pages/AgentDetail.skills.tsx
related_tests:
  - server/src/__tests__/agent-run-context.test.ts
  - server/src/__tests__/organization-skills-reference.test.ts
  - server/src/__tests__/organization-skills-prune.test.ts
  - desktop/scripts/smoke.mjs
  - server/src/__tests__/agent-skill-contract.test.ts
  - server/src/__tests__/heartbeat-skill-analytics.test.ts
  - ui/src/components/ActivityCharts.test.tsx
  - server/src/__tests__/agent-inbox-reviewer.test.ts
  - tests/e2e/agent-dashboard-one-day.spec.ts
  - tests/e2e/agent-dashboard-skills-analytics.spec.ts
  - tests/e2e/organization-agent-skills.spec.ts
related_plans:
  - doc/plans/2026-07-18-rudder-docs-skill-proposal.md
  - doc/plans/2026-07-20-merge-rudder-creation-skills-into-docs.md
  - doc/plans/2026-07-24-org-skill-runtime-materialization-fix.md
edit_policy: user_confirmed_only
---

# Agent Skills And Inbox

## AGENT.SKILLS.001

Why:

- Skills are reusable operating procedures. Installing or discovering a skill is
  different from enabling it for a specific agent/runtime invocation.
- Global/user and adapter-native skill sources may be discovered so the Agent
  Skills page can show candidates, but discovery is not runtime enablement.
- Bundled Rudder skills define built-in Rudder operations and must remain
  discoverable and available even when optional skills are disabled. Availability
  does not instruct the agent to load or use a skill on every run.
- Capability-bundled skills are distinct from that always-enabled baseline:
  they are Rudder-managed and read-only, but appear only while their owning
  instance capability is enabled.

Product model:

- Skill sources include bundled skills, organization skill library, agent home,
  global/user skill roots, and adapter-native skill directories when supported.
- The current always-enabled bundled Rudder baseline is `para-memory-files`,
  `rudder-docs`, `skill-creator`, and `visualize`. Other repo-owned skill
  packages, including `conversation-to-skill`, are not part of the default
  Rudder-resolved set unless they are introduced through a non-bundled
  selection path. The retired `skill-optimizer` package is not shipped or
  available for selection.
- `skill-creator` is the intent-triggered, self-contained workflow for creating,
  improving, evaluating, benchmarking, and packaging skills. Its bundled
  scripts, references, agents, assets, and review viewer remain part of the
  runtime skill package rather than depending on another bundled skill.
- In Rudder, skill ownership determines installation: current-agent skills live
  under `AGENT_HOME/skills` and require explicit enablement, while shared skills
  live under `RUDDER_ORG_SKILLS_DIR`, require an authorized organization Skill
  Library import, and are enabled separately for the intended agents. Global or
  provider-native discovery alone is not Rudder runtime enablement.
- Every non-bundled organization skill is an editable local installation,
  including skills imported from GitHub, skills.sh, URLs, community presets, or
  other remote sources. Remote provenance is retained for display and explicit
  update checks, but ordinary listing, editing, Chat loading, and Agent Runs
  read the installed organization copy without contacting or regenerating the
  upstream source.
- Rudder-bundled and capability-bundled skills remain read-only projections of
  their Rudder-owned source. They are the only organization-library skills that
  the server may reject as non-editable.
- `visualize` uses `CHAT.INLINE.VISUAL.001` for custom declarative Chat visuals.
  Its authoring contract is a provider-neutral Rudder message envelope, never a
  provider filesystem directory, iframe, attachment id, or provider-named
  directive. Outside a conforming Rudder Chat surface it falls back to Mermaid,
  Markdown, or prose.
- `rudder-docs` is a self-gating documentation router. It is always enabled so
  supported runtimes can discover it, but the agent should consult it only when
  the task needs Rudder product behavior, exact CLI/API details, official docs,
  source-level verification, Agent creation/configuration, or Plugin authoring.
  Its Agent and Plugin creation references are intent-routed domain workflows,
  not separate always-enabled skill identities. Its canonical selection ref is
  `bundled:rudder/rudder-docs`; legacy `rudder` refs are accepted only as input
  aliases and new output uses the canonical identity.
- Default availability, intent activation, and mutation authorization are
  separate. An explicit Rudder creation or authoring request may activate the
  relevant reference and proceed through current governed interfaces after
  verification. A documentation question, skill exposure, or body injection
  alone does not authorize an Agent, Plugin package, configuration, or host
  mutation.
- `rudder-create-agent` and `rudder-create-plugin` are retired identities with
  no selection, runtime, package, or HTTP compatibility aliases. Current
  references to either identity are missing, not redirected to `rudder-docs`.
  Historical transcript and telemetry evidence may retain the old strings.
- `Browser` is a capability-bundled skill, not part of the always-enabled
  baseline. In `local_trusted` mode it is projected for every organization when
  the instance-level Built-in Browser is enabled. It is materialized for a run
  only when the adapter is `claude_local`, `codex_local`, `opencode_local`, or
  `pi_local`, and is removed when the deployment, setting, or runtime becomes
  ineligible, without writing a durable organization or agent assignment per
  capability change.
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

1. Rudder resolves always-bundled and capability-bundled skills from current
   instance capability state.
2. Organization skill library is seeded, reconciled, and scanned. Installing or
   explicitly updating a remote skill writes its complete validated file tree
   to a stable organization-managed directory by atomic replacement. A legacy
   remote row without a local source is migrated once, under an
   organization/skill lock, before its first edit or runtime use.
   Reconciliation removes retired rows and enabled associations only when their
   stored provenance identifies them as Rudder-bundled.
3. Agent skill snapshot is built from all supported sources.
4. Desired selection is validated against available/always-enabled entries.
5. Runtime skill sync/materialization prepares the runtime-side skill surface
   from the Rudder-resolved selected, always-bundled, and active
   capability-bundled set only. It reuses each stable installed source path and
   must not redownload, delete, or reconstruct an organization skill on every
   invocation.
6. Instruction loading exposes desired/realized skill facts to the adapter.
7. Metadata-first/native hosts expose the skill description for intent matching
   before the agent reads the body or references. Prompt-injected hosts may put
   the compact `SKILL.md` body in the prompt before model judgment; on those
   hosts the body's self-gate prevents unnecessary docs lookup or skill-directed
   action.

Invariants:

- Bundled Rudder skills are not disabled by normal optional-skill toggles.
- Non-bundled organization skills are editable after installation. Ordinary
  reads and runs must preserve local edits; only an explicit update operation
  may replace the installed copy from its recorded upstream source.
- A failed install, update, or legacy migration must preserve the last complete
  local copy and must not expose a partial tree. Imported paths must remain
  inside the managed skill directory.
- The bundled `skill-creator` package must retain the resources referenced by
  its workflow, including evaluation, review, grading, compatibility, and
  packaging support; a metadata-only placeholder does not satisfy the bundled
  skill contract.
- Always-enabled or materialized means available for discovery, not selected by
  the model for every turn and not evidence that the skill was used.
- Greetings, casual conversation, unrelated coding tasks, and questions fully
  answered by current run context must not cause `rudder-docs` source lookup or
  skill-directed action. Native read state remains unknown when a provider emits
  no direct activation/read evidence; prompt injection is not reported as model
  intent matching or use.
- Explicit Agent creation/configuration and Rudder Plugin authoring requests may
  activate `rudder-docs`. Ordinary Agent field updates already served by a
  typed tool and non-Rudder Plugin work do not activate this documentation
  workflow. Advisory creation questions may activate documentation retrieval
  but do not authorize or imply a mutation.
- Persistent Cursor, OpenCode, Gemini, and Pi homes remove retired managed
  creation-skill entries only when an exact retired-source symlink or matching
  Rudder materialization provenance proves ownership. Same-named user paths,
  native provider skills, unknown links, files, and changed entries are
  preserved and reported as collisions.
- Canonical bundled/default inventories, public skill downloads, and runtime
  materialization must not expose `rudder-create-agent` or
  `rudder-create-plugin`. A non-bundled user-owned collision row may remain
  visible in the organization library, but the retired identity is not
  selectable or runtime-materialized. There is no redirect stub or output alias
  for either retired identity.
- `Browser` must be read-only and available to existing and future organizations
  only while the `local_trusted` Built-in Browser capability is instance-
  eligible. A run must also use a supported local adapter. A stale organization
  projection, run snapshot, or model fallback must not keep it usable after any
  eligibility gate changes.
- Capability projection must not create per-organization ownership of the
  instance Browser setting or Browser profile.
- Repo-owned skill packages outside the canonical bundled baseline must not be
  seeded as locked-on organization skills, counted as required bundled skills,
  or auto-loaded into runtime skill metadata merely because their source files
  remain in the repository.
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
- Organization reconciliation and run-context tests prove that `Browser` is
  projected when enabled, absent when disabled, and derived from trusted live
  instance state rather than agent-supplied config.
- Bundled docs, public route, organization refresh, persistent-adapter cleanup,
  Desktop smoke, and organization Agent Skills E2E tests prove the canonical
  `rudder-docs` inventory and retired-identity hard deletion.

## AGENT.SKILL.TELEMETRY.001

Why:

- Skill analytics can mislead product decisions if loaded or requested skills
  are counted as used skills. Runtime and Run evidence preserve the difference
  between available, requested, loaded, and actually used, while Dashboard
  usage analytics intentionally count only provider-proven `used` evidence.

Flow:

1. Runtime invocation records desired, realized, native, prompt-injected, and
   loaded skill metadata.
2. Transcript parsing or runtime result evidence records skill usage when
   provider output proves it.
3. Run-level evidence resolution uses the strongest available evidence:
   `used > promptRequested/requested > loaded`.
4. Dashboard and Agent Detail usage analytics discard every non-`used` entry.
   Their totals, per-skill counts, and labels describe only provider-proven
   skill use; requested-only and loaded-only skills do not appear in usage
   charts.
5. Analytics accept bounded date windows. The 1D preset sends exact `from` /
   `to` timestamps plus the browser timezone offset so the server attributes
   runs to the operator's local day. Multi-day presets aggregate by day across
   their selected 7D, 15D, 30D, or custom window.
6. A 1D Dashboard renders skill-use distribution as a pie chart. Multi-day
   windows render the per-day skill-use series as an area chart.

Invariants:

- Loaded is not used.
- Requested is not used.
- Dashboard usage totals and charts contain `used` evidence only. Requested and
  loaded evidence may remain inspectable on the Run surfaces that own it, but
  must not inflate usage analytics.
- Exact 1D boundaries use the operator timezone offset; a local-day run must not
  leak into an adjacent UTC day.
- Provider-specific parsing must be normalized before analytics consumption.

Evidence:

- Server skill analytics tests cover evidence hierarchy, used-only aggregation,
  and exact 1D timezone boundaries.
- Dashboard component and E2E tests cover the exclusion of requested/loaded
  evidence, 1D distribution, and multi-day area charts.
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
