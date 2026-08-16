---
title: Rudder Plugin Discovery Hub
date: 2026-08-14
kind: implementation
status: in_progress
area: skills
entities:
  - rudder_plugins
  - plugin_catalog
  - codex_plugin_import
  - skills_add_import
  - plugin_detail
issue:
related_plans:
  - 2026-08-09-codex-compatible-rudder-plugins-v1.md
supersedes: []
related_code:
  - packages/shared/src/types/plugin-v1.ts
  - packages/shared/src/validators/plugin-v1.ts
  - server/src/routes/rudder-plugins.ts
  - server/src/services/rudder-plugins.ts
  - ui/src/pages/Plugins.tsx
  - tests/e2e/plugins-v1.spec.ts
commit_refs: []
updated_at: 2026-08-14
---

# Rudder Plugin Discovery Hub

## Objective

Make useful Codex Plugins and repositories compatible with `npx skills add`
discoverable from Rudder without delegating trust or execution to third-party
installers. The public journey is:

```text
Discover -> Plugin Detail -> preview Skills/MCPs/Apps -> Install
         -> assign Skills to Agents / configure MCP
```

`Review` remains an internal persistence concept only. Product surfaces and
public APIs call the immutable inspection result a Preview.

## Product Decisions

- `Undertone0809/rudder-plugins` is the default, manually curated public
  catalog. Its external entries contain metadata and icons, not copied package
  source.
- A repository is one Plugin regardless of whether discovery finds one Skill
  or many Skills. Installation applies the full discovered set.
- Catalog listing is lightweight. Rudder resolves and downloads a package only
  when the operator opens Plugin Detail.
- Detail resolution chooses the newest stable semantic-version Release when
  available and otherwise the default branch HEAD, then locks a full commit
  SHA.
- Install and Update consume the Preview ID created for that immutable SHA.
  They never resolve the upstream repository again.
- Rudder never executes `npx`, package lifecycle scripts, hooks, MCP servers,
  Apps, or Skill scripts during discovery, preview, or installation.
- Discover accepts only curated public HTTPS sources. Arbitrary compatible
  public sources use URL Import; private repositories, SSH, and local paths
  remain behind existing explicit import boundaries.
- Installed versions remain unchanged until the operator explicitly opens the
  new Detail preview and selects Update.
- Codex `.app.json` aliases are visible unsupported inventory. They are not
  Rudder Local Apps or executable MCP UI.

## Catalog Repository

Create `/Users/zeeland/projects/rudder-hub/rudder-plugins` as a public MIT
repository with:

```text
catalog.json
plugins/<slug>/source.json
plugins/<slug>/assets/icon.png
plugins/<slug>/assets/icon-dark.png
schemas/catalog.schema.json
schemas/source.schema.json
scripts/validate.mjs
THIRD_PARTY_NOTICES.md
README.md
```

The first catalog contains Superpowers, Marketing Skills, Vercel, Base44,
Canva, Remotion, and Zotero. Descriptors include display metadata, source and
version policy, licensing, provenance, and policy links. Icons without clear
redistribution authority use Rudder-created generic placeholders and are
identified as such in notices.

Validation covers JSON Schema, unique slugs, HTTPS GitHub sources, safe
subdirectories, icon dimensions and type, required license metadata, bounded
archives, credential heuristics, Codex manifests, and Skill discovery.

## Rudder Architecture

### Catalog client

Add a dedicated service responsible for:

1. Fetching and validating `catalog.json` with ETag.
2. Retaining the instance's last successful catalog so a temporary catalog
   failure degrades to stale discovery data without affecting installed
   Plugins.
3. Fetching one selected `source.json` and icon on demand from the same trusted
   catalog origin.
4. Resolving GitHub Release/default-branch metadata through bounded HTTPS
   requests and locking the final commit SHA.
5. Downloading only the selected repository or safe subdirectory archive.
6. Mapping native Codex manifests or deterministic `skills_add` discovery into
   the existing non-executing Plugin inspection service.

An environment override supplies the catalog URL for deterministic integration
and E2E fixtures. The production default targets the raw public catalog.

### API

- `GET /api/orgs/:orgId/plugins/catalog` returns lightweight catalog rows with
  install and update state.
- `POST /api/orgs/:orgId/plugins/catalog/:slug/preview` resolves and freezes a
  catalog entry and returns Plugin Detail.
- `POST /api/orgs/:orgId/plugins/imports/preview-source` accepts a compatible
  public `skills add` source and returns the same Detail shape.
- `GET /api/plugins/catalog/:slug/icon` serves validated cached icons from the
  Rudder origin.
- Existing install and update mutations continue to accept only the immutable
  Preview ID.

### UI

Discover remains under the Hub Plugins tab and lists all catalog rows with
search and installation/update status. Selecting a row navigates to a dedicated
Plugin Detail route.

The Detail page follows the Codex Plugin information hierarchy:

- brand icon, name, developer, short description, and Install/Update action at
  the top;
- grouped Skills, MCPs, and Apps inventory with support/setup status;
- update capability diff when applicable;
- information section for capabilities, developer, category, resolved version,
  website, privacy policy, terms, provenance, and locked SHA;
- installed follow-up actions for Agent Skill assignment and MCP setup.

The page must remain readable with a 49-Skill bundle, a 390px viewport, dark
theme, long names, unavailable catalog state, and unsupported App aliases.

## Safety Boundaries

- Accept HTTPS only and permit only a small bounded redirect chain back to
  HTTPS.
- Validate final GitHub owner/repository identity and use a full immutable SHA
  for archive retrieval.
- Apply existing package limits: 500 files, 2 MiB per file, 10 MiB total and
  archive size, and 100:1 expansion ratio.
- Reject path traversal, absolute and case-colliding paths, invalid manifests,
  and literal credential material before creating an installable Preview.
- Never log tokens, authorization headers, repository credentials, or package
  contents that match the credential detector.
- Keep all package and installation visibility organization-scoped.

## Contract Delta

The user authorized synchronized edits to:

- `PLUGIN.PACKAGE.001`: add curated descriptors and deterministic
  `skills_add` packages as compatible distribution identities.
- `PLUGIN.IMPORT.001`: replace the public Review step with immutable Preview,
  add Release/HEAD resolution and SHA freezing, and retain non-execution and
  bounded inspection invariants.
- `PLUGIN.INSTALLATION.001`: require install/update to consume the exact Preview
  and keep updates explicit rather than automatic.

Engineering Plugin documentation and public user documentation will describe
the same source, preview, installation, and update behavior.

## Verification And Delivery

- Catalog: schema/unit tests plus live resolution for all seven entries;
  negative fixtures for duplicate slug, unsafe path, missing icon, invalid
  source, oversize content, and credentials.
- Rudder: focused unit/integration tests for native Codex Plugins,
  `skills_add`, single/49-Skill discovery, stable Release/HEAD fallback, locked
  SHA, ETag fallback, unsupported Apps, organization isolation, update
  detection, and Preview/install consistency.
- E2E: seven-row Discover, Superpowers and Marketing Skills detail/install/
  assign/uninstall continuity, unsupported App inventory, URL Import, explicit
  Update, search, long lists, desktop, 390px mobile, and light/dark themes.
- Run `pnpm product-logic:check`, focused tests, the relevant E2E suite,
  `pnpm lint`, `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build`.
- Complete stage review, freeze candidate/runtime/organization/data evidence,
  obtain black-box verifier `PASS`, then final reviewer `accept` on the
  unchanged candidate.
- Commit and push both repositories. Create the catalog as a public GitHub
  repository. Stop Rudder at Review Ready; do not publish a Rudder release.
