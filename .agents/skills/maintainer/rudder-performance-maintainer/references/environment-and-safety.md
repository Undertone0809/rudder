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

## Persistent Dev Benchmark Organization

For non-destructive, production-shaped checks, prefer the reusable dev-only
organization:

- name: `Rudder Performance Lab`
- URL key: `rudder-performance-lab`
- expected environment: `127.0.0.1:3100`, `localEnv=dev`

Treat it as a persistent benchmark fork, not as a real user organization and
not as a daily disposable seed. Verify the dev health response and organization
identity before every use because its database identifier may also exist in a
different local instance. In reports and new docs, call its source only the
`production sizing reference`; do not repeat the source organization's product
name.

Reuse the existing fork by default. Refresh it only when the user explicitly
requests a refresh or when schema compatibility makes the existing fixture
invalid. A refresh must be idempotent and preserve these rules:

- the source instance is read-only;
- credentials, API keys, secrets, OAuth data, integration controls, queued
  wakeups, and recovery backups are excluded;
- automation triggers in the benchmark fork remain disabled;
- Library parity includes both database catalog rows and the referenced
  workspace files;
- Library paths such as `.ssh`, `.kube`, `.docker`, `.vercel`, `.aws`,
  `.npmrc`, `.gitconfig`, and `.env` are excluded;
- dev-generated benchmark evidence is not overwritten unless the refresh
  explicitly requires replacement.

Use a separate isolated synthetic organization for destructive pressure,
mutation-heavy concurrency, or tests that intentionally corrupt state.

## Implementation Authority

An audit request authorizes measurement and recommendations, not source edits,
merges, releases, or destructive cleanup. A user request to optimize/fix
authorizes implementation and verification, but release remains separately
authorized.

## Cleanup

Stop owned disposable processes gracefully, remove only exact temporary roots,
and verify no producer survives. If cleanup classification is uncertain, use
`rudder-workspace-hygiene-maintainer` for audit and report the blockage.
