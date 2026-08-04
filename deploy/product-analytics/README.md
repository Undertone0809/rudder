# Product analytics collector deployment

This package runs the telemetry collector as a separate service and database.
It is intentionally separate from the Rudder app database and from Identity.
The compose file is a deployment template and local integration harness; it is
not production authorization or evidence of a deployed `telemetry.rudderhq.dev`.

## Required provisioning

Before starting the stack, provision the PostgreSQL roles in the target
private database:

- `telemetry_migrator`: runs only the checked-in telemetry migrations;
- `rudder_analytics_collector`: INSERT/SELECT/UPDATE only for ingest state;
- `rudder_analytics_rollup`: SELECT raw events and maintain rollups/retention;
- `rudder_analytics_reader`: SELECT aggregate-only report tables.

The compose migration step applies only the three telemetry migrations in this
deployment (`0140` through `0142`); it never bootstraps the application schema.
The collector, rollup, and report connections are separate. The report route
reads installation daily rollups and thresholded aggregates only, while raw
events remain behind the maintenance role.

The migrations grant capabilities when these roles exist but do not create,
rotate, or delete roles. The collector startup checks `current_user`, schema
usage, and the expected role, and fails closed if the boundary is wrong.

The Identity deployment must be separately configured with the matching
Ed25519 private key, issuer, key id, subject secret, and consent-sync URL. Only
the public key belongs in this service. The report, revoke, consent-sync, and
optional anonymous deployment credentials must be independent random secrets.

## Local smoke

```sh
cp deploy/product-analytics/.env.example deploy/product-analytics/.env
# Replace every `replace-with-*` value before starting.
docker compose --env-file deploy/product-analytics/.env \
  -f deploy/product-analytics/docker-compose.yml up --build
curl http://127.0.0.1:4318/healthz
```

The compose stack only proves that the image, migrations, role boundary, and
liveness route can be started with a real PostgreSQL. It does not prove a
signed-in Identity assertion, an account-linked consent grant, proxy logging
policy, DNS/TLS, backups, or an external rollout.

## Proxy and operations gate

Put the collector behind a reverse proxy that strips or truncates client IP
and User-Agent before application logs, never logs request bodies, and retains
network metadata for no more than seven days. Rate-limit by installation and a
transient proxy key. Keep the collector and maintenance connections private;
only the aggregate report endpoint may be exposed to the report client.

Run the report client with an aggregate-only report secret:

```sh
PRODUCT_ANALYTICS_REPORT_URL=https://telemetry.example/api/analytics/v1/report \
PRODUCT_ANALYTICS_REPORT_SECRET="$TELEMETRY_REPORT_SECRET" \
pnpm analytics:report -- --from 2026-08-03T00:00:00Z --to 2026-08-10T00:00:00Z
```

Do not copy raw events, installation identifiers, account subjects, or
collector database dumps into Uranus or source control. An Uranus integration
must consume only the JSON returned by this aggregate endpoint and must record
window, timezone, freshness, threshold, and coverage alongside the values.

## Rollout and rollback

1. Apply migrations to a private database and verify all four roles with
   `SELECT current_user`, `has_schema_privilege`, and table grants.
2. Deploy the collector with a non-public preview hostname and verify
   `/healthz`, Identity consent sync, assertion acceptance, duplicate ACK, and
   revoke/old-epoch rejection using a disposable installation.
3. Configure proxy redaction and inspect logs for one full observation window.
4. Enable anonymous telemetry only with an explicit deployment credential and
   an owner-granted local consent; leave account-linked mode off for canary.
5. Watch rejected, duplicate, late, delivery-lag, dead-letter, and privacy
   threshold metrics before widening rollout.
6. Roll back by disabling new outbox claims/scheduler and rejecting new schema
   versions. Keep local facts and migrations intact; do not delete the
   workspace database or force-push the release.

Production remains `Operational Rollout Pending` until these external checks
have terminal evidence.
