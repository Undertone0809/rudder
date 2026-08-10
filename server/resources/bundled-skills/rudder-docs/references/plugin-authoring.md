# Plugin Authoring

Use this reference for explicit requests to create, inspect, import, or verify a
Rudder Plugin. Rudder V1 consumes the Codex Plugin package format and does not
provide a Plugin worker SDK or extension runtime.

## Before Writing

- Confirm the requested target directory and whether the package needs Skills,
  MCP definitions, App aliases, or a combination.
- Read `doc/engineering/PLUGIN_AUTHORING_GUIDE.md` and the current upstream
  Codex Plugin manifest specification.
- Keep the required manifest at `.codex-plugin/plugin.json` with a lower-case
  hyphenated name and strict semantic version.
- Do not recreate legacy Rudder workers, jobs, webhooks, UI slots, generic
  state, host tools, or SDK dependencies.

## Component Rules

- Put Skills at the default `skills/<slug>/SKILL.md` location or declare the
  custom root in the manifest. Keep each Skill's scripts and references inside
  its root.
- Declare MCP servers inline or through `.mcp.json`. Use environment references
  for credentials; never embed tokens, passwords, authorization headers, or API
  keys in the package.
- Treat `.app.json` as OpenAI registered App aliases only. It is not a Rudder
  Local App definition or an MCP endpoint.
- Hooks, assets, and unknown fields may be preserved but are not executable in
  Rudder V1.

## Rudder Verification

Import only when the user requested that Organization mutation. Use Plugins >
Import and review the compatibility report. Verify inspection executes nothing.
After installation, verify the public workflow relevant to the
package: Agent Skill assignment, Managed MCP setup, Local App launch,
disable/re-enable, and non-destructive uninstall.

Package creation is not evidence of installation. Installation is not evidence
that MCP credentials or Agent access are active. Keep those states explicit.
