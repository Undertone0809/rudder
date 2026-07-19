---
title: Merge Agent and Plugin creation workflows into Rudder Docs
date: 2026-07-20
kind: implementation
status: completed
area: skills
entities:
  - rudder_docs
  - bundled_skills
  - organization_skills
  - runtime_skill_materialization
issue:
related_plans:
  - 2026-07-18-rudder-docs-skill-proposal.md
supersedes: []
related_code:
  - server/resources/bundled-skills/rudder-docs/SKILL.md
  - server/resources/bundled-skills/rudder-docs/references/agent-creation.md
  - server/resources/bundled-skills/rudder-docs/references/plugin-authoring.md
  - packages/shared/src/organization-skill-reference.ts
  - packages/agent-runtime-utils/src/server-utils.cli.ts
  - server/src/services/knowledge-portability/organization-skills.ts
  - server/src/routes/access.ts
  - server/src/routes/access.helpers.ts
  - doc/product/domains/agents/skills-and-inbox.md
  - doc/product/domains/agents/identity-config.md
  - doc/product/domains/plugins/lifecycle-capabilities.md
  - doc/product/registry.yml
commit_refs:
  - "feat: merge Rudder creation workflows into docs"
updated_at: 2026-07-20
---

# Merge Agent And Plugin Creation Workflows Into Rudder Docs

## Summary

Consolidate the useful Agent creation and Plugin authoring workflows from the
bundled `rudder-create-agent` and `rudder-create-plugin` skills into the
canonical `rudder-docs` skill. Delete both retired skill identities from the
bundled catalog, public skill routes, organization inventories, runtime
materialization, and current fixtures without adding compatibility aliases or
redirect packages.

`rudder-docs` remains selected and discoverable by default but self-gates by
intent. Greetings, unrelated coding work, and routine typed-tool actions do not
start documentation retrieval. Questions about Rudder behavior and explicit
requests to create or configure a Rudder Agent or author a Rudder Plugin do.
Documentation lookup alone never authorizes mutation; an explicit creation
request may proceed through the existing governed interface after the agent
verifies the current capability or command contract.

## Problem

Rudder currently exposes three overlapping bundled identities:

- `rudder-docs` routes current Rudder documentation and source evidence;
- `rudder-create-agent` owns the governed Agent hiring workflow; and
- `rudder-create-plugin` owns Plugin scaffolding and authoring guidance.

The split makes creation guidance harder to discover from the main Rudder
documentation entry point, adds two always-enabled identities to every new
organization, and allows the separate Agent skill to match more broadly than
the user's intent. It also duplicates CLI and API material that already has a
canonical home under `rudder-docs/references/`.

The desired end state is one documentation and self-knowledge router with
domain references for creation workflows. The two old identities are retired
as a deliberate breaking migration. Historical records may retain their old
names, but current selection, download, materialization, and enablement must not
resolve them.

## Scope

### In scope

- Extend the `rudder-docs` trigger description and router for explicit Agent
  creation/configuration and Plugin authoring requests.
- Add focused `agent-creation.md` and `plugin-authoring.md` workflow references.
- Keep detailed CLI command and HTTP route shapes in their existing central
  references.
- Delete both old bundled packages and remove their current identities from
  shared catalogs, public routes, Desktop requirements, organization seeds,
  runtime snapshots, UI fixtures, and active benchmark fixtures.
- Prune stale organization rows only when their provenance identifies them as
  Rudder-bundled skills.
- Safely remove retired managed runtime entries for Cursor, OpenCode, Gemini,
  and Pi while preserving collisions and user-owned entries.
- Update current Product Logic contracts and registry traceability.
- Update static, integration, E2E, trigger-evaluation, scaffold, and real-host
  verification coverage.

### Out of scope

- New Agent-hire MCP tools or Plugin scaffold services.
- New database schema, API payloads, Plugin capabilities, or runtime lifecycle
  behavior.
- A `skill_view` feature or new telemetry semantics.
- Rewriting historical transcripts, analytics, release notes, or archived
  plans that mention a retired identity.
- Changing `skill-creator`, `para-memory-files`, `visualize`, or the
  capability-gated `browser` skill.
- Removing the separately established legacy `rudder` input alias for
  `rudder-docs`; the hard-delete policy in this plan applies only to the two
  creation skill identities.

## Affected Product Logic Contracts

- `AGENT.SKILLS.001`: remove the two retired skills from the always-enabled
  baseline, add creation and authoring responsibilities to `rudder-docs`, and
  distinguish availability, intent activation, and mutation authorization.
- `AGENT.IDENTITY.CONFIG.001`: add traceability from the current governed hire
  behavior to `references/agent-creation.md` without changing permissions,
  approval, reporting-line, or runtime configuration semantics.
- `AGENT.CONTROL.TOOLS.001`: retain the CLI compatibility contract and add
  traceability only if the new Agent workflow depends on its command catalog.
- `PLUGIN.LIFECYCLE.001`, `PLUGIN.CAPABILITY.001`, and
  `PLUGIN.JOBS.WEBHOOKS.001`: add authoring-reference traceability without
  changing trusted-code, lifecycle, capability, job, webhook, or route
  behavior.

## Implementation Plan

### 1. Establish regression tests before production edits

Add failing assertions for the intended canonical inventory and hard-delete
behavior:

- the shared bundled list contains `rudder-docs` but neither retired slug;
- the public index is canonical-only and both retired download URLs return
  `404`;
- explicit retired selection references remain unresolved and never map to
  `rudder-docs`;
- stale bundled organization rows and enabled associations are pruned;
- same-named user or unknown runtime entries are preserved and reported;
- managed retired symlinks and provenance-marked materialized directories are
  removed after type, inode, target, and provenance revalidation;
- the two retired package directories no longer exist; and
- the unified skill links both new references and preserves its gating
  contract.

Run each focused test before implementation and confirm that it fails for the
expected missing behavior.

### 2. Add unified workflow references

Extend the `rudder-docs` description to cover Rudder Agent creation, hiring,
and configuration plus Rudder Plugin scaffolding, development, and
verification. Keep it between 50 and 100 words, below 1,024 characters, and
retain explicit exclusions for greetings, unrelated work, and routine actions
already served by typed tools and active context.

Add an explicit creation/authoring request class to the main router:

- Agent creation or configuration loads `references/agent-creation.md`;
- Plugin scaffolding or authoring loads `references/plugin-authoring.md`; and
- only an explicit user request to perform the action enters a mutation path.

The Agent reference will own the domain workflow: actor identity,
organization, `canCreateAgents`, runtime configuration discovery, comparison
with existing Agents, required skill checks, role enum, title, reporting line,
SOUL/prompt template, source issue, canonical `rudder agent hire`, direct
creation, `pending_approval`, revision/resubmission, and success evidence.

The Plugin reference will own authoring decisions: repository-local versus
external package layout, `create-rudder-plugin` scaffolding, manifest, worker,
UI, capabilities, route boundaries, optional bundled-example host wiring, and
package plus host verification. Current engineering documentation and SDK
source remain authoritative for exact details.

Update the control-plane and organization-skill references so they route to
these unified workflows instead of naming a retired skill. Do not copy command
catalogs or route-shape tables into the new domain references.

### 3. Hard-delete retired bundled identities

Remove `rudder-create-agent` and `rudder-create-plugin` from the shared bundled
baseline and all generated or asserted current inventories. Delete their
package directories and independent references. Remove the Agent entry from
the public skill index and remove both download handlers so each old URL
returns `404`.

Do not add selection aliases, runtime aliases, redirect stubs, HTTP redirects,
or fallback mappings. New organizations and runtime outputs contain only
`rudder-docs`. Explicit old selection references resolve as missing.

Keep historical telemetry, transcripts, release notes, benchmark workflow
names, and archived documents unchanged when they are evidence rather than
active configuration.

### 4. Reconcile organization and runtime state safely

Rely on organization inventory reconciliation to prune exact stale rows whose
source provenance is `rudder_bundled` or the supported legacy bundled source,
including their enabled associations. Never remove user-imported rows that only
share a retired slug.

Extend persistent runtime cleanup for Cursor, OpenCode, Gemini, and Pi:

- derive the exact retired source path from the selected managed Rudder source;
- inspect the candidate without following an unsafe path;
- remove only an exact retired-source symlink or a materialized directory whose
  Rudder provenance records that same source;
- re-check candidate type, inode, symlink target, and provenance immediately
  before deletion; and
- preserve and report ordinary files, user directories, native provider
  skills, unknown symlinks, or any changed/colliding entry.

Codex continues to use full managed-home reconciliation. Claude's ephemeral
projection does not require a persistent migration.

### 5. Synchronize supporting surfaces and contracts

Update Desktop smoke requirements, Agent Skills UI/E2E expectations, runtime
snapshots, and current test fixtures to the reduced canonical set. Update the
create-Agent benchmark's path detection and desired skill fixture to point at
`rudder-docs`, while preserving `rudder-create-agent-benchmark` as a workflow
marker.

Synchronize the authorized Product Logic contracts and registry entries listed
above. Describe the retired skill identities as intentionally unsupported and
record that default availability is not intent activation and neither state is
mutation authorization.

### 6. Evaluate routing and real workflows

Maintain a 20-query bilingual trigger set with 10 positive and 10 negative
examples. Positive examples cover Agent hiring/configuration and Plugin
scaffolding/source questions. Near misses cover ordinary Agent title updates,
non-Rudder plugins, routine typed actions, greetings, and unrelated repository
work. Run a 60/40 train/held-out evaluation with three trials per query and
generate the static evaluation viewer.

Exercise the real user-visible workflows:

- Codex greeting: no `rudder-docs` source read;
- explicit Agent creation: read `agent-creation.md`, verify the live interface,
  and exercise direct or approval-required behavior in an isolated
  organization;
- explicit Plugin creation: read `plugin-authoring.md` and scaffold only into a
  temporary target directory; and
- prompt-injected OpenCode greeting: self-gate without a documentation lookup.

## Design Notes

### Availability, activation, and authorization remain separate

`rudder-docs` remains in the always-enabled Rudder baseline, which means the
runtime may expose it. The frontmatter description and self-gating body decide
whether the current intent needs the workflow. An explicit documentation
question can activate retrieval but still does not authorize a mutation. An
explicit creation request can authorize an in-scope action, subject to the
normal permission, approval, and safety controls.

### Compatibility boundary

This is a deliberate breaking skill-identity migration. The canonical identity
remains:

- name: `rudder-docs`
- key: `rudder/rudder-docs`
- selection reference: `bundled:rudder/rudder-docs`

The retired keys, slugs, public URLs, and runtime directory names are not
supported. Historical evidence may still display those strings but cannot be
used to enable or materialize a skill.

### Source ownership

The main skill is a router, not a complete manual. The new domain references
own decisions and workflows. The existing CLI and API references own exact
commands and route shapes. Product contracts own intended semantics. Current
source, tests, installed help, and typed capabilities own current executable
evidence.

## Success Criteria

- `rudder-docs` is the only active bundled identity for Rudder documentation,
  Agent creation guidance, and Plugin authoring guidance.
- Both retired package directories and public download routes are absent.
- Old selection references are missing, not redirected.
- New organizations and runtime projections do not contain retired identities.
- Existing stale managed entries are removed only with exact provenance;
  collisions are preserved and surfaced.
- Explicit creation requests route to the correct focused reference and follow
  current governed interfaces.
- Greetings and near-miss requests do not start a Rudder documentation lookup.
- Product Logic, implementation, tests, and contributor documentation agree.

## Validation

- Focused static, unit, integration, adapter, route, organization-pruning, and
  benchmark tests.
- Create-Agent CLI E2E for direct and approval-required paths.
- Plugin scaffold test in a temporary directory, including typecheck, test,
  and build.
- Organization Agent Skills E2E for the canonical inventory and stale-row
  pruning.
- Trigger evaluation: 20 bilingual cases, 60/40 split, three trials, static
  viewer.
- Real-host Codex and OpenCode gating checks.
- `pnpm product-logic:check`
- `pnpm docs:validate`
- bundled skill quick validation and link validation
- `pnpm lint`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `git diff --check`
- independent adversarial reviewer focused on hard deletion, false-positive
  routing, provenance-safe cleanup, and Product Logic consistency.

## Validation Results

- Static, shared-resolution, runtime cleanup/projection, adapter sync, public
  route, organization pruning, benchmark, and bundled-skill suites passed. The
  final focused batch recorded 111 passed and 1 skipped; the benchmark added 7
  passed, and the organization reference integration suite added 9 passed.
- Create-Agent CLI E2E passed all 13 cases, including direct creation,
  approval-required behavior, explicit denial, and the benchmark workflow.
- A temporary Plugin scaffold completed install, typecheck, test, and build.
- The 20-case bilingual trigger evaluation ran three trials per case with a
  60/40 train/held-out split and reached 100% precision, recall, and accuracy.
- Isolated Codex and prompt-injected OpenCode host checks verified greeting
  self-gating; Agent and Plugin requests loaded only their routed references.
- `pnpm product-logic:check` passed 74 contracts; `pnpm docs:validate`, skill
  quick validation, `pnpm lint`, `pnpm -r typecheck`, `pnpm build`, and
  `git diff --check` passed.
- `pnpm test:run` recorded 4,559 passed and 2 skipped. Four failures are the
  pre-existing `0.4.6` MCP metadata assertions on local `main`, whose CLI and
  server packages are already `0.5.0`. Three full-suite concurrency flakes
  (release guard timeout, workspace runtime timeout, and Browser dispatch mock)
  each passed on an isolated rerun.
- The independent adversarial reviewer approved the final hard-delete,
  selection, collision-preservation, runtime projection, and Product Logic
  result with no remaining actionable findings.

## Open Issues

No product decision is open. Implementation may expose pre-existing unrelated
test or host-environment failures; those will be reported separately and will
not be hidden by weakening the acceptance criteria.
