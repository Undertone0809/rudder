# Plugin Authoring Guide

Rudder V1 imports Codex Plugin packages. It does not define a Rudder Plugin SDK
or runtime. Authors should create a standard Codex Plugin folder and test the
package without requiring Rudder-specific workers, jobs, webhooks, UI slots, or
host APIs.

## Package Shape

Every package requires:

```text
my-plugin/
  .codex-plugin/
    plugin.json
```

The manifest uses a lower-case hyphenated `name` and strict semantic `version`.
Rudder V1 recognizes the upstream default or manifest-declared locations for:

- Skills, normally under `skills/<slug>/SKILL.md`;
- MCP server definitions, inline or in `.mcp.json`;
- OpenAI registered App aliases in `.app.json`.

Skills and MCP definitions are setup-capable. `.app.json` ids, hooks, assets,
and unknown fields are preserved and reported but do not become executable
Rudder components by themselves. A package needs at least one supported or
setup-capable component to install.

Minimal Skills-only example:

```json
{
  "name": "research-kit",
  "version": "1.0.0",
  "description": "Research with a repeatable evidence workflow.",
  "interface": {
    "displayName": "Research Kit",
    "shortDescription": "Gather and cite evidence."
  }
}
```

```text
skills/research/SKILL.md
```

Follow the current Codex Plugin format for complete fields and component
authoring. Do not add a Rudder-specific worker entry point.

## Discover, Import, And Preview

Open **Hub > Plugins** to browse Rudder's curated public catalog, or use
**Import** to select a package folder, ZIP, marketplace, or public GitHub Skills
source accepted by `skills add`. A team marketplace can use an ordered
`marketplace.json` with local Plugin paths; Rudder also accepts an HTTPS GitHub
marketplace pinned to a full commit SHA. Hub is a default Rudder capability and
does not require an experimental flag.

For curated and `skills add` sources, Rudder resolves the latest stable semantic
Release or default branch HEAD, locks the full commit SHA, and displays one
immutable Preview. Installing uses that Preview ID and never resolves upstream
again. Rudder does not invoke `npx`; a Skills repository is mapped to a
deterministic Skills-only Codex manifest. Marketplace `INSTALLED_BY_DEFAULT`
policy never bypasses the explicit Rudder install action.

Import inspection never executes package content. It rejects unsafe paths,
case collisions, oversize packages, invalid manifests, missing component
references, and literal MCP credentials. Use environment references rather than
embedding secrets in `.mcp.json` or `plugin.json`.

After installation:

- package Skills appear as read-only Organization Skills and require explicit
  Agent assignment;
- MCP definitions can create disabled managed-connection drafts, then continue
  through normal Managed MCP authentication and activation;
- active Managed MCP connections may expose HTML UI resources, which Rudder
  reads through the managed client and renders in a network-disabled sandbox;
- Codex `.app.json` aliases remain visible but are not treated as Rudder Local
  Apps or endpoint discovery;
- Rudder Local Apps continue to be built and run by App Builder/Desktop and
  appear as app-only entries under **Hub > Plugins**. New App revisions wait
  for an explicit update Preview while the current revision stays active.

## Verification

Before sharing a package:

- validate `.codex-plugin/plugin.json` against the current Codex specification;
- test each Skill independently and keep its scripts/references inside its root;
- verify MCP definitions contain no literal credentials and disclose expected
  transport and access;
- import the exact folder into a disposable Rudder Organization and inspect the
  compatibility report;
- verify Agent assignment, managed MCP setup, disable/re-enable, and uninstall
  behavior for the components the package provides.
- verify a previewed version update, failure recovery, and rollback when sharing
  a new version of an existing package identity.

Rudder package import does not prove the component works in Codex, and Codex
installation does not prove Rudder runtime setup has completed.
