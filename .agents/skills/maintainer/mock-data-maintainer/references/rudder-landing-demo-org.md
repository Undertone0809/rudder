# Rudder Landing Demo Org

This is the canonical high-quality Rudder mock dataset for local screenshots,
landing proof shots, README images, and product demos.

## Script

Canonical implementation:

```bash
LANDING_SHOTS_SKIP_CAPTURE=1 LANDING_SHOTS_HOLD_OPEN=1 \
node cli/node_modules/tsx/dist/cli.mjs \
.agents/skills/maintainer/mock-data-maintainer/scripts/capture-landing-proof-shots.ts
```

Existing package command for full capture:

```bash
pnpm landing:shots
```

Existing package command for seed-only local screenshot prep:

```bash
pnpm mock:data:landing
```

Legacy direct wrapper:

```bash
node cli/node_modules/tsx/dist/cli.mjs scripts/capture-landing-proof-shots.ts
```

The script boots an isolated Rudder instance under `/tmp/rudder-landing-proof-shots`,
creates a local config, starts the server, seeds the demo org, and optionally
captures proof-shot screenshots. Use the `LANDING_SHOTS_SKIP_CAPTURE=1` and
`LANDING_SHOTS_HOLD_OPEN=1` flags when the user wants seeded data for manual
local screenshots.

## Data Shape

The landing demo org is a launch-week Rudder organization.

It includes:

- 1 organization: `Rudder`
- 1 organization-level goal: ship the desktop-first public beta
- 6 projects:
  - `public-beta-launch`
  - `desktop-reliability`
  - `onboarding-activation`
  - `enterprise-readiness`
  - `release-operations`
  - `messenger-experience`
- 6 agents:
  - CEO
  - Founding Engineer
  - Design Engineer
  - Release Engineer
  - Growth Lead
  - Support Ops
- 19 issues across done, in review, in progress, blocked, todo, and backlog
- 2 approvals:
  - public pricing page publish review
  - launch support engineer hiring review
- 1 chat conversation for launch intake and chat-created issue proof
- heartbeat runs for active agents
- issue comments and issue documents
- cost events and finance events across multiple providers
- activity log timestamps distributed across one launch-week timeline

## Story Spine

The org is preparing a desktop-first public beta. The board is coordinating
launch pages, desktop reliability, onboarding, enterprise readiness, release
operations, and messenger workflows through agent work loops.

The data should communicate:

- Rudder is a control plane for agent teams
- issues are actively moving through execution and review
- approvals and budgets matter for governed work
- chat can turn operator requests into durable issues
- costs and heartbeat runs are visible operational signals
- work spans multiple projects, not a single toy checklist

## Best Uses

Use this dataset when the user asks for:

- a screenshot-ready local Rudder org
- mock data for landing page proof shots
- a believable product demo
- a dense local org for manual UI inspection
- a user-facing example of how Rudder coordinates agent work

If the user asks for screenshot capture, seed with this dataset and then use
`landing-proof-shots-maintainer` to capture full-page app-style screenshots.

## Routes Worth Opening

After the script prints `baseUrl` and the org prefix, useful routes include:

- `/<org-prefix>/dashboard`
- `/<org-prefix>/chat/<chat-id>`
- `/<org-prefix>/issues`
- `/<org-prefix>/issues?groupBy=project`
- `/<org-prefix>/messenger/approvals/<approval-id>`
- `/<org-prefix>/heartbeats`
- `/<org-prefix>/costs`
- `/<org-prefix>/org`

Prefer `127.0.0.1` if browser automation has trouble with `localhost`.

## Modification Rules

- Keep the launch-week story coherent across every page.
- Add new issues only if they strengthen a specific screenshot or test surface.
- Preserve cross-project density for issue-list views.
- Keep chat issue creation deterministic through the stub runtime.
- Keep all generated files and screenshots outside the repo tree.
