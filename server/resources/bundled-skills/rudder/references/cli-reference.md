# Rudder Agent CLI Reference

Stable CLI contract for agents using the bundled `rudder` skill. Prefer these commands over direct `/api` calls.

## Defaults

- All commands support `--json`.
- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.
- `--run-id` defaults to `RUDDER_RUN_ID` and is attached to mutating requests when available.
- `issue checkout` defaults `--agent-id` from `RUDDER_AGENT_ID`.

## Agent V1 Commands

| Command | Description | Mutating | Org | Agent | Run ID |
| --- | --- | --- | --- | --- | --- |
| `rudder agent me` | Show the authenticated agent identity, budget, and chain of command. | no | no | no | no |
| `rudder agent inbox` | List the compact assigned-work inbox for the authenticated agent. | no | no | no | no |
| `rudder agent capabilities` | List the stable Rudder agent command contract. | no | no | no | no |
| `rudder agent skills sync <agent-id>` | Sync the desired enabled skill set for an agent. | yes | no | no | attached when available |
| `rudder issue get <issue>` | Read a full issue by UUID or identifier. | no | no | no | no |
| `rudder issue context <issue>` | Read the compact heartbeat context for an issue. | no | no | no | no |
| `rudder issue checkout <issue>` | Atomically checkout an issue for the current or specified agent. | yes | no | required | attached when available |
| `rudder issue comment <issue> --body <text>` | Add a comment to an issue. | yes | no | no | attached when available |
| `rudder issue comments list <issue>` | List issue comments, optionally only newer comments after a cursor. | no | no | no | no |
| `rudder issue comments get <issue> <comment-id>` | Read one issue comment by id. | no | no | no | no |
| `rudder issue update <issue> ...` | Apply generic issue updates when workflow commands are not enough. | yes | no | no | attached when available |
| `rudder issue done <issue> --comment <text>` | Mark an issue done with a required completion comment. | yes | no | no | attached when available |
| `rudder issue block <issue> --comment <text>` | Mark an issue blocked with a required blocker comment. | yes | no | no | attached when available |
| `rudder issue release <issue>` | Release an issue back to todo and clear ownership. | yes | no | no | attached when available |
| `rudder issue documents list <issue>` | List issue documents. | no | no | no | no |
| `rudder issue documents get <issue> <key>` | Read one issue document by key. | no | no | no | no |
| `rudder issue documents put <issue> <key> --body <text>` | Create or update an issue document. | yes | no | no | attached when available |
| `rudder issue documents revisions <issue> <key>` | List revisions for an issue document. | no | no | no | no |
| `rudder approval get <approval-id>` | Read one approval request. | no | no | no | no |
| `rudder approval issues <approval-id>` | List the issues linked to an approval. | no | no | no | no |
| `rudder approval comment <approval-id> --body <text>` | Add a comment to an approval. | yes | no | no | attached when available |
| `rudder skill list --org-id <id>` | List organization-visible skills. | no | required | no | no |
| `rudder skill get <skill-id> --org-id <id>` | Read one organization skill detail. | no | required | no | no |
| `rudder skill file <skill-id> --org-id <id> [--path SKILL.md]` | Read one file from an organization skill package. | no | required | no | no |
| `rudder skill import --org-id <id> --source <source>` | Import a skill package into the organization skill library. | yes | required | no | attached when available |
| `rudder skill scan-local --org-id <id> [--roots <csv>]` | Scan local roots for skill packages and import new ones. | yes | required | no | attached when available |
| `rudder skill scan-projects --org-id <id> [--project-ids <csv>] [--workspace-ids <csv>]` | Scan the org workspace and any legacy project workspace records for skill packages and import new ones. | yes | required | no | attached when available |

## Compatibility Commands

- `rudder agent list --org-id <id>` — List agents for an organization.
- `rudder agent get <agent-id-or-shortname>` — Read one agent by id or shortname.
- `rudder agent hire --org-id <id> --payload <json>` — Create a new hire using the canonical hire workflow.
- `rudder agent config index` — Read the installed agent runtime configuration index.
- `rudder agent config doc <agent-runtime-type>` — Read adapter-specific configuration guidance for one runtime.
- `rudder agent config list --org-id <id>` — List redacted agent configuration snapshots for an organization.
- `rudder agent config get <agent-id-or-shortname>` — Read one redacted agent configuration snapshot by id or shortname.
- `rudder agent icons` — List allowed agent icon names for create and hire payloads.
- `rudder issue create --org-id <id> ...` — Create a new issue or subtask with the generic issue surface.
- `rudder approval create --org-id <id> --type <type> --payload <json>` — Create a new approval request.
- `rudder approval resubmit <approval-id> [--payload <json>]` — Resubmit a revision-requested approval, optionally with updated payload.
