import { createHash } from "node:crypto";

export const RUDDER_PRODUCTION_SUPABASE_PROJECT_REF =
  "qroqfgbaifzeqlygafjr";

export const REQUIRED_SUPABASE_MIGRATION_BASELINE = [
  "rudder_identity_base",
  "rudder_identity_runtime_role",
  "bind_device_refresh_client",
] as const;

export const RUDDER_ACCOUNT_MIGRATIONS = [
  "supabase_auth_binding",
  "credential_revocation_intent",
  "auth_session_verifier",
  "auth_session_verifier_isolation",
] as const;

export type MigrationHistoryAssessment = {
  state: "ready" | "partial" | "complete";
  nextMigration: (typeof RUDDER_ACCOUNT_MIGRATIONS)[number] | null;
};

export class ProductionMigrationSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductionMigrationSafetyError";
  }
}

export function assessSupabaseMigrationHistory(
  migrationNames: readonly string[],
): MigrationHistoryAssessment {
  const counts = new Map<string, number>();
  for (const name of migrationNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const name of [
    ...REQUIRED_SUPABASE_MIGRATION_BASELINE,
    ...RUDDER_ACCOUNT_MIGRATIONS,
  ]) {
    if ((counts.get(name) ?? 0) > 1) {
      throw new ProductionMigrationSafetyError("duplicate_migration_history");
    }
  }
  if (
    REQUIRED_SUPABASE_MIGRATION_BASELINE.some(
      (name) => (counts.get(name) ?? 0) !== 1,
    )
  ) {
    throw new ProductionMigrationSafetyError("migration_baseline_mismatch");
  }
  if (
    REQUIRED_SUPABASE_MIGRATION_BASELINE.some(
      (name, index) => migrationNames[index] !== name,
    )
  ) {
    throw new ProductionMigrationSafetyError("migration_baseline_mismatch");
  }

  const appliedAccountMigrations = migrationNames.slice(
    REQUIRED_SUPABASE_MIGRATION_BASELINE.length,
  );
  if (
    appliedAccountMigrations.some(
      (name, index) => name !== RUDDER_ACCOUNT_MIGRATIONS[index],
    )
  ) {
    throw new ProductionMigrationSafetyError("migration_order_invalid");
  }

  const firstMissing = RUDDER_ACCOUNT_MIGRATIONS.findIndex(
    (name) => !counts.has(name),
  );
  if (
    firstMissing >= 0 &&
    RUDDER_ACCOUNT_MIGRATIONS.slice(firstMissing + 1).some((name) =>
      counts.has(name)
    )
  ) {
    throw new ProductionMigrationSafetyError("migration_order_invalid");
  }
  if (firstMissing >= 0) {
    return {
      state: firstMissing === 0 ? "ready" : "partial",
      nextMigration: RUDDER_ACCOUNT_MIGRATIONS[firstMissing],
    };
  }
  return { state: "complete", nextMigration: null };
}

export function assertProductionDatabaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductionMigrationSafetyError("invalid_migration_database_url");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new ProductionMigrationSafetyError("invalid_migration_database_url");
  }
  const directHost =
    url.hostname ===
    `db.${RUDDER_PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
  const poolerHost = url.hostname.endsWith(".pooler.supabase.com");
  const poolerUser = url.username.endsWith(
    `.${RUDDER_PRODUCTION_SUPABASE_PROJECT_REF}`,
  );
  if (!directHost && !(poolerHost && poolerUser)) {
    throw new ProductionMigrationSafetyError("production_project_ref_mismatch");
  }
  const databaseRole = decodeURIComponent(url.username).split(".")[0];
  if (databaseRole !== "postgres") {
    throw new ProductionMigrationSafetyError(
      "migration_requires_postgres_role",
    );
  }
  if ((url.port || "5432") !== "5432") {
    throw new ProductionMigrationSafetyError(
      "migration_requires_direct_or_session_port",
    );
  }
  if (
    url.pathname !== "/postgres" ||
    url.searchParams.get("sslmode") !== "require"
  ) {
    throw new ProductionMigrationSafetyError(
      "migration_database_transport_invalid",
    );
  }
  return url;
}

export function assertProductionSupabaseProjectUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProductionMigrationSafetyError(
      "invalid_supabase_project_url",
    );
  }
  if (
    url.origin !==
      `https://${RUDDER_PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co` ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new ProductionMigrationSafetyError(
      "production_project_ref_mismatch",
    );
  }
  return url;
}

export function assertApplyConfirmation(value: string | undefined): void {
  if (value !== RUDDER_PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new ProductionMigrationSafetyError(
      "production_project_confirmation_required",
    );
  }
}

export function migrationSqlSha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export type LegacyOwnerSnapshot = {
  legacyUserCount: number;
  verifiedEmailCount: number;
  legacyAccountCount: number;
  legacySessionCount: number;
  legacyDeviceCount: number;
  authUserCount: number;
  bindingCount: number;
  ledgerCount: number;
  malformedEmailCount: number;
  legacyProviders: readonly string[];
};

export function assessLegacyOwnerSnapshot(
  snapshot: LegacyOwnerSnapshot,
): "create_auth_user" | "adopt_auth_user" | "already_bound" {
  if (
    snapshot.legacyUserCount !== 1 ||
    snapshot.verifiedEmailCount !== 1 ||
    snapshot.malformedEmailCount !== 0
  ) {
    throw new ProductionMigrationSafetyError("legacy_owner_shape_invalid");
  }
  const providers = [...new Set(snapshot.legacyProviders)].sort();
  if (
    providers.length !== 2 ||
    providers[0] !== "github" ||
    providers[1] !== "google" ||
    snapshot.legacyAccountCount !== 2
  ) {
    throw new ProductionMigrationSafetyError(
      "legacy_provider_shape_invalid",
    );
  }
  if (snapshot.authUserCount > 1) {
    throw new ProductionMigrationSafetyError("duplicate_auth_user");
  }
  if (snapshot.bindingCount > 1 || snapshot.ledgerCount > 1) {
    throw new ProductionMigrationSafetyError("migration_identity_collision");
  }
  if (snapshot.bindingCount === 1) {
    if (snapshot.authUserCount !== 1 || snapshot.ledgerCount !== 1) {
      throw new ProductionMigrationSafetyError(
        "migration_identity_incomplete",
      );
    }
    return "already_bound";
  }
  return snapshot.authUserCount === 0
    ? "create_auth_user"
    : "adopt_auth_user";
}

export function safeMigrationResult(input: {
  phase: string;
  dryRun: boolean;
  gate: string;
  nextAction: string;
  counts?: Record<string, number>;
  migrationDigests?: Record<string, string>;
}): Record<string, unknown> {
  return {
    ok: true,
    phase: input.phase,
    dryRun: input.dryRun,
    gate: input.gate,
    nextAction: input.nextAction,
    ...(input.counts ? { counts: input.counts } : {}),
    ...(input.migrationDigests
      ? { migrationDigests: input.migrationDigests }
      : {}),
  };
}

export function safeMigrationError(error: unknown): {
  ok: false;
  code: string;
} {
  const candidate =
    error instanceof ProductionMigrationSafetyError ? error.code : "";
  return {
    ok: false,
    code: /^[a-z0-9_]+$/u.test(candidate)
      ? candidate
      : "unexpected_migration_failure",
  };
}
