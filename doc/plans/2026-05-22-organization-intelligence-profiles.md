---
title: Organization Intelligence Profiles
date: 2026-05-22
kind: proposal
status: implemented
area: agent_runtimes
entities:
  - organization_intelligence_profiles
  - model_fallback
  - organization_settings
issue:
related_plans:
  - 2026-04-28-rud-157-model-fallback.md
  - 2026-05-07-remove-copilot-default-runtime.md
supersedes: []
related_code:
  - packages/db/src/schema/organizations.ts
  - packages/shared/src/validators/organization.ts
  - server/src/services/chat-assistant.ts
  - server/src/services/runtime-kernel/model-fallback.ts
  - ui/src/components/AgentConfigForm.tsx
  - ui/src/pages/OrganizationSettings.tsx
commit_refs: []
updated_at: 2026-05-22
---

# Organization Intelligence Profiles

## Overview

Rudder needs organization-level AI configuration for product intelligence
features that are not agent work: issue AI search, chat title generation,
summaries, classification, and lightweight reranking. These calls should not be
attributed to a selected agent, should not create hidden agents, and should not
change chat's explicit selected-agent runtime contract.

Introduce two organization-scoped Intelligence profiles:

- **Fast Intelligence**: low-latency, low-cost utility calls.
- **Smart Intelligence**: reasoning-heavy utility calls that still are not
  agent work.

Both profiles use the same horizontal model fallback chain interaction already
used by agent configuration. This keeps the mental model consistent: primary
model first, then ordered fallback cards.

## What Is The Problem?

Rudder has product surfaces that need AI but do not naturally belong to an
agent identity:

- generating a better chat title from the first user message
- searching or reranking issues from a natural-language query
- summarizing a thread or issue list
- classifying short product events

Today, chat assistant execution is correctly tied to an explicit selected
agent. Reusing that mechanism for product utilities would create the wrong
identity: a product feature is not an employee in the org chart and should not
inherit a persona, skills, workspace, heartbeat state, or agent session.

The old organization-level default chat runtime was removed to eliminate hidden
Copilot-style chat behavior. This proposal preserves that decision while adding
a narrower product intelligence layer.

## What Will Be Changed?

1. Add organization-level Intelligence profiles for Fast and Smart workloads.
2. Seed the profiles after the first runtime choice is known, using safe
   provider/model defaults derived from that runtime.
3. Expose profiles in Organization Settings under an `Intelligence` section.
4. Reuse the agent config horizontal fallback-chain UI for each profile.
5. Add a product intelligence runtime service that resolves and executes
   utility calls without a persisted agent identity.
6. Keep chat assistant turns blocked unless the conversation has an explicit
   selected agent.

## Success Criteria For Change

- A new organization can receive default Fast and Smart Intelligence profiles
  after the first agent runtime is configured.
- Operators can inspect and edit both profiles in Organization Settings.
- Each profile supports an ordered model fallback chain using the familiar
  horizontal card interaction.
- Product AI utilities can resolve a profile by purpose without selecting an
  agent.
- Chat assistant replies cannot fall back to these profiles.
- Runtime failure is surfaced as a product intelligence configuration issue,
  not as an agent failure.

## Out Of Scope

- No hidden Copilot agent.
- No default chat assistant runtime.
- No automatic chat agent selection.
- No replacement for per-agent issue or heartbeat runtime configuration.
- No automatic provider health scoring.
- No project-level or user-level overrides in this iteration.

## Non-Functional Requirements

- **Security**: product utility calls must not inherit agent instructions,
  skills, workspace paths, or agent API keys.
- **Observability**: calls must be attributable to the organization, feature,
  and profile purpose.
- **Maintainability**: Fast and Smart should be purpose keys, not bespoke
  columns, so future purposes can be added without reshaping the product.
- **Usability**: the settings UI should avoid "agent runtime" language. Use
  "Intelligence profile", "Fast", "Smart", "Primary model", and "Fallbacks".

## User Experience Walkthrough

### New organization setup

1. The user creates an organization.
2. The user creates the first agent and chooses a runtime, such as Codex.
3. Rudder configures two organization Intelligence profiles from that runtime:
   Fast and Smart.
4. The user does not need to understand or approve a second agent. No new agent
   appears in the org chart.
5. If the defaults need attention, Organization Settings shows the Intelligence
   section with a repair or test state.

### Organization Settings

Organization Settings gets a new `Intelligence` section.

The overview shows two rows:

| Profile | Used for | Primary | Fallbacks | Status |
| --- | --- | --- | --- | --- |
| Fast | Titles, short summaries, classification | Codex / mini model | 1 backup | Ready |
| Smart | Issue AI search, reranking, complex summaries | Codex / stronger model | 2 backups | Ready |

Opening a row shows the same horizontal model chain interaction used in agent
config:

```text
[ Primary: Codex / GPT-5.4 Mini / Low ] [ Fallback 1 ] [ + Add fallback ]
```

For Smart:

```text
[ Primary: Codex / GPT-5.4 / Medium ] [ Fallback 1 ] [ Fallback 2 ] [ + Add fallback ]
```

Each card owns runtime/provider, model, reasoning or speed setting, and advanced
options. This should feel like the existing agent fallback editor, not a
separate settings pattern.

### Product feature usage

When the user uses AI search:

1. The user types a natural-language issue search.
2. Rudder chooses Smart Intelligence automatically.
3. If the primary model fails, configured fallbacks run in order.
4. The UI shows search results or a configuration-specific failure:
   "Smart Intelligence is not configured" or "Smart Intelligence failed."

When Rudder generates a chat title:

1. The user sends the first message.
2. Rudder chooses Fast Intelligence automatically.
3. If unavailable, Rudder keeps the existing deterministic title fallback
   instead of blocking the chat.

## Implementation

### Product Or Technical Architecture Changes

Add a product intelligence layer parallel to the agent layer:

1. **Agent Layer**
   Agents have identity, role, skills, workspace, sessions, heartbeat runs, and
   user-visible accountability.
2. **Product Intelligence Layer**
   Organization-scoped AI profiles power Rudder product features without agent
   identity.
3. **Fallback Layer**
   Both layers use the same ordered model fallback concept and UI pattern.

### Breaking Change

No user-facing breaking change is intended. Chat assistant behavior remains:
assistant turns require an explicit selected chat agent.

### Design

Use a first-class organization-scoped profile model rather than storing two
opaque JSON fields on the organization. Store profiles by purpose:

- `lightweight` backs Fast Intelligence.
- `reasoning` backs Smart Intelligence.

Runtime configuration should reuse the existing adapter config shape and model
fallback objects, but product utility invocation must filter agent-only fields
such as instruction paths, prompt templates, skills, workspace strategy, and
session/home state.

Default profile seeding should derive safe defaults from the first runtime
choice. For Codex-like runtimes, Fast should use the best available mini/fast
model and Smart should use the stronger configured model with medium reasoning.
Model ids should come from the runtime model registry or central defaults so the
UI does not freeze a stale provider-specific name.

### Security

This change adds organization-level runtime configuration and product utility
execution. It must not introduce hidden agent credentials or reuse agent API
tokens. Secret references remain organization-scoped and are resolved through
the existing secret path before runtime execution.

## What Is Your Testing Plan (QA)?

### Goal

Prove that organization Intelligence profiles are isolated from agent identity,
support fallback chains, and can be managed safely.

### Prerequisites

- A local dev organization.
- At least one configured runtime adapter, ideally Codex local for the first
  default path.

### Test Scenarios / Cases

- New organization or first-agent setup seeds Fast and Smart profiles.
- Existing organizations without profiles expose a clear unconfigured state.
- Updating a profile persists primary model and fallback cards.
- Product utility profile resolution is organization-scoped.
- Chat assistant still rejects conversations with no preferred agent.
- Fallback execution order is preserved.
- Agent-only config fields are not inherited by product utility execution.

### Expected Results

- Fast and Smart are visible in Organization Settings.
- The horizontal fallback chain behaves consistently with agent config.
- Product utilities can use Fast or Smart without creating agent rows or
  heartbeat runs.
- Chat assistant never uses Fast or Smart as a reply runtime.

### Pass / Fail

Implemented for profile storage, default seeding, organization settings
management, fallback-chain editing, validation, agent-only config
sanitization, and product intelligence runtime execution. Direct product
utility feature endpoints remain out of this slice; future AI search or
title-generation work should consume the product intelligence service by
purpose instead of selecting a hidden agent.

## Documentation Changes

- Update `doc/SPEC-implementation.md` with the organization Intelligence
  profile contract.
- Update internal development docs only if new routes or verification commands
  require contributor guidance.

## Open Issues

- Final model-id defaults should be chosen from currently supported runtime
  model lists rather than from a hardcoded screenshot.
- The first visible utility may be chat title generation, issue AI search, or a
  test-only endpoint. The profile foundation should not depend on one feature.
