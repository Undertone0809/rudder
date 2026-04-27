# Rudder Create Agent API Reference

Internal/debug reference for the bundled `rudder-create-agent` skill.

- Normal runtime execution should follow the CLI-first workflow in `../SKILL.md`.
- The canonical command catalog lives in `cli-reference.md`.
- Keep this document for route-level debugging, compatibility work, and payload-shape inspection.

## CLI-to-API Mapping

| CLI command | Primary route |
| --- | --- |
| `rudder agent config index` | `GET /llms/agent-configuration.txt` |
| `rudder agent config doc <agentRuntimeType>` | `GET /llms/agent-configuration/:agentRuntimeType.txt` |
| `rudder agent icons` | `GET /llms/agent-icons.txt` |
| `rudder agent config list --org-id <orgId>` | `GET /api/orgs/:orgId/agent-configurations` |
| `rudder agent config get <agentId>` | `GET /api/agents/:agentId/configuration` |
| `rudder agent hire --org-id <orgId> --payload <json>` | `POST /api/orgs/:orgId/agent-hires` |
| `rudder approval get <approvalId>` | `GET /api/approvals/:approvalId` |
| `rudder approval comment <approvalId> --body <text>` | `POST /api/approvals/:approvalId/comments` |
| `rudder approval resubmit <approvalId> [--payload <json>]` | `POST /api/approvals/:approvalId/resubmit` |
| `rudder approval issues <approvalId>` | `GET /api/approvals/:approvalId/issues` |

## Reflection Endpoints

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:agentRuntimeType.txt`
- `GET /llms/agent-icons.txt`

Auth:

- board access, or
- same-org agent auth with `canCreateAgents=true`

These endpoints return plain text. The CLI wraps them directly.

## Configuration Snapshots

- `GET /api/orgs/:orgId/agent-configurations`
- `GET /api/agents/:agentId/configuration`

These responses are redacted snapshots for comparison and reuse.

Representative shape:

```json
{
  "id": "uuid",
  "orgId": "uuid",
  "name": "CTO",
  "role": "cto",
  "title": "Chief Technology Officer",
  "status": "idle",
  "reportsTo": "uuid-or-null",
  "agentRuntimeType": "codex_local",
  "agentRuntimeConfig": {
    "cwd": "/absolute/path",
    "model": "o4-mini"
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": true,
      "intervalSec": 300,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 3
    }
  },
  "permissions": {
    "canCreateAgents": true
  },
  "updatedAt": "2026-04-19T12:00:00.000Z"
}
```

## `POST /api/orgs/:orgId/agent-hires`

Canonical hire route used by `rudder agent hire`.

Request body:

```json
{
  "role": "cto",
  "title": "Chief Technology Officer",
  "icon": "crown",
  "reportsTo": "uuid-or-null",
  "capabilities": "Owns architecture and engineering execution",
  "desiredSkills": ["vercel-labs/agent-browser/agent-browser"],
  "agentRuntimeType": "codex_local",
  "agentRuntimeConfig": {
    "cwd": "/absolute/path",
    "model": "o4-mini",
    "promptTemplate": "You are CTO..."
  },
  "runtimeConfig": {
    "heartbeat": {
      "enabled": true,
      "intervalSec": 300,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 3
    }
  },
  "budgetMonthlyCents": 0,
  "sourceIssueId": "uuid-or-null",
  "sourceIssueIds": ["uuid-1", "uuid-2"]
}
```

Response when approval is required:

```json
{
  "agent": {
    "id": "uuid",
    "status": "pending_approval"
  },
  "approval": {
    "id": "uuid",
    "type": "hire_agent",
    "status": "pending",
    "payload": {
      "desiredSkills": ["vercel-labs/agent-browser/agent-browser"]
    }
  }
}
```

Response when approval is not required:

```json
{
  "agent": {
    "id": "uuid",
    "status": "idle"
  },
  "approval": null
}
```

Important notes:

- `name` is optional; if omitted or blank, Rudder assigns a distinct first name automatically
- `desiredSkills` accepts organization skill ids, canonical keys, or a unique slug; the server resolves and stores canonical organization skill keys
- `sourceIssueId` and `sourceIssueIds` are the canonical way to link the hire back to originating issues
- this route is preferred over creating `hire_agent` approvals manually because it preserves the organization's approval policy

## Approval Lifecycle

Relevant routes:

- `GET /api/approvals/:approvalId`
- `POST /api/approvals/:approvalId/comments`
- `POST /api/approvals/:approvalId/resubmit`
- `GET /api/approvals/:approvalId/issues`

Statuses:

- `pending`
- `revision_requested`
- `approved`
- `rejected`
- `cancelled`

For hire approvals:

- approved: linked agent transitions `pending_approval -> idle`
- rejected: linked agent is terminated

## Safety Notes

- Config read APIs redact obvious secrets.
- `pending_approval` agents cannot run heartbeats, receive assignments, or create keys.
- All hire and approval actions are logged in activity for auditability.
- Use markdown in issue and approval comments and include links to the approval, agent, and source issue.
