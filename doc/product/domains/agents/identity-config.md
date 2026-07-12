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
  - packages/shared/src/types/agent.ts
  - server/src/agent-runtimes/codex-models.ts
  - server/src/services/agents.ts
  - server/src/routes/agents.ts
  - server/src/routes/agents.management-routes.ts
  - server/src/agent-runtimes/registry.ts
  - server/src/services/runtime-kernel/heartbeat.execute.ts
  - ui/src/components/AgentConfigForm.environment.tsx
  - ui/src/components/AgentConfigForm.helpers.tsx
  - ui/src/components/NewIssueDialog.tsx
  - ui/src/lib/runtime-models.ts
  - ui/src/lib/runtime-thinking-effort.ts
related_tests:
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/opencode-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
  - server/src/__tests__/adapter-models.test.ts
  - server/src/__tests__/agent-permissions-routes.test.ts
  - server/src/__tests__/agent-startup-context.test.ts
  - server/src/__tests__/agent-run-context.test.ts
  - ui/src/components/agent-config-defaults.test.ts
  - ui/src/components/AgentConfigForm.helpers.test.ts
  - ui/src/components/AgentConfigForm.model-dropdown.test.tsx
  - ui/src/components/OnboardingWizard.runtime-config.test.tsx
  - ui/src/lib/runtime-models.test.ts
  - tests/e2e/agent-config-advanced-options.spec.ts
  - tests/e2e/codex-model-order.spec.ts
  - tests/e2e/onboarding.spec.ts
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
- Pending approval, paused, terminated, or revoked-access states constrain
  whether the agent can be woken or configured.
- Config changes are operator-visible product changes when they alter runtime,
  instruction, skill, budget, or permission behavior.

Flow:

1. Board creates or hires an agent with role and runtime configuration.
2. Server normalizes runtime config, secrets, default instructions, and desired
   skills.
3. Approval or permission policy may gate the final active state.
4. Updates create visible config state so later runs can be traced back to the
   operating frame active at invocation time.
5. Agent Detail exposes config, instructions, skills, integrations, runs, and
   issues from the same durable identity.

Invariants:

- Agent identity and manager relationships do not cross organization boundary.
- Terminated or pending-approval agents are not ordinary invokable agents.
- Runtime config is not only UI preference; it is execution contract.

Evidence:

- Agent management routes enforce org-scoped updates.
- Agent Detail shows the config surface used by operators to inspect an agent.
- Runtime execution stores enough context to reconstruct the agent's operating
  frame for a run.

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
  parser, quota/cost metadata, and managed MCP/native control-plane tool
  projection.
- Built-in Browser control is a Desktop `local_trusted` capability in V1.
  Codex, Claude, and OpenCode may receive it through Rudder-managed MCP config;
  Pi may receive the equivalent managed native extension. Remote runtimes and
  adapters without an authenticated managed tool path must report it as
  unavailable instead of receiving a false Browser capability.
- Runtime execution must pass a bounded Rudder context to the adapter and then
  persist normalized result evidence back into Rudder.
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
7. Adapter executes and returns provider-specific result/transcript/session
   evidence.
8. Rudder normalizes and stores the result under `RUN.RESULT.001`.

Invariants:

- Adapter-specific affordances must not be assumed for all providers.
- Provider parity claims require runtime-specific evidence or a documented
  blocked/substituted proof.
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
