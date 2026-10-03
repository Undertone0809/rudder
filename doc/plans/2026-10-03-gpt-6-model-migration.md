---
title: GPT-6 model migration for Rudder
date: 2026-10-03
kind: proposal
status: proposed
area: agent_runtimes
entities:
  - organization_intelligence_profiles
  - model_fallback
  - chat_runtime
related_plans:
  - 2026-05-22-organization-intelligence-profiles.md
  - 2026-07-23-chat-conversation-model-selector.md
supersedes: []
related_code:
  - packages/agent-runtimes/codex-local/src/defaults.ts
  - packages/agent-runtimes/codex-local/src/index.ts
  - packages/agent-runtimes/codex-local/src/server/cost.ts
  - server/src/agent-runtimes/codex-models.ts
  - server/src/services/organization-intelligence-profile-defaults.ts
  - ui/src/lib/runtime-thinking-effort.ts
commit_refs: []
updated_at: 2026-10-03
---

# GPT-6 Model Migration for Rudder

## Overview

Adopt GPT-6 through Rudder's existing runtime adapters. Recommend `gpt-6-luna`
as the successor to the current economical default, retaining Medium reasoning
as the first evaluation baseline. Offer `gpt-6.1-sol` for complex work and
`gpt-6-astra` for the hardest reasoning and review tasks. These are proposed
workload choices, subject to access checks and representative evaluations.

This document plans the migration; it does not change runtime settings or data.

## What Is The Problem?

The original checkout was `cb71b391f`; the proposal was reconciled against
current remote main `feeeff71b` on 2026-10-03. Current behavior:

- `codex-local/src/defaults.ts` selects `gpt-5.6-luna` with `medium` effort.
- The static catalog and reasoning matrix in `codex-local/src/index.ts` cover
  GPT-5.6 and earlier models. The server prefers `codex debug models` discovery
  and falls back to that static catalog when discovery is empty or fails.
- Organization intelligence already uses `gpt-6-luna` through the separate
  shared constant `DEFAULT_ORGANIZATION_INTELLIGENCE_CODEX_MODEL`. Its migration
  preserves effort, disables changed profiles, and invalidates verification.
  This completed migration should be retained and regression-tested.
- Execution sends model and effort through Codex exec or app-server
  `turn/start`; Rudder is not implementing a direct OpenAI inference client here.
- The subscription cost estimator has neither GPT-5.6 nor GPT-6 prices.
  Unknown models return no estimate, so a model-only upgrade would leave a
  material gap in spend visibility and budget enforcement.

Repository code confirms the organization default separation; production account
configuration and runtime availability have not been inspected.

## What Will Be Changed?

| Workload | Proposed model | Initial effort |
| --- | --- | --- |
| New ordinary Codex agents | `gpt-6-luna` | Existing effective effort; `medium` when omitted |
| Organization intelligence (already migrated; preserve) | `gpt-6-luna` | Existing configured effort |
| Operator-selected complex coding and analysis | `gpt-6.1-sol` | Preserve supported configured effort |
| Operator-selected hardest reasoning and critical review | `gpt-6-astra` | Preserve supported configured effort |

Add supported models and reasoning metadata, verified cost accounting, focused
regression coverage, and updated configuration documentation. Switch omitted
defaults only after those prerequisites pass. Keep explicit existing model
choices and ordered fallbacks intact. Do not introduce automatic escalation.

## Success Criteria For Change

1. Every promoted model is available through the actual supported Codex runtime,
   auth method, and provider configuration used by the target environment.
2. Model and effort selection survives creation, persistence, execution,
   continuation, and transcript readback without silently substituting a model.
3. Explicit pins, chat/issue/goal overrides, and fallback order remain stable.
4. GPT-6 spend estimates work for subscription usage and budget hard stops still
   apply. Estimated spend remains distinguishable from provider-billed cost.
5. A fixed evaluation set has no critical safety, isolation, persistence, or
   cancellation regression, and meets workload-specific quality, cost, and
   latency limits agreed before evaluation.

## Out Of Scope

Direct OpenAI SDK adoption, other providers' model catalogs, prompt redesign,
Pro/fast modes, new delegation features, historical transcript rewrites,
bulk account migrations, release, and production deployment.
The completed organization default migration is outside new implementation
scope; preserve its behavior and add regression coverage only where needed.

## Non-Functional Requirements

Preserve organization isolation, approval gates, cancellation semantics, and
budget hard stops. Record actual runtime/model/effort identity and price source
date. Keep catalog discovery authoritative; fallback entries advertise known
capabilities, not proof of account access. Do not globally raise effort to Max.

## User Experience Walkthrough

The operator creates a Codex agent with the proposed Luna default, or selects
Sol/Astra and a runtime-supported effort. The operator tests the runtime chain,
then runs a Chat or issue task and inspects its model, result, usage, and cost.
Existing pinned agents continue using their saved settings. Any changed
organization profile requires a fresh successful runtime-chain test before
being enabled again.

For changed selectors, inventory the current choice, model and effort controls,
runtime availability context, Save/Test action, and Cancel/reopen behavior before
implementation. Keep unsupported efforts unavailable and saved choices visible.

## Implementation

### Product Or Technical Architecture Changes

Retain the current adapter boundary. OpenAI's API guide recommends Responses
for reasoning with tools, but this project delegates that protocol to Codex.
Verify the installed runtime/provider supports the required workflow before
assuming that an API model ID is usable in Codex.

### Breaking Change

No schema change is presently required. New omitted defaults may change;
explicit saved configurations must not change automatically. Existing profile
aliases need careful provenance handling because an old default string may also
be an intentional user pin.

### Design

**Phase 1: Inventory and compatibility.** Rebase/reconcile the implementation
branch with current main, then inventory fresh defaults, persisted agent and
organization settings, per-task overrides, fallback chains, and active sessions.
Read model/effort capabilities using the exact configured Codex command and
managed environment. Establish supported CLI versions, account access, gateway
compatibility, and whether model changes require a new session. Preserve active
sessions until that behavior is verified. Deliver a compatibility matrix.

**Phase 2: Capability and accounting support.** Update the Codex static catalog,
effort matrix, configuration help, and their UI consumers. Preserve legacy
exports if callers depend on them. Test discovered metadata, empty discovery,
timeout, and fallback behavior. Check official pricing for the actual processing
tier before adding GPT-6 estimates to `cost.ts`; audit cache-write and reasoning
token reporting so unsupported usage is not silently counted as free. If usage
cannot be priced faithfully, block default promotion and document the exact gap.

**Phase 3: Defaults and persisted settings.** Change new/omitted Codex defaults
to Luna/Medium. Preserve organization intelligence's already separate Luna default and migration. Do not bulk replace
`gpt-5.6-luna` in stored configurations: existing creation code materializes
defaults, so string equality alone cannot establish user intent. Offer explicit
opt-in migration for ambiguous saved settings. Any profile changed by an approved
migration must retain supported effort, clear `lastVerifiedAt`, become disabled,
and require a fresh runtime-chain test. Make migration idempotent and auditable.

**Phase 4: Evaluation and canary.** Keep prompts and tool contracts unchanged
for the first comparison. Compare current Luna with GPT-6 Luna at the same effort;
evaluate Sol/Astra on difficult tasks. Use repeatable Chat, issue/MCP tool,
structured proposal, organization intelligence, and long-session workloads.
Measure success, latency, input/output/reasoning/cache tokens, and cost per
successful task. Canary in a disposable organization before broad promotion.

**Phase 5: Acceptance and publication.** Resolve independent stage review,
freeze candidate/build/runtime/data identities, obtain black-box verifier PASS,
then obtain final reviewer acceptance for the same content. Publish the scoped
implementation PR only after those gates; merge and release remain separate.

**Rollback.** Retain old catalog entries and explicit fallbacks. Restore the
previous omitted defaults and each canary's recorded settings; invalidate
verification for restored profiles and retest. Do not delete sessions or user
data, or silently rewrite fallback chains during rollback.

## What Is Your Testing Plan (QA)?

### Goal

Prove a real work loop completes with the selected GPT-6 model while preserving
stored choices, budgets, and runtime continuity.

### Prerequisites

A disposable organization, available target models, working Codex auth, exact
runtime/build identity, representative tasks, and verified pricing/usage fields.
Choose numeric latency and cost limits before collecting evaluation results.

### Test Scenarios / Cases

- Focused default, profile migration, discovery, effort selector, app-server,
  exec, and cost tests; include custom pins and unsupported model/effort pairs.
- Extend existing model-selector E2Es such as `codex-model-order.spec.ts` and
  `issue-runtime-model-selector.spec.ts`; verify save/reopen and override behavior.
- Real Chat and issue runs with MCP tools, streamed transcript, continuation,
  cancellation, fallback on model unavailability, and one long-session case.
- Multi-organization profile isolation, failed runtime-chain verification,
  repeated migration, and a budget-crossing run with cached-token usage.
- Run `pnpm lint`, `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`, and relevant
  E2Es for the cross-package implementation. Run `pnpm desktop:verify` if packaged
  startup, migration, profile routing, or installed behavior is affected.
- Inspect changed selectors in the real shell/browser and include final
  screenshots in the implementation handoff.

### Expected Results

The reported model/effort matches execution, settings persist, unsupported
configurations fail clearly, gates and budget stops hold, and evaluation
thresholds pass. Mocked E2Es do not replace real-runtime model acceptance.

### Pass / Fail

Not executed: this is a planning artifact. No model request, migration, runtime
change, or product acceptance claim has been made.

## Documentation Changes

Update adapter configuration help, affected public setup examples, and relevant
contributor model-selection guidance after implementation. Preserve historical
fixtures and evaluation baselines. Synchronize bundled skills and references only
where their active model guidance changes.

## Open Issues

- Exact Codex versions, model/effort availability, and account access remain
  unverified in the target runtime.
- Persisted defaults may be indistinguishable from deliberate pins.
- Current price/usage coverage must be verified before default promotion.
- Workload latency/cost limits need to be set before the canary comparison.

## Official Sources

Checked 2026-10-03. Official sources describe Astra as the highest intelligence
option, Sol as balanced, and Luna as focused and economical. They recommend
preserving effective effort, using Responses for reasoning with tools, and
evaluating task success, token usage, latency, and cost before promotion.

- [Using GPT-6](https://developers.openai.com/api/docs/guides/latest-model)
- [GPT-6 migration quickstart](https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md#migration-quickstart)
- [API deployment checklist](https://developers.openai.com/api/docs/guides/deployment-checklist)
