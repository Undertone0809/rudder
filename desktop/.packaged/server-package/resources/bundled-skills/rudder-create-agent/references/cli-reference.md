# Rudder Create Agent CLI Reference

Canonical CLI contract for the bundled `rudder-create-agent` skill. Prefer these commands over direct `/api` calls.

## Defaults

- All commands support `--json`.
- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.
- Mutating commands attach `RUDDER_RUN_ID` automatically when available.
- `agent config index`, `agent config doc`, and `agent icons` print plain text by default. With `--json`, they emit that text as a JSON string.

## Core CLI Surface

### Identity and discovery

```sh
rudder agent me --json
rudder agent list --org-id "$RUDDER_ORG_ID" --json
rudder agent get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
rudder agent config index
rudder agent config doc "<agent-runtime-type>"
rudder agent config list --org-id "$RUDDER_ORG_ID" --json
rudder agent config get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
rudder agent icons
```

Use these in order:

1. `agent me` to verify auth and org context
2. `agent config index` to discover installed runtimes
3. `agent config doc` to read one runtime's required fields and examples
4. `agent list` plus `agent config list/get` to reuse proven patterns from related agents
5. `agent icons` to choose an allowed `icon`

### Organization skills

```sh
rudder skill list --org-id "$RUDDER_ORG_ID" --json
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
rudder skill scan-local --org-id "$RUDDER_ORG_ID" --roots "<csv>" --json
rudder skill scan-projects --org-id "$RUDDER_ORG_ID" --project-ids "<csv>" --workspace-ids "<csv>" --json
```

Use these before hiring when the new role needs `desiredSkills`.

`desiredSkills` accepts:

- exact organization skill key
- exact organization skill id
- exact slug when it is unique in the organization

### Canonical hire flow

```sh
rudder agent hire --org-id "$RUDDER_ORG_ID" --payload '{
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "<ceo-agent-id>",
  "capabilities": "Owns technical roadmap, architecture, staffing, execution",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "agentRuntimeType": "codex_local",
  "agentRuntimeConfig": {
    "cwd": "/abs/path/to/repo",
    "model": "o4-mini",
    "promptTemplate": "# SOUL.md -- CTO Persona\n\nYou are the CTO.\n\n## Mission\nOwn technical strategy, architecture, engineering execution, and quality bars.\n\n## Responsibilities\n- Set technical direction and execution standards.\n- Review architecture and staffing trade-offs.\n- Keep delivery risks visible and actionable.\n\n## Boundaries\n- Do not approve risky shortcuts without naming the trade-off.\n- Escalate product or budget ambiguity instead of guessing.\n\n## Decision Principles\n- Prefer simple architectures with explicit trade-offs.\n- Treat reliability, developer velocity, and product learning as linked constraints.\n\n## Voice\nDirect, specific, and evidence-led.\n\n## Continuity\nPreserve durable technical standards, repeated failure patterns, and long-running architecture decisions in memory or explicit instructions."
  },
  "runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true, "maxConcurrentRuns": 3}},
  "sourceIssueId": "<issue-id>"
}' --json
```

Canonical semantics:

- this wraps `POST /api/orgs/:orgId/agent-hires`
- if the organization does not require board approval, the response contains `approval: null` and the agent is created directly
- if the organization requires board approval, the response contains both `agent` and `approval`, and the new agent stays `pending_approval`

Do not use `rudder approval create --type hire_agent` as a replacement for `agent hire` during normal skill execution. That is a lower-level compatibility surface and does not preserve the canonical direct-create behavior.

`agentRuntimeConfig.promptTemplate`, when used during hire, is for role/persona content. Rudder materializes it as the managed instruction bundle's `SOUL.md`. Write it as a durable SOUL document with mission, responsibilities, boundaries, decision principles, voice, and continuity when the role has ongoing authority. Do not include Rudder's shared operating contract in this field; supported local runtimes inject that contract from code.

### Approval follow-up

```sh
rudder approval get "<approval-id>" --json
rudder approval comment "<approval-id>" --body "<markdown>" --json
rudder approval resubmit "<approval-id>" --payload '{"...":"..."}' --json
rudder approval issues "<approval-id>" --json
```

Notes:

- `approval comment` should use markdown and link the approval, pending agent, and source issue when available
- `approval resubmit` is only for a revision-requested approval; update the payload instead of creating a second hire
- if the run wakes with `RUDDER_APPROVAL_ID`, treat that approval as the first task

## Payload Notes

The `agent hire` payload accepts the same shape as the hire API, including:

- `name` optional; blank or omitted means Rudder assigns a distinct first name
- `role`: one of `ceo`, `cto`, `cmo`, `cfo`, `engineer`, `designer`, `pm`, `qa`, `devops`, `researcher`, `general`
- `title`
- `icon`
- `reportsTo`
- `capabilities`
- `desiredSkills`
- `agentRuntimeType`
- `agentRuntimeConfig`
- `runtimeConfig`
- `budgetMonthlyCents`
- `metadata`
- `sourceIssueId`
- `sourceIssueIds`

`role` is a fixed enum. Do not invent role keys such as `founding_engineer`, `frontend_engineer`, or `reviewer`. Use the closest enum value, then put the specialization in `title`, `capabilities`, and `agentRuntimeConfig.promptTemplate`; for example use `"role": "engineer"` with `"title": "Founding Engineer"`.

Issue linkage rule:

- prefer `sourceIssueId` or `sourceIssueIds` inside the hire payload
- use `approval issues` to inspect the resulting approval links after the server creates them

## Related Commands

Post-hire adjustments use the normal agent and skill surfaces:

```sh
rudder agent get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
rudder agent skills sync "<agent-id>" --desired-skills "<csv>" --json
rudder agent local-cli "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
```
