# Agent Organizations Spec Inventory

This document indexes every part of the Rudder codebase that touches the [Agent Organizations Specification](docs/organizations/organizations-spec.md) (`agentorganizations/v1-draft`).

Use it when you need to:

1. **Update the spec** — know which implementation code must change in lockstep.
2. **Change code that involves the spec** — find all related files quickly.
3. **Keep things aligned** — audit whether implementation matches the spec.

---

## 1. Specification & Design Documents

| File | Role |
|---|---|
| `docs/organizations/organizations-spec.md` | **Normative spec** — defines the markdown-first package format (ORGANIZATION.md, TEAM.md, AGENTS.md, PROJECT.md, TASK.md, SKILL.md), reserved files, frontmatter schemas, and vendor extension conventions (`.rudder.yaml`). |
| `doc/plans/2026-03-13-organization-import-export-v2.md` | Implementation plan for the markdown-first package model cutover — phases, API changes, UI plan, and rollout strategy. |
| `doc/SPEC-implementation.md` | V1 implementation contract; references the portability system and `.rudder.yaml` sidecar format. |
| `docs/specs/cliphub-plan.md` | Earlier blueprint bundle plan; partially superseded by the markdown-first spec (noted in the v2 plan). |
| `doc/plans/2026-02-16-module-system.md` | Module system plan; JSON-only organization template sections superseded by the markdown-first model. |
| `doc/plans/2026-03-14-skills-ui-product-plan.md` | Skills UI plan; references portable skill files and `.rudder.yaml`. |
| `doc/plans/2026-03-14-adapter-skill-sync-rollout.md` | Adapter skill sync rollout; companion to the v2 import/export plan. |

## 2. Shared Types & Validators

These define the contract between server, CLI, and UI.

| File | What it defines |
|---|---|
| `packages/shared/src/types/organization-portability.ts` | TypeScript interfaces: `OrganizationPortabilityManifest`, `OrganizationPortabilityFileEntry`, `OrganizationPortabilityEnvInput`, export/import/preview request and result types, manifest entry types for agents, skills, projects, issues, recurring automations, organizations. |
| `packages/shared/src/validators/organization-portability.ts` | Zod schemas for all portability request/response shapes — used by both server routes and CLI. |
| `packages/shared/src/types/index.ts` | Re-exports portability types. |
| `packages/shared/src/validators/index.ts` | Re-exports portability validators. |

## 3. Server — Services

| File | Responsibility |
|---|---|
| `server/src/services/organization-portability.ts` | **Core portability service.** Export (manifest generation, markdown file emission, `.rudder.yaml` sidecars), import (graph resolution, collision handling, entity creation), preview (planned-action summary). Handles skill key derivation, recurring task <-> automation mapping, legacy recurrence migration, and package README generation. References `agentorganizations/v1` version string. |
| `server/src/services/automations.ts` | Rudder automation runtime service. Portability now exports automations as recurring `TASK.md` entries and imports recurring tasks back through this service. |
| `server/src/services/organization-export-readme.ts` | Generates `README.md` and Mermaid org-chart for exported organization packages. |
| `server/src/services/index.ts` | Re-exports `organizationPortabilityService`. |

## 4. Server — Routes

| File | Endpoints |
|---|---|
| `server/src/routes/organizations.ts` | `POST /api/orgs/:orgId/export` — legacy export bundle<br>`POST /api/orgs/:orgId/exports/preview` — export preview<br>`POST /api/orgs/:orgId/exports` — export package<br>`POST /api/orgs/import/preview` — import preview<br>`POST /api/orgs/import` — perform import |

Route registration lives in `server/src/app.ts` via `organizationRoutes(db, storage)`.

## 5. Server — Tests

| File | Coverage |
|---|---|
| `server/src/__tests__/organization-portability.test.ts` | Unit tests for the portability service (export, import, preview, manifest shape, `agentorganizations/v1` version). |
| `server/src/__tests__/organization-portability-routes.test.ts` | Integration tests for the portability HTTP endpoints. |

## 6. CLI

| File | Commands |
|---|---|
| `cli/src/commands/client/organization.ts` | `organization export` — exports a organization package to disk (flags: `--out`, `--include`, `--projects`, `--issues`, `--projectIssues`).<br>`organization import <fromPathOrUrl>` — imports a organization package from a file or folder (flags: positional source path/URL or GitHub shorthand, `--include`, `--target`, `--orgId`, `--newOrganizationName`, `--agents`, `--collision`, `--ref`, `--dryRun`).<br>Reads/writes portable file entries and handles `.rudder.yaml` filtering. |

## 7. UI — Pages

| File | Role |
|---|---|
| `ui/src/pages/OrganizationExport.tsx` | Export UI: preview, manifest display, file tree visualization, ZIP archive creation and download. Filters `.rudder.yaml` based on selection. Shows manifest and README in editor. |
| `ui/src/pages/OrganizationImport.tsx` | Import UI: source input (upload/folder/GitHub URL/generic URL), ZIP reading, preview pane with dependency tree, entity selection checkboxes, trust/licensing warnings, secrets requirements, collision strategy, adapter config. |

## 8. UI — Components

| File | Role |
|---|---|
| `ui/src/components/PackageFileTree.tsx` | Reusable file tree component for both import and export. Builds tree from `OrganizationPortabilityFileEntry` items, parses frontmatter, shows action indicators (create/update/skip), and maps frontmatter field labels. |

## 9. UI — Libraries

| File | Role |
|---|---|
| `ui/src/lib/portable-files.ts` | Helpers for portable file entries: `getPortableFileText`, `getPortableFileDataUrl`, `getPortableFileContentType`, `isPortableImageFile`. |
| `ui/src/lib/zip.ts` | ZIP archive creation (`createZipArchive`) and reading (`readZipArchive`) — implements ZIP format from scratch for organization packages. CRC32, DOS date/time encoding. |
| `ui/src/lib/zip.test.ts` | Tests for ZIP utilities; exercises round-trip with portability file entries and `.rudder.yaml` content. |

## 10. UI — API Client

| File | Functions |
|---|---|
| `ui/src/api/orgs.ts` | `organizationsApi.exportBundle`, `organizationsApi.exportPreview`, `organizationsApi.exportPackage`, `organizationsApi.importPreview`, `organizationsApi.importBundle` — typed fetch wrappers for the portability endpoints. |

## 11. Skills & Agent Instructions

| File | Relevance |
|---|---|
| `skills/rudder/references/organization-skills.md` | Reference doc for organization skill library workflow — install, inspect, update, assign. Skill packages are a subset of the agent organizations spec. |
| `server/src/services/organization-skills.ts` | Organization skill management service — handles SKILL.md-based imports and organization-level skill library. |
| `server/src/services/agent-instructions.ts` | Agent instructions service — resolves AGENTS.md paths for agent instruction loading. |

## 12. Quick Cross-Reference by Spec Concept

| Spec concept | Primary implementation files |
|---|---|
| `ORGANIZATION.md` frontmatter & body | `organization-portability.ts` (export emitter + import parser) |
| `AGENTS.md` frontmatter & body | `organization-portability.ts`, `agent-instructions.ts` |
| `PROJECT.md` frontmatter & body | `organization-portability.ts` |
| `TASK.md` frontmatter & body | `organization-portability.ts` |
| `SKILL.md` packages | `organization-portability.ts`, `organization-skills.ts` |
| `.rudder.yaml` vendor sidecar | `organization-portability.ts`, `automations.ts`, `OrganizationExport.tsx`, `organization.ts` (CLI) |
| `manifest.json` | `organization-portability.ts` (generation), shared types (schema) |
| ZIP package format | `zip.ts` (UI), `organization.ts` (CLI file I/O) |
| Collision resolution | `organization-portability.ts` (server), `OrganizationImport.tsx` (UI) |
| Env/secrets declarations | shared types (`OrganizationPortabilityEnvInput`), `OrganizationImport.tsx` (UI) |
| README + org chart | `organization-export-readme.ts` |
