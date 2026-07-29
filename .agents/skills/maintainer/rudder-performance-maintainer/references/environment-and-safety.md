# Environment And Safety

## Target Identity

Before reading or writing:

```bash
curl http://127.0.0.1:<port>/api/health
```

Record `instanceId`, `localEnv`, version, runtime owner, API URL, descriptor,
source SHA/build timestamp, and organization.

Do not infer packaged/prod-local identity from a checkout's dev descriptor.
Do not compare installed Desktop numbers to current source without proving the
build identity.

## Read-Only Audits

Some GET endpoints may normalize or clean stale state. Inspect route/service
behavior before calling an endpoint against shared/prod data. Prefer direct
read-only queries or known side-effect-free summary endpoints when strict
read-only behavior matters.

Start with bounded summaries. Large full projections and maximum logs can
materially increase process memory and distort the system being measured.

## Disposable Data

Prefer isolated embedded PostgreSQL and synthetic organizations. Record:

- temporary root and database;
- organization/run IDs;
- processes started/stopped;
- files and screenshots;
- cleanup result or exact retained evidence.

Never delete `~/.rudder`, broad Postgres processes, shared organizations, or
unrelated worktrees to make a benchmark pass.

## Implementation Authority

An audit request authorizes measurement and recommendations, not source edits,
merges, releases, or destructive cleanup. A user request to optimize/fix
authorizes implementation and verification, but release remains separately
authorized.

## Cleanup

Stop owned disposable processes gracefully, remove only exact temporary roots,
and verify no producer survives. If cleanup classification is uncertain, use
`rudder-workspace-hygiene-maintainer` for audit and report the blockage.
