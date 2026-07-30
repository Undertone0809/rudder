# Migrations And Future Promotion

App Builder V1 does not expose immutable release promotion or production
rollback in the product UI. The practices below are guidance for a future
increment or for explicit application-specific work. Do not tell the operator
that Rudder has promoted a formal release.

## Rehearse

1. Create a SQLite backup through `pnpm data:snapshot`.
2. Copy the snapshot into the run's development data location.
3. Apply committed migrations to that copy.
4. Run integrity checks, row-count checks, tests, build, and Browser workflows.
5. Preserve the migration result and rollback point in the Run evidence.

## Promote

Promotion is a distinct accepted transition:

1. Lock the verified source revision and scaffold revision.
2. Stop writes to the formal app.
3. Create a fresh backup of formal data.
4. Apply the already-rehearsed migration.
5. Build and start the formal version.
6. Verify health and one bounded smoke workflow.
7. Switch the App's formal release pointer only after all checks pass.

If migration, build, readiness, or smoke verification fails, keep the previous
formal version and database active or restore the pre-promotion backup. Never
silently continue with a partially migrated database.

## Rollback

Rollback restores the previous source/build version. Restore a database backup
only when the migration is not safely reversible. Explain that restoring the
backup also removes writes made after that snapshot.
