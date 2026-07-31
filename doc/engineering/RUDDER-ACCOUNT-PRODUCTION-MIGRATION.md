# Rudder Account Production Migration Runbook

This runbook moves the single verified legacy Rudder owner to Supabase Auth
without deleting or rewriting the legacy `user`, `account`, `session`,
`identity_device`, or credential rows. It is deliberately separate from the
normal Drizzle migration command because production records Identity schema
migrations in `supabase_migrations.schema_migrations`.

Do not run `pnpm --filter @rudderhq/identity-db migrate` against the existing
production project. Production has no `rudder_identity.__drizzle_migrations`
baseline, so that command would try to replay `0000`.

## Safety properties

- every command is read-only unless `--apply` is present;
- apply mode requires the direct/session migration URL to use the `postgres`
  role, TLS, and the hard-coded production project
  `qroqfgbaifzeqlygafjr`;
- apply mode also requires
  `IDENTITY_MIGRATION_CONFIRM_PROJECT_REF=qroqfgbaifzeqlygafjr`;
- the Admin API secret and all emails, user IDs, provider subjects, tokens,
  and database credentials are omitted from output;
- an existing Auth user is adopted only when its server-controlled
  `app_metadata` exactly matches the migration batch and legacy subject;
- rerunning prepare or verify is idempotent;
- the runner never inserts into `auth.users` or `auth.identities` directly;
- the runner checks that legacy row counts did not change after binding.

## 1. Freeze and rollback point

1. Freeze Better Auth registration, login mutations, email changes, password
   changes, provider link/unlink, and session minting.
2. Lock the currently deployed Better Auth build SHA.
3. Create an encrypted, off-site logical database dump, including
   `rudder_identity`, `auth`, roles, and `supabase_migrations`.
4. Record immutable counts and checksums for the legacy owner, provider
   accounts, sessions, devices, credentials, and security events.
5. For Stable, upgrade Supabase to Pro and confirm a usable backup point before
   continuing. A Free project is not an acceptable Stable rollback point.

Before the first Supabase-only user is admitted, rollback means redeploying the
locked Better Auth build while leaving the additive 0002/0003/0004/0005 schema and any
created Supabase Auth user in place. Do not delete either identity system.
After a Supabase-only user is admitted, rolling back to Better Auth is
prohibited; use a previous Supabase-compatible build or forward-fix.

## 2. Validate the Supabase migration baseline

Supply credentials through a temporary secret environment, never command-line
arguments or committed `.env` files:

```sh
pnpm --filter @rudderhq/identity-db production:migration-gate
```

`IDENTITY_MIGRATION_DATABASE_URL` is required. It must target
`qroqfgbaifzeqlygafjr`, use the `postgres` role, the direct/session port
`5432`, and `sslmode=require`. Transaction Pooler port `6543` is rejected.

The expected production history is:

1. `rudder_identity_base`
2. `rudder_identity_runtime_role`
3. `bind_device_refresh_client`

The command returns only a state, the next migration name, and SHA-256 digests
for the reviewed SQL artifacts. Stop if it reports a baseline mismatch,
duplicate history, reversed migration order, or
`supabase_migration_history_missing`. A missing Supabase history is not
permission to seed rows manually: first compare the live schema, constraints,
indexes, grants, and migration SQL digests against an isolated production
clone, then add a reviewed reconciliation migration through the Supabase
Management migration operation.

## 3. Apply 0002 through 0005 through Supabase migration history

Use the Supabase Management migration operation, not raw SQL and not the
Drizzle migrator:

1. apply
   `packages/identity-db/src/migrations/0002_supabase_auth_binding.sql`
   with migration name `supabase_auth_binding`;
2. rerun the preflight gate and require `partial` with next migration
   `credential_revocation_intent`;
3. apply
   `packages/identity-db/src/migrations/0003_credential_revocation_intent.sql`
   with migration name `credential_revocation_intent`;
4. rerun the preflight gate and require `partial` with next migration
   `auth_session_verifier`;
5. apply
   `packages/identity-db/src/migrations/0004_auth_session_verifier.sql`
   with migration name `auth_session_verifier`;
6. rerun the preflight gate and require `partial` with next migration
   `auth_session_verifier_isolation`;
7. apply
   `packages/identity-db/src/migrations/0005_auth_session_verifier_isolation.sql`
   with migration name `auth_session_verifier_isolation`;
8. rerun the gate and require `complete` with next action `prepare_owner`.

Apply one migration per transaction. After each apply, verify that all legacy
counts and checksums are unchanged. The SQL is additive, but applying it
outside Supabase migration history is a release blocker because later tooling
could replay it.

Migration 0004 introduces the managed-Auth verifier. Migration 0005 is the
forward-only isolation boundary for installations where 0004 is already in
Supabase migration history: it replaces the verifier safely and removes the
temporary direct grants from migration 0002. After 0005, the runtime role cannot
traverse Supabase's `auth` schema. It may execute only the
`rudder_identity.is_active_auth_session(uuid, uuid)` security-definer function,
which returns a boolean and exposes no session row, refresh token, or user data.

## 4. Dry-run the legacy owner preparation

Set `IDENTITY_LEGACY_OWNER_USER_ID` and, optionally, a stable
`IDENTITY_MIGRATION_BATCH`. Do not echo either value.

```sh
pnpm --filter @rudderhq/identity-db production:migration-gate -- \
  --phase=prepare-owner
```

The production-shaped gate requires exactly one verified owner, one primary
verified normalized email, and exactly one Google plus one GitHub legacy
provider subject. It refuses duplicate Auth users, bindings, or ledger rows.
The expected first result is `create_auth_user`. A retry after an interrupted
Admin call may safely report `adopt_auth_user`, but adoption requires the exact
server metadata marker.

## 5. Create and bind the Supabase Auth user

Add the following only to the temporary migration secret environment:

- `IDENTITY_SUPABASE_URL=https://qroqfgbaifzeqlygafjr.supabase.co`
- `IDENTITY_SUPABASE_SECRET_KEY` with a server-only Supabase secret key
- `IDENTITY_MIGRATION_CONFIRM_PROJECT_REF=qroqfgbaifzeqlygafjr`

Then run:

```sh
pnpm --filter @rudderhq/identity-db production:migration-gate -- \
  --phase=prepare-owner --apply
```

The runner prepares the ledger, creates the user through the Supabase Admin
API only when no exact marked user exists, records the Auth UUID, and persists
the one-to-one Rudder binding. It returns aggregate counts only. The required
result is `gate=bound` and
`nextAction=otp_reauthenticate_and_link_providers`.

If the process stops after an unknown Admin result, do not manually create a
second user. Rerun the dry-run. The runner adopts only a unique email match
whose `app_metadata` contains the exact migration batch and legacy subject;
otherwise it fails closed for manual review.

## 6. Reauthenticate and link providers

Using the real production login surface:

1. complete Email OTP reauthentication for the migrated owner;
2. from that authenticated Supabase account, explicitly link Google;
3. link GitHub;
4. do not create a second account through either OAuth provider.

Dry-run verification:

```sh
pnpm --filter @rudderhq/identity-db production:migration-gate -- \
  --phase=verify-owner
```

The gate requires one confirmed Auth user, an active Supabase session, one
binding and ledger row, and exact Google/GitHub provider-subject equality with
the preserved legacy records. It never prints those values.

After the dry-run reports `gate=verified`, persist the final ledger states:

```sh
pnpm --filter @rudderhq/identity-db production:migration-gate -- \
  --phase=verify-owner --apply
```

The final result must be `nextAction=complete`. Rerunning the command must
produce the same result without adding users, identities, bindings, or ledger
rows.

## 7. Cutover checks

Before admitting traffic:

- `auth.users=1` and the expected linked identities belong to that user;
- the binding points to the unchanged non-UUID Rudder subject;
- all legacy user/account/session/device counts and checksums match the frozen
  snapshot;
- `rudder_identity_app` cannot traverse `auth`; it can only execute
  `rudder_identity.is_active_auth_session(uuid, uuid)`, which returns a boolean;
- `anon` and `authenticated` have no schema usage or table privileges on
  `rudder_identity`, and that schema is absent from Data API exposed schemas;
- Vercel Production has the publishable Supabase key, never the Admin secret;
- old Better Auth data remains retained for the full rollback window.
