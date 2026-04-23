# Organization Rename and Chat V1 Alignment

## Summary

Replace the top-level `Company` model with `Organization` across docs, product language, storage model, APIs, CLI, UI, tests, and portability/template flows. Use `Organization` as the public noun and `org` / `orgs` as the code and route shorthand.

Update the V1 spec set so Chat is a shipped V1 feature with the already-implemented intake / clarification / routing role. The product boundary becomes: Chat is a first-class entry surface, but issue-centric execution and long-running tracking remain the core work model.

## Key Changes

### 1. Canonical terminology and UI naming

- Adopt `Organization` as the canonical top-level entity in all public docs and UI copy.
- Adopt `org` / `orgs` as the canonical code and route shorthand:
  - `/api/orgs`
  - `orgId`
  - `Organization`, `CreateOrganization`, `UpdateOrganization`
  - `organizationService`, `OrganizationContext`, `useOrganization`
- Keep `org chart` / `org tree` as internal structure terms only where implementation needs them.
- Rename all user-facing `Org Chart` labels to `Organization Structure`.
- Keep the existing structure view/page capability, but change page titles, nav labels, breadcrumbs, empty states, settings links, export copy, and related UI text from `Org Chart` to `Organization Structure`.
- Remove `Company` terminology instead of aliasing it. No compatibility layer in routes, shared types, CLI commands, or UI helpers.

### 2. Spec/doc rewrite

- Update `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC.md`, and `doc/SPEC-implementation.md` so they consistently use organization terminology.
- Update the operational docs and README to match the new model and naming.
- Add Chat to the V1 product and implementation docs as an org-scoped intake surface.
- Keep older plan docs as historical records unless they are still linked from active docs and would become misleading.

### 3. System-wide model and API rename

- Database and schema
  - rename `companies` to `organizations`
  - rename all `company_id` columns and relations to `org_id`
  - rename company-prefixed tables and schema modules to organization-prefixed equivalents where they represent the top-level entity or org-scoped helpers
  - do this with forward migrations; do not rewrite historical migrations already in version history
- Shared contracts
  - rename `Company*` types, validators, constants, access scopes, permission strings, and API path constants
  - rename chat payloads and entities to use `orgId`
- Server
  - rename company services, routes, auth helpers, membership checks, storage namespace helpers, websocket paths, and activity payloads to org terminology
  - canonical scoped routes become `/api/orgs/:orgId/...`
  - update JWT claims and actor context naming from `company_id` / `companyId` to `org_id` / `orgId`
- UI
  - rename company selection/context/provider/state to organization selection/context/provider/state
  - rename pages and copy such as Companies, Company Settings, Company Import/Export, Company Skills
  - keep the structure page route behavior intact, but present it as `Organization Structure`
- CLI
  - replace `rudder company ...` with `rudder org ...`
  - replace `/api/companies/...` assumptions with `/api/orgs/...`
- No fallback aliases:
  - no `/companies` routes
  - no `companyId` fields in shared/public types
  - no `Company*` exported symbols in active code

### 4. Portability/templates and marketplace naming

- Rename `CompanyPortability*` to `OrganizationPortability*`.
- Rename import/export flows, docs, UI, CLI, service names, and generated package copy from company to organization terminology.
- Change the portable package manifest shape from `company` to `organization`.
- Change the portable package schema/version identifier from `agentcompanies/v1` to `agentorganizations/v1`.
- Rename package-facing artifacts accordingly:
  - `COMPANY.md` to `ORGANIZATION.md`
  - “Agent Company package” to “Agent Organization package”
  - ClipHub copy from company registry/templates to organization registry/templates
- Update generated export README text and structure-preview metadata, including visible `Org Chart` labels to `Organization Structure`.

### 5. Chat as shipped V1 feature

- Treat Chat as a first-class V1 surface for:
  - request intake
  - clarification
  - routing suggestion
  - issue proposal
  - approval-gated lightweight operations
- Keep these constraints explicit in the spec:
  - Chat is org-scoped
  - a conversation may have zero or one primary issue
  - a conversation may reference multiple existing issues, projects, and agents
  - long-running execution and durable work tracking remain issue-centric
  - Chat is not a replacement for issues and not a free-form multi-agent chat room
- Update V1 data model/API/UI sections to include the implemented chat entities and endpoints under org naming.
- Update product and spec language so Chat availability, assistant behavior, approvals, and settings are reflected as shipped behavior rather than remaining in plan-only docs.

## Test Plan

- Migration verification
  - forward migration cleanly renames tables/columns/indexes/FKs from company to organization naming
  - fresh bootstrap creates only organization-named schema objects
  - existing DB upgrades without data loss
- Contract verification
  - shared types, validators, and API constants expose only `Organization` / `orgId` / `/orgs`
  - no active code path requires `Company` / `companyId` / `/companies`
- Server/API verification
  - CRUD and scoped routes work under `/api/orgs/:orgId/...`
  - websocket/live-update paths use org naming
  - chat routes and services work after the org rename
  - issue creation from chat still goes through the existing issue service path
- UI/CLI verification
  - organization selection, routing, settings, import/export, skills, chat, and `Organization Structure` page all work under the new names
  - CLI command surface uses `org` naming end-to-end
- Doc/product verification
  - README + core spec docs are internally consistent on organization terminology
  - no remaining contradiction that says Rudder has no chat while V1 spec includes Chat
  - no remaining user-facing `Org Chart` labels where `Organization Structure` should appear
- Repo sweeps
  - grep-based acceptance for active source/docs: no `Company`, `companyId`, `/companies`, `company_` except in intentional historical references, migration history commentary, or third-party/upstream names explicitly preserved as history

## Assumptions

- Public noun is `Organization`; code/resource shorthand is `org`.
- This is a breaking rename with no compatibility aliases.
- Portability/template/package flows are included in the rename.
- The new portability schema identifier is `agentorganizations/v1`.
- Chat is specified as an intake layer, not as a replacement for issue-centric execution.
- `Organization Structure` is the final user-facing replacement for `Org Chart`.
