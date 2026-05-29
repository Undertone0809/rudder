# Rudder Create Agent CLI Reference

Canonical CLI contract for the bundled `rudder-create-agent` skill. Prefer these commands over direct `/api` calls.

## Defaults

- All commands support `--json`.
- `--org-id` defaults to `RUDDER_ORG_ID` when relevant.
- Mutating commands attach `RUDDER_RUN_ID` automatically when available.
- `agent config index` and `agent config doc` print plain text by default. With `--json`, they emit that text as a JSON string.

## Fast Path

For a simple helper-agent request where the issue already supplies the name,
role, runtime, skills, and capability, this is the minimal canonical flow.
Replace every placeholder with the issue-requested values before running the
command. Do not silently default the helper to Codex, `general`, or
`rudder/rudder`; inspect existing agent configs or the adapter docs when the
request does not specify those choices:

```sh
"${RUDDER_CLI:-rudder}" agent me --json
"${RUDDER_CLI:-rudder}" agent hire --org-id "$RUDDER_ORG_ID" --payload '{
  "name": "<issue-requested agent name>",
  "role": "<issue-requested agent role>",
  "title": "<issue-requested agent title or name>",
  "capabilities": "<issue-requested agent capabilities>",
  "desiredSkills": ["<issue-requested org skill ref>"],
  "agentRuntimeType": "<issue-requested runtime type>",
  "agentRuntimeConfig": {},
  "sourceIssueId": "'"$RUDDER_TASK_ID"'"
}' --json
printf '%s\n' "created/requested helper agent <agent-id-or-name>; approval <approval-id/status if present>" | "${RUDDER_CLI:-rudder}" issue done "$RUDDER_TASK_ID" --comment-file - --json
```

Use the full discovery flow below when the request omits runtime, role, org
skills, budgets, reporting lines, approval handling, or any runtime
configuration.

## Core CLI Surface

### Identity and discovery

```sh
"${RUDDER_CLI:-rudder}" agent me --json
"${RUDDER_CLI:-rudder}" agent list --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" agent get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" agent config index
"${RUDDER_CLI:-rudder}" agent config doc "<agent-runtime-type>"
"${RUDDER_CLI:-rudder}" agent config list --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" agent config get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
```

Use these in order:

1. `agent me` to verify auth and org context
2. `agent config index` to discover installed runtimes
3. `agent config doc` to read one runtime's required fields and examples
4. `agent list` plus `agent config list/get` to reuse proven patterns from related agents

### Organization skills

```sh
"${RUDDER_CLI:-rudder}" skill list --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
"${RUDDER_CLI:-rudder}" skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
"${RUDDER_CLI:-rudder}" skill scan-local --org-id "$RUDDER_ORG_ID" --roots "<csv>" --json
"${RUDDER_CLI:-rudder}" skill scan-projects --org-id "$RUDDER_ORG_ID" --project-ids "<csv>" --workspace-ids "<csv>" --json
```

Use these before hiring when the new role needs `desiredSkills`.

`desiredSkills` accepts:

- exact organization skill key
- exact organization skill id
- exact slug when it is unique in the organization

### Canonical hire flow

```sh
"${RUDDER_CLI:-rudder}" agent hire --org-id "$RUDDER_ORG_ID" --payload '{
  "role": "<selected role>",
  "title": "<selected title>",
  "reportsTo": "<reports-to-agent-id-or-null>",
  "capabilities": "<selected durable capabilities>",
  "desiredSkills": ["<selected org skill ref>"],
  "agentRuntimeType": "<selected runtime type>",
  "agentRuntimeConfig": {
    "cwd": "<absolute workspace path when required>",
    "model": "<selected model id when required>",
    "promptTemplate": "# SOUL.md -- <selected persona>\n\n<full agent instructions>"
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
"${RUDDER_CLI:-rudder}" approval get "<approval-id>" --json
"${RUDDER_CLI:-rudder}" approval comment "<approval-id>" --body-file "<path>" --json
"${RUDDER_CLI:-rudder}" approval resubmit "<approval-id>" --payload '{"...":"..."}' --json
"${RUDDER_CLI:-rudder}" approval issues "<approval-id>" --json
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
- `icon` optional; omit it for normal hires so Rudder generates a DiceBear Notionists avatar automatically. Only provide an explicit DiceBear reference or uploaded `asset:<uuid>` image avatar reference when the board/UI supplied one.
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
"${RUDDER_CLI:-rudder}" agent get "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
"${RUDDER_CLI:-rudder}" agent skills enable "<agent-id>" "<selection-ref>" --json
"${RUDDER_CLI:-rudder}" agent skills sync "<agent-id>" --desired-skills "<csv>" --json
"${RUDDER_CLI:-rudder}" agent local-cli "<agent-id-or-shortname>" --org-id "$RUDDER_ORG_ID" --json
```
