import { sql } from "drizzle-orm";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createIdentityDb, type IdentityDb } from "./client.js";
import {
  assertApplyConfirmation,
  assertProductionDatabaseUrl,
  assertProductionSupabaseProjectUrl,
  assessLegacyOwnerSnapshot,
  assessSupabaseMigrationHistory,
  migrationSqlSha256,
  ProductionMigrationSafetyError,
  safeMigrationError,
  safeMigrationResult,
  type LegacyOwnerSnapshot,
} from "./production-migration-safety.js";
import {
  advanceSupabaseAuthMigration,
  beginSupabaseAuthMigration,
  bindSupabaseAuthUser,
  getSupabaseAuthMigrationByIdentity,
  recordSupabaseAuthUserCreated,
  type SupabaseAuthMigrationIdentity,
} from "./supabase-auth-binding.js";

type Phase = "preflight" | "prepare-owner" | "verify-owner";

type OwnerRecord = {
  userId: string;
  email: string;
  normalizedEmail: string;
  emailVerified: boolean;
  legacyAccountCount: number;
  legacySessionCount: number;
  legacyDeviceCount: number;
  legacyProviders: Array<{ provider: string; subject: string }>;
};

type AuthUserRecord = {
  id: string;
  emailConfirmed: boolean;
  metadata: Record<string, unknown>;
  activeSessionCount: number;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ProductionMigrationSafetyError(`missing_${name.toLowerCase()}`);
  return value;
}

function parseArguments(argv: readonly string[]): {
  phase: Phase;
  apply: boolean;
} {
  let phase: Phase = "preflight";
  let apply = false;
  for (const argument of argv) {
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument.startsWith("--phase=")) {
      const value = argument.slice("--phase=".length);
      if (!["preflight", "prepare-owner", "verify-owner"].includes(value)) {
        throw new ProductionMigrationSafetyError("invalid_phase");
      }
      phase = value as Phase;
      continue;
    }
    throw new ProductionMigrationSafetyError("invalid_argument");
  }
  if (phase === "preflight" && apply) {
    throw new ProductionMigrationSafetyError("preflight_is_read_only");
  }
  return { phase, apply };
}

function rowsOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) {
    throw new ProductionMigrationSafetyError("database_result_invalid");
  }
  return value as T[];
}

async function readMigrationHistory(db: IdentityDb): Promise<string[]> {
  try {
    const rows = await db.execute(sql`
      select name
      from supabase_migrations.schema_migrations
      where name in (
        'rudder_identity_base',
        'rudder_identity_runtime_role',
        'bind_device_refresh_client',
        'supabase_auth_binding',
        'credential_revocation_intent',
        'auth_session_verifier',
        'auth_session_verifier_isolation'
      )
      order by version
    `);
    return rowsOf<{ name: string }>(rows).map((row) => row.name);
  } catch (error) {
    const candidate =
      error && typeof error === "object"
        ? (error as { code?: unknown; cause?: { code?: unknown } })
        : undefined;
    if (
      candidate?.code === "42P01" ||
      candidate?.cause?.code === "42P01"
    ) {
      throw new ProductionMigrationSafetyError(
        "supabase_migration_history_missing",
      );
    }
    throw error;
  }
}

async function migrationDigests(): Promise<Record<string, string>> {
  const migrationsDirectory = new URL("./migrations/", import.meta.url);
  const entries = [
    ["0002_supabase_auth_binding", "0002_supabase_auth_binding.sql"],
    [
      "0003_credential_revocation_intent",
      "0003_credential_revocation_intent.sql",
    ],
    ["0004_auth_session_verifier", "0004_auth_session_verifier.sql"],
    [
      "0005_auth_session_verifier_isolation",
      "0005_auth_session_verifier_isolation.sql",
    ],
  ] as const;
  return Object.fromEntries(
    await Promise.all(
      entries.map(async ([name, filename]) => [
        name,
        migrationSqlSha256(
          await readFile(fileURLToPath(new URL(filename, migrationsDirectory)), "utf8"),
        ),
      ]),
    ),
  );
}

async function readOwner(
  db: IdentityDb,
  ownerUserId: string,
): Promise<OwnerRecord> {
  const rows = rowsOf<{
    user_id: string;
    email: string;
    normalized_email: string;
    email_verified: boolean;
    account_count: number;
    session_count: number;
    device_count: number;
    providers: unknown;
  }>(await db.execute(sql`
    select
      u.id as user_id,
      u.email,
      ae.normalized_email,
      u.email_verified,
      (select count(*)::integer from rudder_identity.account a where a.user_id = u.id)
        as account_count,
      (select count(*)::integer from rudder_identity.session s where s.user_id = u.id)
        as session_count,
      (select count(*)::integer from rudder_identity.identity_device d where d.user_id = u.id)
        as device_count,
      (
        select coalesce(
          jsonb_agg(
            jsonb_build_object('provider', a.provider_id, 'subject', a.account_id)
            order by a.provider_id
          ),
          '[]'::jsonb
        )
        from rudder_identity.account a
        where a.user_id = u.id
      ) as providers
    from rudder_identity."user" u
    join rudder_identity.account_email ae
      on ae.user_id = u.id
      and ae.is_primary = true
      and ae.verified_at is not null
    where u.id = ${ownerUserId}
  `));
  if (rows.length !== 1) {
    throw new ProductionMigrationSafetyError("legacy_owner_not_unique");
  }
  const row = rows[0]!;
  if (!Array.isArray(row.providers)) {
    throw new ProductionMigrationSafetyError("legacy_provider_shape_invalid");
  }
  const providers = row.providers.filter(
    (entry): entry is { provider: string; subject: string } =>
      Boolean(
        entry &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).provider === "string" &&
          typeof (entry as Record<string, unknown>).subject === "string",
      ),
  );
  return {
    userId: row.user_id,
    email: row.email,
    normalizedEmail: row.normalized_email,
    emailVerified: row.email_verified,
    legacyAccountCount: row.account_count,
    legacySessionCount: row.session_count,
    legacyDeviceCount: row.device_count,
    legacyProviders: providers,
  };
}

async function readAuthUsers(
  db: IdentityDb,
  normalizedEmail: string,
): Promise<AuthUserRecord[]> {
  const rows = rowsOf<{
    id: string;
    email_confirmed: boolean;
    metadata: unknown;
    active_session_count: number;
  }>(await db.execute(sql`
    select
      id::text,
      email_confirmed_at is not null as email_confirmed,
      coalesce(raw_app_meta_data, '{}'::jsonb) as metadata,
      (
        select count(*)::integer
        from auth.sessions s
        where s.user_id = auth.users.id
          and (s.not_after is null or s.not_after > now())
      ) as active_session_count
    from auth.users
    where lower(btrim(email)) = ${normalizedEmail}
      and deleted_at is null
  `));
  return rows.map((row) => ({
    id: row.id,
    emailConfirmed: row.email_confirmed,
    metadata:
      row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
    activeSessionCount: row.active_session_count,
  }));
}

async function readIdentityCounts(
  db: IdentityDb,
  identity: SupabaseAuthMigrationIdentity,
): Promise<{ bindingCount: number; ledgerCount: number }> {
  const rows = rowsOf<{ binding_count: number; ledger_count: number }>(
    await db.execute(sql`
      select
        (
          select count(*)::integer
          from rudder_identity.supabase_auth_user_binding
          where rudder_user_id = ${identity.rudderUserId}
             or normalized_email = lower(btrim(${identity.email}))
        ) as binding_count,
        (
          select count(*)::integer
          from rudder_identity.supabase_auth_migration_ledger
          where rudder_user_id = ${identity.rudderUserId}
             or normalized_email = lower(btrim(${identity.email}))
        ) as ledger_count
    `),
  );
  return {
    bindingCount: rows[0]?.binding_count ?? 0,
    ledgerCount: rows[0]?.ledger_count ?? 0,
  };
}

function assertAuthUserMarker(
  authUser: AuthUserRecord,
  identity: SupabaseAuthMigrationIdentity,
): void {
  if (
    authUser.metadata.rudder_migration_batch !== identity.migrationBatch ||
    authUser.metadata.rudder_legacy_subject !== identity.rudderUserId
  ) {
    throw new ProductionMigrationSafetyError("auth_user_marker_mismatch");
  }
}

async function createAuthUser(
  projectUrl: string,
  secretKey: string,
  identity: SupabaseAuthMigrationIdentity,
): Promise<string> {
  const response = await fetch(new URL("/auth/v1/admin/users", projectUrl), {
    method: "POST",
    headers: {
      apikey: secretKey,
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: identity.email,
      email_confirm: true,
      app_metadata: {
        rudder_migration_batch: identity.migrationBatch,
        rudder_legacy_subject: identity.rudderUserId,
      },
    }),
  });
  if (!response.ok) {
    throw new ProductionMigrationSafetyError(
      `supabase_admin_create_failed_${response.status}`,
    );
  }
  const body: unknown = await response.json();
  const id =
    body && typeof body === "object"
      ? (body as Record<string, unknown>).id
      : undefined;
  if (typeof id !== "string") {
    throw new ProductionMigrationSafetyError(
      "supabase_admin_response_invalid",
    );
  }
  return id;
}

function legacySnapshot(
  owner: OwnerRecord,
  authUserCount: number,
  identityCounts: { bindingCount: number; ledgerCount: number },
): LegacyOwnerSnapshot {
  return {
    legacyUserCount: 1,
    verifiedEmailCount: owner.emailVerified ? 1 : 0,
    legacyAccountCount: owner.legacyAccountCount,
    legacySessionCount: owner.legacySessionCount,
    legacyDeviceCount: owner.legacyDeviceCount,
    authUserCount,
    bindingCount: identityCounts.bindingCount,
    ledgerCount: identityCounts.ledgerCount,
    malformedEmailCount:
      owner.normalizedEmail === owner.normalizedEmail.trim().toLowerCase() &&
      owner.normalizedEmail === owner.email.trim().toLowerCase()
        ? 0
        : 1,
    legacyProviders: owner.legacyProviders.map((item) => item.provider),
  };
}

function assertLegacyCountsPreserved(
  before: LegacyOwnerSnapshot,
  after: LegacyOwnerSnapshot,
): void {
  for (const field of [
    "legacyUserCount",
    "verifiedEmailCount",
    "legacyAccountCount",
    "legacySessionCount",
    "legacyDeviceCount",
  ] as const) {
    if (before[field] !== after[field]) {
      throw new ProductionMigrationSafetyError("legacy_data_changed");
    }
  }
}

async function prepareOwner(
  db: IdentityDb,
  input: {
    apply: boolean;
    ownerUserId: string;
    migrationBatch: string;
    projectUrl?: string;
    secretKey?: string;
  },
): Promise<Record<string, unknown>> {
  const owner = await readOwner(db, input.ownerUserId);
  const identity = {
    migrationBatch: input.migrationBatch,
    rudderUserId: owner.userId,
    email: owner.normalizedEmail,
  };
  const authUsers = await readAuthUsers(db, owner.normalizedEmail);
  const identityCounts = await readIdentityCounts(db, identity);
  const before = legacySnapshot(owner, authUsers.length, identityCounts);
  const action = assessLegacyOwnerSnapshot(before);
  if (!input.apply) {
    return safeMigrationResult({
      phase: "prepare-owner",
      dryRun: true,
      gate: "ready",
      nextAction: action,
      counts: {
        legacyUsers: before.legacyUserCount,
        legacyAccounts: before.legacyAccountCount,
        legacySessions: before.legacySessionCount,
        legacyDevices: before.legacyDeviceCount,
        authUsers: before.authUserCount,
        bindings: before.bindingCount,
        ledgerRows: before.ledgerCount,
      },
    });
  }

  await beginSupabaseAuthMigration(db, identity);
  let authUser = authUsers[0];
  if (!authUser) {
    if (!input.projectUrl || !input.secretKey) {
      throw new ProductionMigrationSafetyError(
        "supabase_admin_credentials_required",
      );
    }
    const authUserId = await createAuthUser(
      input.projectUrl,
      input.secretKey,
      identity,
    );
    const refreshed = await readAuthUsers(db, owner.normalizedEmail);
    const createdAuthUser = refreshed.find(
      (candidate) => candidate.id === authUserId,
    );
    if (!createdAuthUser) {
      throw new ProductionMigrationSafetyError(
        "created_auth_user_not_observable",
      );
    }
    authUser = createdAuthUser;
  }
  assertAuthUserMarker(authUser, identity);
  await recordSupabaseAuthUserCreated(db, {
    ...identity,
    authUserId: authUser.id,
  });
  await bindSupabaseAuthUser(db, { ...identity, authUserId: authUser.id });

  const afterOwner = await readOwner(db, input.ownerUserId);
  const afterAuthUsers = await readAuthUsers(db, owner.normalizedEmail);
  const afterCounts = await readIdentityCounts(db, identity);
  const after = legacySnapshot(
    afterOwner,
    afterAuthUsers.length,
    afterCounts,
  );
  assertLegacyCountsPreserved(before, after);
  if (
    after.authUserCount !== 1 ||
    after.bindingCount !== 1 ||
    after.ledgerCount !== 1
  ) {
    throw new ProductionMigrationSafetyError("owner_binding_not_unique");
  }
  return safeMigrationResult({
    phase: "prepare-owner",
    dryRun: false,
    gate: "bound",
    nextAction: "otp_reauthenticate_and_link_providers",
    counts: {
      legacyUsers: after.legacyUserCount,
      legacyAccounts: after.legacyAccountCount,
      legacySessions: after.legacySessionCount,
      legacyDevices: after.legacyDeviceCount,
      authUsers: after.authUserCount,
      bindings: after.bindingCount,
      ledgerRows: after.ledgerCount,
    },
  });
}

async function verifyOwner(
  db: IdentityDb,
  input: {
    apply: boolean;
    ownerUserId: string;
    migrationBatch: string;
  },
): Promise<Record<string, unknown>> {
  const owner = await readOwner(db, input.ownerUserId);
  const identity = {
    migrationBatch: input.migrationBatch,
    rudderUserId: owner.userId,
    email: owner.normalizedEmail,
  };
  const authUsers = await readAuthUsers(db, owner.normalizedEmail);
  const counts = await readIdentityCounts(db, identity);
  const snapshot = legacySnapshot(owner, authUsers.length, counts);
  if (assessLegacyOwnerSnapshot(snapshot) !== "already_bound") {
    throw new ProductionMigrationSafetyError("owner_not_bound");
  }
  const authUser = authUsers[0]!;
  assertAuthUserMarker(authUser, identity);
  if (!authUser.emailConfirmed || authUser.activeSessionCount < 1) {
    throw new ProductionMigrationSafetyError(
      "otp_reauthentication_not_observed",
    );
  }
  const identityRows = rowsOf<{ provider: string; provider_id: string }>(
    await db.execute(sql`
      select provider, provider_id
      from auth.identities
      where user_id = ${authUser.id}::uuid
        and provider in ('google', 'github')
    `),
  );
  const expected = new Map(
    owner.legacyProviders.map((item) => [item.provider, item.subject]),
  );
  if (
    identityRows.length !== 2 ||
    identityRows.some(
      (item) => expected.get(item.provider) !== item.provider_id,
    )
  ) {
    throw new ProductionMigrationSafetyError(
      "provider_subject_verification_failed",
    );
  }
  const ledger = await getSupabaseAuthMigrationByIdentity(db, identity);
  if (!ledger || ledger.authUserId !== authUser.id) {
    throw new ProductionMigrationSafetyError("migration_ledger_mismatch");
  }
  if (!input.apply) {
    return safeMigrationResult({
      phase: "verify-owner",
      dryRun: true,
      gate: "verified",
      nextAction:
        ledger.state === "verified" ? "complete" : "rerun_with_apply",
      counts: {
        authUsers: 1,
        linkedProviders: identityRows.length,
        bindings: counts.bindingCount,
        ledgerRows: counts.ledgerCount,
      },
    });
  }
  await advanceSupabaseAuthMigration(db, {
    ...identity,
    authUserId: authUser.id,
    state: "linked",
  });
  await advanceSupabaseAuthMigration(db, {
    ...identity,
    authUserId: authUser.id,
    state: "verified",
  });
  return safeMigrationResult({
    phase: "verify-owner",
    dryRun: false,
    gate: "verified",
    nextAction: "complete",
    counts: {
      authUsers: 1,
      linkedProviders: identityRows.length,
      bindings: counts.bindingCount,
      ledgerRows: counts.ledgerCount,
    },
  });
}

async function run(): Promise<void> {
  const { phase, apply } = parseArguments(process.argv.slice(2));
  const databaseUrl = requiredEnv("IDENTITY_MIGRATION_DATABASE_URL");
  assertProductionDatabaseUrl(databaseUrl);
  if (apply) {
    assertApplyConfirmation(
      process.env.IDENTITY_MIGRATION_CONFIRM_PROJECT_REF?.trim(),
    );
  }
  const connection = createIdentityDb(databaseUrl);
  try {
    const migrationHistory = assessSupabaseMigrationHistory(
      await readMigrationHistory(connection.db),
    );
    if (phase === "preflight") {
      console.log(
        JSON.stringify(
          safeMigrationResult({
            phase,
            dryRun: true,
            gate: migrationHistory.state,
            nextAction: migrationHistory.nextMigration
              ? `apply_${migrationHistory.nextMigration}`
              : "prepare_owner",
            migrationDigests: await migrationDigests(),
          }),
        ),
      );
      return;
    }
    if (migrationHistory.state !== "complete") {
      throw new ProductionMigrationSafetyError(
        "account_schema_migrations_incomplete",
      );
    }
    const ownerUserId = requiredEnv("IDENTITY_LEGACY_OWNER_USER_ID");
    const migrationBatch =
      process.env.IDENTITY_MIGRATION_BATCH?.trim() ??
      "rudder-account-production-cutover-v1";
    const result =
      phase === "prepare-owner"
        ? await prepareOwner(connection.db, {
            apply,
            ownerUserId,
            migrationBatch,
            projectUrl: apply
              ? assertProductionSupabaseProjectUrl(
                  requiredEnv("IDENTITY_SUPABASE_URL"),
                ).origin
              : undefined,
            secretKey: apply
              ? requiredEnv("IDENTITY_SUPABASE_SECRET_KEY")
              : undefined,
          })
        : await verifyOwner(connection.db, {
            apply,
            ownerUserId,
            migrationBatch,
          });
    console.log(JSON.stringify(result));
  } finally {
    await connection.close();
  }
}

run().catch((error: unknown) => {
  console.error(JSON.stringify(safeMigrationError(error)));
  process.exitCode = 1;
});
