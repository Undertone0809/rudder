---
title: Agent Identity And Config
domain: agents
status: active
coverage: detailed
contract_ids:
  - AGENT.IDENTITY.CONFIG.001
  - AGENT.RUNTIME.ADAPTERS.001
related_code:
  - packages/agent-runtime-utils/src/rudder-mcp.ts
  - packages/agent-runtimes/codex-local/src/index.ts
  - packages/agent-runtimes/claude-local/src/server/execute.ts
  - packages/agent-runtimes/codex-local/src/server/execute.ts
  - packages/agent-runtimes/opencode-local/src/server/execute.ts
  - packages/agent-runtimes/pi-local/src/server/execute.ts
  - packages/db/src/schema/agents.ts
  - packages/shared/src/constants.ts
  - packages/shared/src/types/agent.ts
  - packages/shared/src/validators/agent.ts
  - server/src/agent-runtimes/codex-models.ts
  - server/src/services/agents.ts
  - server/src/routes/agents.ts
  - server/src/routes/agents.management-routes.ts
  - server/src/routes/llms.ts
  - server/resources/bundled-skills/rudder-docs/references/agent-creation.md
  - server/src/agent-runtimes/registry.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - ui/src/components/AgentConfigForm.environment.tsx
  - ui/src/components/AgentConfigForm.helpers.tsx
  - ui/src/components/AgentAvatar.tsx
  - ui/src/components/AgentIconPicker.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/lib/agent-avatar.ts
  - ui/src/lib/runtime-models.ts
  - ui/src/lib/runtime-thinking-effort.ts
related_tests:
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/opencode-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
  - server/src/__tests__/adapter-models.test.ts
  - server/src/__tests__/agent-permissions-routes.test.ts
  - server/src/__tests__/agent-shortname-collision.test.ts
  - server/src/__tests__/agent-skills-routes.test.ts
  - server/src/__tests__/agent-startup-context.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - ui/src/components/agent-config-defaults.test.ts
  - ui/src/components/AgentAvatar.test.tsx
  - ui/src/components/AgentIconPicker.test.tsx
  - ui/src/components/AgentConfigForm.helpers.test.ts
  - ui/src/components/AgentConfigForm.model-dropdown.test.tsx
  - ui/src/components/OnboardingWizard.runtime-config.test.tsx
  - ui/src/lib/runtime-models.test.ts
  - tests/e2e/agent-config-advanced-options.spec.ts
  - tests/e2e/agent-avatar.spec.ts
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/onboarding.spec.ts
  - server/src/__tests__/bundled-rudder-skill-docs.test.ts
related_plans:
  - doc/plans/2026-07-20-oreo-agent-avatar-style.md
  - doc/plans/2026-07-20-merge-rudder-creation-skills-into-docs.md
edit_policy: user_confirmed_only
---

# Agent Identity And Config

## AGENT.IDENTITY.CONFIG.001

Why:

- Agents are durable team members, not throwaway runtime processes. Their role,
  capabilities, runtime, skills, budget, reporting line, and permissions define
  what work Rudder may safely route to them.

Product model:

- An agent belongs to one organization.
- Agent identity includes name, role, title, capabilities, status, reporting
  line, runtime type/config, desired skills, budget, and permission/config
  state.
- Agent avatar identity uses the existing `agents.icon` field. Supported
  persisted generated references are deterministic Oreo
  `oreo:<shape>:<palette>:<uuid>` values and DiceBear Notionists values;
  uploaded `asset:<uuid>` references remain supported.
- New direct-created and hired agents default to a server-generated Oreo
  reference when `icon` is omitted or a legacy named icon is supplied. The
  persisted UUID is Oreo's stable variant identity across refreshes, restarts,
  and every shared avatar rendering surface.
- Existing agents are not migrated. Persisted Oreo, DiceBear, uploaded-image,
  legacy named-icon, and missing-icon display behavior remains intact.
- Agent Detail exposes a compact Oreo/DiceBear avatar picker. Oreo provides its
  six shapes, 40 palettes, and style-scoped Random; DiceBear retains
  Notionists Random and six background presets; image upload is shared across
  both tabs.
- Pending approval, paused, terminated, or revoked-access states constrain
  whether the agent can be woken or configured.
- Config changes are operator-visible product changes when they alter runtime,
  instruction, skill, budget, or permission behavior.

Flow:

1. Board creates or hires an agent with role and runtime configuration.
2. Server normalizes runtime config, secrets, avatar identity, default
   instructions, and desired skills. A valid explicit generated/uploaded
   avatar is preserved; an omitted or incoming legacy named icon becomes a new
   Oreo default reference.
3. Approval or permission policy may gate the final active state.
4. Updates create visible config state so later runs can be traced back to the
   operating frame active at invocation time.
5. Agent Detail exposes config, instructions, skills, integrations, runs, and
   issues from the same durable identity.

Invariants:

- Agent identity and manager relationships do not cross organization boundary.
- Terminated or pending-approval agents are not ordinary invokable agents.
- Runtime config is not only UI preference; it is execution contract.
- Oreo shape, palette, and UUID segments must match the IDs and UUID grammar
  tied to the pinned renderer version. Unknown or malformed Oreo references
  are rejected at the API boundary.
- Random changes only the active generated style. Selecting or randomizing an
  avatar persists the complete reference; rendering never substitutes a new
  variant for an existing valid reference.
- Avatar upload continues to enforce organization ownership, compression, and
  activity-log behavior independently of the generated style picker.

Evidence:

- Agent management routes enforce org-scoped updates.
- Agent Detail shows the config surface used by operators to inspect an agent.
- Shared validation, server creation tests, renderer/picker component tests,
  and the Agent avatar E2E workflow prove strict references, Oreo defaults,
  cross-style persistence, refresh stability, upload compatibility, and mobile
  viewport containment.
- Runtime execution stores enough context to reconstruct the agent's operating
  frame for a run.
- The bundled `rudder-docs` Agent creation reference routes explicit creation
  requests through the existing identity, `canCreateAgents`, runtime discovery,
  role enum, reporting-line, `SOUL.md`, source-issue, canonical hire,
  direct-create, `pending_approval`, revision, and success-evidence semantics.

## AGENT.RUNTIME.ADAPTERS.001

Why:

- Runtime type is a product capability boundary. Codex, Claude, Gemini,
  OpenCode, Pi, Cursor, process, and HTTP-style adapters do not all support the
  same session, skill sync, model discovery, local JWT, transcript, or quota
  behaviors.

Product model:

- The runtime registry maps an agent runtime type to adapter capabilities.
- Adapter capabilities can include execute, test environment, model listing,
  skill listing/sync, local auth token support, session codec, transcript
  parser, quota/cost metadata, and managed MCP/native Rudder tool
  projection.
- Interactive chat capabilities are attempt-scoped. An active adapter may
  register a fenced control handle that declares native or fallback Steer and
  interrupt behavior; the capability disappears when that attempt releases
  ownership.
- Codex chat uses Codex App Server for native `turn/steer` and
  `turn/interrupt`. Adapters without native mid-turn control must report the
  interrupt-and-continue fallback honestly rather than exposing a false native
  Steer acknowledgement.
- Built-in Browser control is a Desktop `local_trusted` capability in V1.
  Codex, Claude, and OpenCode may receive it through Rudder-managed MCP config;
  Pi may receive the equivalent managed native extension. Remote runtimes and
  adapters without an authenticated managed tool path must report it as
  unavailable instead of receiving a false Browser capability.
- Runtime execution must pass a bounded Rudder context to the adapter and then
  persist normalized result evidence back into Rudder.
- Runtime-neutral Chat inline visuals are a versioned Rudder Chat orchestration
  capability under `CHAT.INLINE.VISUAL.001`, not an adapter-specific opt-in.
  Every runtime registered for Chat receives the same common prompt projection
  of the always-enabled `visualize` policy and the same protocol version in its
  execution context. Native skill-directory projection is additive, not a
  prerequisite. Runtime transport tests must prove the complete prompt and
  final result are preserved; the common Chat admission path owns arbitrary
  chunk, streaming, Stop/failure, size-limit, and no-source-leak conformance for
  every registered runtime.
- Agent configuration exposes only operator-facing runtime choices in the
  runtime selector. Low-level adapter types such as generic process and HTTP
  remain internal/advanced plumbing and must not appear as ordinary runtime
  picker options unless they become intentionally supported product choices.
- Rudder may probe local runtime CLI availability for operator-facing local
  adapters. Availability is advisory setup guidance, not execution authority:
  available means the default CLI command resolved on the server PATH,
  unavailable means the default command was not found, and unknown means the
  adapter does not use a local CLI command probe.
- Codex uses a Rudder-curated, Codex-app-aligned model menu rather than dynamic
  OpenAI model discovery. The current ordered menu is `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and
  `gpt-5.2`; discovered OpenAI models do not augment or reorder it. Explicit
  custom model values may still be preserved where the editor supports them.
- New Codex agent configurations default to `gpt-5.6-sol`, including the
  onboarding and standard agent-creation surfaces.
- Codex thinking effort is model-family-specific. The GPT-5.6 Codex variants
  offer Light, Medium, High, Extra High, Max, and Ultra; the remaining curated
  Codex models offer Low, Medium, High, and Extra High. Switching models clears
  an effort value that the new model does not support, including primary,
  fallback, and New Issue override surfaces.
- Runtime environment test results are tri-state operator evidence: `pass` is
  ready, `warn` is visible setup guidance, and `fail` is a failed probe. Warning
  checks must remain visible instead of being hidden or normalized to a pass.

Flow:

1. Agent config loads the operator-facing runtime choices, the runtime-owned
   model catalog, and, when available, server-side CLI probe status.
2. The runtime selector groups choices by setup state so the operator can see
   ready local runtimes, runtimes needing setup, and non-probed runtimes before
   choosing.
3. Agent config selects a runtime type and config payload.
4. Registry resolves the adapter and capability surface.
5. For a supported local adapter, Rudder derives conditional Browser skill/tool
   availability from trusted instance/run context after user environment merge,
   so agent config cannot force-enable or retain it after disablement.
6. Runtime config is prepared, secrets are resolved, skills/context are loaded,
   and execution workspace is realized.
7. For an interactive chat attempt, the adapter registers its control handle
   only after the provider turn identity is known. Rudder fences every control
   call to that attempt and unregisters the handle on terminal release.
8. Adapter executes and returns provider-specific result/transcript/session
   evidence.
9. Rudder normalizes and stores the result under `RUN.RESULT.001`.

Invariants:

- Adapter-specific affordances must not be assumed for all providers.
- Native Steer success means the provider acknowledged the same active turn; it
  does not claim that the model obeyed the feedback. Unknown receipt must remain
  explicit and must not be converted into a duplicate fallback continuation.
- Stop must freeze Rudder-visible output independently of how quickly or
  reliably the provider interrupt completes.
- Provider parity claims require runtime-specific evidence or a documented
  blocked/substituted proof.
- Future plugin runtimes must declare and pass the public inline-visual protocol
  conformance version before Rudder reports the capability; provider-specific
  filesystem capture is compatibility input, not parity evidence.
- Runtime availability groups must not silently disable a supported adapter.
  Missing default CLI commands should be shown with setup guidance while still
  allowing custom command configuration and runtime-chain testing where the
  adapter supports it.
- Runtime picker grouping must not expose internal generic process/HTTP adapter
  types as first-class operator choices.
- Codex model discovery must not turn the fixed Codex menu into an account- or
  API-key-dependent list. Catalog changes are deliberate product updates.
- A warning-only environment result must remain distinguishable from both pass
  and fail while leaving supported configuration and recovery actions visible.
- Runtime adapters must not expose Browser tools from inherited user MCP config
  or an agent-supplied enable flag. Managed projection is conditional, and live
  authorization remains enforced by `AGENT.BROWSER.001`.
- Browser parity is not implied across remote, generic process/HTTP, or
  unsupported adapters. They must expose an honest unavailable state or CLI
  fallback only when local trusted command execution preserves the same
  identity boundary.

Evidence:

- Runtime registry is the source of adapter capabilities.
- Runtime execution tests prove context assembly and result persistence.
- Runtime availability tests cover default CLI command probing, non-probed
  adapter status, and hiding internal process/HTTP adapter choices.
- Agent configuration E2E covers runtime choices grouped by readiness, missing
  default CLI labels, visible warning guidance, model-family effort choices,
  fixed Codex model ordering, and hidden process/HTTP entries.
- Adapter model tests prove Codex ignores discovered OpenAI models and returns
  the curated menu in its declared order.
- Codex, Claude, OpenCode, and Pi execute tests cover managed Browser capability
  propagation and prove the eight Browser tools are absent when disabled.
- Codex App Server tests cover bidirectional request handling, native
  `turn/steer`, native `turn/interrupt`, disconnect ambiguity, and fallback
  process termination. Chat protocol tests cover attempt ownership and stale
  handle rejection.
