# Organization Skills Workflow

Use this reference when a board user, CEO, or manager asks you to discover, import, inspect, or enable organization skills.

This workflow is now **CLI-first** for the bundled `rudder` skill.

## Canonical Model

1. import or scan the skill into the organization library
2. inspect the imported skill if needed
3. sync the desired enabled skills onto the target agent

## Core CLI Surface

```bash
rudder skill list --org-id "$RUDDER_ORG_ID" --json
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
rudder skill scan-local --org-id "$RUDDER_ORG_ID" --roots "<csv>" --json
rudder skill scan-projects --org-id "$RUDDER_ORG_ID" --project-ids "<csv>" --workspace-ids "<csv>" --json
rudder agent skills sync "<agent-id>" --desired-skills "<csv>" --json
```

Defaults:

- `--org-id` can come from `RUDDER_ORG_ID`
- mutating commands attach `RUDDER_RUN_ID` automatically when present

## Source Types

Use these sources in priority order:

| Source format | Example | When to use |
| --- | --- | --- |
| `skills.sh` URL | `https://skills.sh/google-labs-code/stitch-skills/design-md` | Preferred when the user gives a managed registry URL |
| key-style source | `google-labs-code/stitch-skills/design-md` | Shorthand for the same managed skill |
| GitHub URL | `https://github.com/vercel-labs/agent-browser` | When the skill is on GitHub but not on `skills.sh` |
| local path | `/abs/path/to/skill-dir` | Local dev or testing only |

If the user gives a `skills.sh` URL, keep it as `skills.sh` or key-style. Do not rewrite it to a GitHub URL.

## Import Examples

Preferred managed import:

```bash
rudder skill import \
  --org-id "$RUDDER_ORG_ID" \
  --source "https://skills.sh/google-labs-code/stitch-skills/design-md" \
  --json
```

Equivalent key-style import:

```bash
rudder skill import \
  --org-id "$RUDDER_ORG_ID" \
  --source "google-labs-code/stitch-skills/design-md" \
  --json
```

GitHub import:

```bash
rudder skill import \
  --org-id "$RUDDER_ORG_ID" \
  --source "https://github.com/vercel-labs/agent-browser" \
  --json
```

Local skill scan:

```bash
rudder skill scan-local \
  --org-id "$RUDDER_ORG_ID" \
  --roots "/abs/path/to/.agents,/abs/path/to/other-skill-root" \
  --json
```

Shared workspace scan:

```bash
rudder skill scan-projects \
  --org-id "$RUDDER_ORG_ID" \
  --project-ids "<project-id-1>,<project-id-2>" \
  --json
```

Notes:

- Rudder now uses one fixed org workspace root at `~/.rudder/instances/<instance>/organizations/<org-id>/workspaces`.
- `scan-projects` should be treated as a compatibility command that scans the shared org workspace plus any legacy project workspace records that still exist.
- The org `Resources` catalog is the canonical place to register shared repos, docs, URLs, and connector objects for agents.
- Workspaces remains the disk-backed shared file surface for plans, notes, and skill packages.

## Inspect Imported Skills

List skills:

```bash
rudder skill list --org-id "$RUDDER_ORG_ID" --json
```

Read one skill:

```bash
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
```

Read `SKILL.md` or another file from the package:

```bash
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path references/notes.md --json
```

## Enable Skills On An Existing Agent

`desiredSkills` accepts:

- exact organization skill key
- exact organization skill id
- exact slug when it is unique in the organization

```bash
rudder agent skills sync \
  "<agent-id>" \
  --desired-skills "vercel-labs/agent-browser/agent-browser" \
  --json
```

For multiple skills:

```bash
rudder agent skills sync \
  "<agent-id>" \
  --desired-skills "agent-browser,design-md" \
  --json
```

## Permission Model

- organization skill reads: any same-organization actor
- organization skill mutations: board, CEO, or an agent with effective `agents:create`
- agent skill sync: same permission model as updating that agent

## Notes

- Built-in Rudder skills live in the organization library but are not auto-enabled.
- New organizations also seed optional community preset skills into the organization library. They stay organization-managed and default-off for agents.
- If a skill reference is missing or ambiguous, Rudder returns `422`.
- Prefer linking back to the relevant issue, approval, and agent when commenting about skill changes.
- This document only covers library import/inspect/sync.
- Hire and create flows now live on the CLI-first `rudder-create-agent` path.
