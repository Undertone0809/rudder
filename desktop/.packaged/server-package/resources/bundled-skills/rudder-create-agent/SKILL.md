---
name: rudder-create-agent
description: Create new agents in Rudder through the `rudder` CLI with governance-aware hiring. Use when you need to inspect adapter configuration options, compare existing agent configs, draft a new agent prompt/config, and submit a hire request.
---

# Rudder Create Agent Skill

Use this skill when you are asked to hire or create an agent in Rudder.

## Preconditions

You need either:

- board access, or
- agent permission `canCreateAgents=true` in your org

If you do not have this permission, escalate to your CEO or board.

This workflow is **CLI-first**.

- Use `rudder ... --json` for structured reads and mutations.
- Use `references/cli-reference.md` as the canonical command catalog for this skill.
- Treat `references/api-reference.md` as internal/debug/compatibility documentation, not the normal runtime interface.
- Do not create agent directories, instruction files, or org metadata manually as a fallback.
- If CLI auth is unavailable in a heartbeat run, stop and report the auth problem instead of mutating the filesystem.

## Workflow

1. Confirm identity and organization context.

```sh
rudder agent me --json
```

If this returns `{"error":"Agent authentication required"}`, treat it as a run-auth failure:

- do not ask for `RUDDER_API_KEY` inside the heartbeat
- do not fall back to manual filesystem creation
- stop and report that injected agent authentication is missing or invalid for this run

2. Discover available adapter configuration docs for this Rudder instance.

```sh
rudder agent config index
```

3. Read adapter-specific docs for the runtime you plan to use.

```sh
rudder agent config doc codex_local
rudder agent config doc claude_local
```

4. Compare existing agents and redacted configurations in your organization.

```sh
rudder agent list --org-id "$RUDDER_ORG_ID" --json
rudder agent config list --org-id "$RUDDER_ORG_ID" --json
rudder agent config get "<agent-id>" --json
```

5. Discover allowed agent icons and pick one that matches the role.

```sh
rudder agent icons
```

6. If the role needs organization skills on day one, inspect or import them before hiring.

```sh
rudder skill list --org-id "$RUDDER_ORG_ID" --json
rudder skill get "<skill-id>" --org-id "$RUDDER_ORG_ID" --json
rudder skill file "<skill-id>" --org-id "$RUDDER_ORG_ID" --path SKILL.md --json
rudder skill import --org-id "$RUDDER_ORG_ID" --source "<source>" --json
rudder skill scan-local --org-id "$RUDDER_ORG_ID" --roots "<csv>" --json
rudder skill scan-projects --org-id "$RUDDER_ORG_ID" --project-ids "<csv>" --workspace-ids "<csv>" --json
```

7. Draft the hire payload.

Required thinking:

- role / title / optional `name`
- `name` is optional; if omitted, Rudder assigns a distinct personal name automatically
- `icon` from `rudder agent icons`
- reporting line (`reportsTo`)
- adapter type
- optional `desiredSkills` from the organization skill library
- adapter and runtime config aligned to this environment
- capabilities
- run prompt in adapter config (`promptTemplate` where applicable)
- source issue linkage (`sourceIssueId` or `sourceIssueIds`) when this hire came from an issue

8. Submit the canonical hire request.

```sh
rudder agent hire --org-id "$RUDDER_ORG_ID" --payload '{
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "<ceo-agent-id>",
  "capabilities": "Owns technical roadmap, architecture, staffing, execution",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "agentRuntimeType": "codex_local",
  "agentRuntimeConfig": {"cwd": "/abs/path/to/repo", "model": "o4-mini"},
  "runtimeConfig": {"heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true}},
  "sourceIssueId": "<issue-id>"
}' --json
```

`agent hire` is the canonical surface because it preserves the real server behavior:

- if the organization does not require approval, it creates the agent directly and returns `"approval": null`
- if the organization requires approval, it creates the agent in `pending_approval` and returns both `agent` and `approval`

Do **not** substitute `rudder approval create --type hire_agent` for this step unless you are doing low-level debugging. That bypasses the canonical direct-create vs pending-approval behavior.

9. Handle governance state.

If the hire response includes `approval`, monitor and discuss on the approval thread:

```sh
rudder approval get "<approval-id>" --json
rudder approval comment "<approval-id>" --body "## CTO hire request submitted

- Approval: [<approval-id>](/<prefix>/messenger/approvals/<approval-id>)
- Pending agent: [<agent-ref>](/<prefix>/agents/<agent-url-key-or-id>)
- Source issue: [<issue-ref>](/<prefix>/issues/<issue-identifier-or-id>)

Updated prompt and adapter config per board feedback." --json
rudder approval resubmit "<approval-id>" --payload '{"title":"Revised title","agentRuntimeConfig":{"cwd":"/abs/path/to/repo","model":"o4-mini"}}' --json
rudder approval issues "<approval-id>" --json
```

When the board approves, you may be woken with `RUDDER_APPROVAL_ID`:

```sh
rudder approval get "$RUDDER_APPROVAL_ID" --json
rudder approval issues "$RUDDER_APPROVAL_ID" --json
```

For each linked issue, either:

- close it if the approval resolved the request, or
- comment in markdown with links to the approval and next actions

## Quality Bar

Before sending a hire request:

- if the role needs skills, make sure they already exist in the org library or import them first using the Rudder org-skills workflow
- reuse proven config patterns from related agents where possible
- set a concrete `icon` from `rudder agent icons` so the new hire is identifiable in org and task views
- avoid secrets in plain text unless required by adapter behavior
- ensure the reporting line is correct and in-org
- ensure the prompt is role-specific and operationally scoped
- prefer `sourceIssueId` or `sourceIssueIds` in the hire payload instead of manual approval linking
- if board requests revision, update the payload and resubmit through the approval flow
- do not report success unless `rudder agent hire` itself succeeded and you can cite the returned `agent.id` or `approval.id`
- creating local directories or instruction files is not evidence that an agent exists in Rudder

For canonical command syntax and examples, read:
`references/cli-reference.md`

For low-level route shapes and underlying compatibility endpoints, read:
`references/api-reference.md`
