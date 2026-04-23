# Create-Agent Benchmarks

Repo-tracked benchmark cases for the create-agent workflow.

## Layout

- `cases/*.json` — individual benchmark cases
- `sets/*.json` — named case groups for batch runs

## Run

```sh
pnpm --filter @rudder/cli dev benchmark create-agent run approval-cto-under-ceo \
  --org-id <org-id> \
  --benchmark-agent-id <agent-id> \
  --fixture ceo=<ceo-agent-id>
```

Batch:

```sh
pnpm --filter @rudder/cli dev benchmark create-agent run-set smoke \
  --org-id <org-id> \
  --benchmark-agent-id <agent-id> \
  --fixture ceo=<ceo-agent-id>
```
