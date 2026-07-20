# Rudder Documentation And Source Map

Use this map to choose a narrow evidence route. It describes stable domains and
directories rather than an exhaustive page list. Follow the current checkout's
`AGENTS.md` before repository inspection.

## Section Map

- [Official public documentation](#official-public-documentation)
- [Product Logic Registry](#product-logic-registry)
- [Contributor and engineering documentation](#contributor-and-engineering-documentation)
- [Implementation and tests](#implementation-and-tests)
- [Official remote source and version history](#official-remote-source-and-version-history)
- [Bundled offline references](#bundled-offline-references)
- [Targeted search patterns](#targeted-search-patterns)

## Official Public Documentation

- Index: `https://docs.rudderhq.dev/llms.txt`
- Site: `https://docs.rudderhq.dev/`
- Local public-docs checkout: `docs/`

Start with the index, choose the page matching the user's job, and open one or
two pages. Prefer the user's language when equivalent official pages exist.
Public docs own published user guidance; a local `docs/` checkout is useful
when the live site is unavailable or the task is editing the public site.

## Product Logic Registry

- Entry point: `doc/product/README.md`
- Registry map: `doc/product/registry.yml`
- Domain contracts: `doc/product/domains/`
- Composed workflows: `doc/product/workflows/`
- Surface-to-contract maps: `doc/product/surfaces/`

Use Product Logic for intended product semantics and invariants. Start at the
registry entry point and select the owning domain rather than scanning all
contracts. Reading these guarded files does not authorize editing them.

Common domain routes include:

- agents, skills, and inbox: `doc/product/domains/agents/`
- issues and issue-visible state: `doc/product/domains/issues/`
- assignment, checkout, review routing: `doc/product/domains/work-routing/`
- runs, execution, transcripts, workspaces: `doc/product/domains/execution/`
- organizations, goals, and projects:
  `doc/product/domains/organizations-and-goals/`
- Library, resources, and runtime context:
  `doc/product/domains/library-and-context/`
- Chat, Messenger, comments, and integrations:
  `doc/product/domains/collaboration/`
- approvals, budgets, costs, and activity:
  `doc/product/domains/governance-and-visibility/`
- reviews, feedback, and learning:
  `doc/product/domains/review-feedback-learning/`
- automations: `doc/product/domains/automations/`
- plugins: `doc/product/domains/plugins/`

## Contributor And Engineering Documentation

- Route selector: `doc/README.md`
- Development: `doc/engineering/DEVELOPING.md`
- CLI: `doc/engineering/CLI.md`
- Database: `doc/engineering/DATABASE.md`
- Deployment modes: `doc/engineering/DEPLOYMENT-MODES.md`
- Desktop and packaging: `doc/engineering/DESKTOP.md`
- Design: `doc/engineering/DESIGN.md`
- Releases and publishing: `doc/engineering/RELEASING.md` and
  `doc/engineering/PUBLISHING.md`
- Plugin contracts: `doc/engineering/PLUGIN_AUTHORING_GUIDE.md` and
  `doc/engineering/PLUGIN_RUNTIME_CONTRACT.md`
- Dated decisions and proposals: `doc/plans/`
- Historical archaeology only: `doc/archive/`

Contributor docs own build, operation, packaging, and architecture guidance.
Plans explain decisions in time; archived documents are not current behavior
contracts.

## Implementation And Tests

Use source and tests for exact implementation evidence:

| Area | Owning source | Tests |
| --- | --- | --- |
| REST routes and orchestration services | `server/src/routes/`, `server/src/services/` | `server/src/__tests__/` |
| Shared API types, validators, and constants | `packages/shared/src/` | colocated `*.test.ts` plus server/UI consumers |
| Database schema and migrations | `packages/db/src/schema/`, `packages/db/src/migrations/` | package tests and server integration tests |
| CLI commands and capability registry | `cli/src/` | `cli/src/__tests__/` |
| Runtime adapters and prompt construction | `packages/agent-runtimes/`, `packages/agent-runtime-utils/` | package adapter tests plus server integration tests |
| Board UI and clients | `ui/src/` | colocated UI tests and `tests/e2e/` |
| Desktop shell and packaging | `desktop/`, `scripts/prod-desktop.mjs` | Desktop smoke scripts and packaged verification |
| Bundled skills | `server/resources/bundled-skills/` | bundled-skill, runtime adapter, public route, and E2E tests |

The owning module establishes what code does; tests establish protected and
edge-case behavior. Cite both when the claim depends on a guarded branch,
permission boundary, failure status, persistence rule, or adapter-specific
path.

## Official Remote Source And Version History

- Repository: `https://github.com/Undertone0809/rudder`
- Releases: `https://github.com/Undertone0809/rudder/releases`
- Tags: `https://github.com/Undertone0809/rudder/tags`

This is the only default remote source repository. For installed behavior,
first identify the installed Rudder version and use a matching official tag or
release when one exists. The default branch represents latest development and
must not be presented as the behavior of an older installed build. Link the
exact file, test, commit, tag, or release used.

## Bundled Offline References

Within this package:

- `cli-reference.md` preserves the typed capability and CLI fallback catalog;
- `api-reference.md` preserves internal/debug compatibility endpoints;
- `operating-practices.md` preserves conditional operating semantics; and
- `organization-skills.md` preserves organization skill workflows.

Use only the relevant section. These references are version-adjacent fallback
evidence, not a substitute for live installed help when the two disagree.

## Targeted Search Patterns

Prefer `rg -n` in the smallest owning directory. Useful query shapes include:

- contract or registry ID: `rg -n "CONTRACT.ID|domain term" doc/product`
- route or status: `rg -n "route-fragment|409|422" server/src packages/shared/src`
- CLI command or capability: `rg -n "capability.id|command-name" cli/src server/src`
- environment or configuration key: `rg -n "RUDDER_[A-Z_]+|configKey" server packages cli desktop`
- schema field or table: `rg -n "fieldName|table_name" packages/db/src server/src`
- UI label or test id: `rg -n "visible copy|data-testid" ui/src tests/e2e`
- a bundled-skill fact: `rg -n "phrase|command" server/resources/bundled-skills`
- related regression coverage: `rg -n "identifier|error text|behavior phrase" --glob '*test*' --glob '*.spec.ts'`

Search exact identifiers first, then widen to a stable concept. Avoid broad
repository scans when an owning domain, route, command, or component is already
known.
