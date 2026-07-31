import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertApplyConfirmation,
  assertProductionDatabaseUrl,
  assertProductionSupabaseProjectUrl,
  assessLegacyOwnerSnapshot,
  assessSupabaseMigrationHistory,
  ProductionMigrationSafetyError,
  safeMigrationError,
  safeMigrationResult,
} from "./production-migration-safety.js";

const baseline = [
  "rudder_identity_base",
  "rudder_identity_runtime_role",
  "bind_device_refresh_client",
];

describe("production migration safety", () => {
  it("removes direct Auth traversal before granting the session verifier", () => {
    const migration = readFileSync(
      new URL(
        "./migrations/0005_auth_session_verifier_isolation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      "IF to_regclass('auth.sessions') IS NULL THEN",
    );
    expect(migration).toContain("SELECT false");
    const revokeSelect = migration.indexOf(
      "REVOKE SELECT (id, user_id, not_after)",
    );
    const revokeSchema = migration.indexOf(
      "REVOKE USAGE ON SCHEMA auth FROM rudder_identity_app",
    );
    const grantVerifier = migration.indexOf(
      'GRANT EXECUTE\n      ON FUNCTION "rudder_identity"."is_active_auth_session"',
    );

    expect(revokeSelect).toBeGreaterThan(-1);
    expect(revokeSchema).toBeGreaterThan(revokeSelect);
    expect(grantVerifier).toBeGreaterThan(revokeSchema);
  });

  it("requires the exact Supabase history baseline and ordered account migrations", () => {
    expect(assessSupabaseMigrationHistory(baseline)).toEqual({
      state: "ready",
      nextMigration: "supabase_auth_binding",
    });
    expect(
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
      ]),
    ).toEqual({
      state: "partial",
      nextMigration: "credential_revocation_intent",
    });
    expect(
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
        "credential_revocation_intent",
      ]),
    ).toEqual({
      state: "partial",
      nextMigration: "auth_session_verifier",
    });
    expect(
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
        "credential_revocation_intent",
        "auth_session_verifier",
      ]),
    ).toEqual({
      state: "partial",
      nextMigration: "auth_session_verifier_isolation",
    });
    expect(
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
        "credential_revocation_intent",
        "auth_session_verifier",
        "auth_session_verifier_isolation",
      ]),
    ).toEqual({ state: "complete", nextMigration: null });
    expect(() =>
      assessSupabaseMigrationHistory([
        ...baseline,
        "credential_revocation_intent",
      ]),
    ).toThrow("migration_order_invalid");
    expect(() =>
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
        "auth_session_verifier",
      ]),
    ).toThrow("migration_order_invalid");
    expect(() =>
      assessSupabaseMigrationHistory([
        ...baseline,
        "supabase_auth_binding",
        "credential_revocation_intent",
        "auth_session_verifier_isolation",
      ]),
    ).toThrow("migration_order_invalid");
    expect(() =>
      assessSupabaseMigrationHistory([
        ...baseline,
        "credential_revocation_intent",
        "supabase_auth_binding",
      ]),
    ).toThrow("migration_order_invalid");
    expect(() =>
      assessSupabaseMigrationHistory([
        baseline[1]!,
        baseline[0]!,
        baseline[2]!,
      ]),
    ).toThrow("migration_baseline_mismatch");
    expect(() =>
      assessSupabaseMigrationHistory(baseline.slice(1)),
    ).toThrow("migration_baseline_mismatch");
  });

  it("hard-locks apply mode to the production project postgres role and TLS", () => {
    expect(
      assertProductionDatabaseUrl(
        "postgresql://postgres.qroqfgbaifzeqlygafjr:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
      ).hostname,
    ).toContain("pooler.supabase.com");
    expect(() =>
      assertProductionDatabaseUrl(
        "postgresql://rudder_identity_app.qroqfgbaifzeqlygafjr:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require",
      ),
    ).toThrow("migration_requires_postgres_role");
    expect(() =>
      assertProductionDatabaseUrl(
        "postgresql://postgres.qroqfgbaifzeqlygafjr:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require",
      ),
    ).toThrow("migration_requires_direct_or_session_port");
    expect(() =>
      assertProductionDatabaseUrl(
        "postgresql://postgres.otherprojectrefabc:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require",
      ),
    ).toThrow("production_project_ref_mismatch");
    expect(() =>
      assertProductionDatabaseUrl(
        "postgresql://postgres.qroqfgbaifzeqlygafjr:secret@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres",
      ),
    ).toThrow("migration_database_transport_invalid");
    expect(() => assertApplyConfirmation(undefined)).toThrow(
      "production_project_confirmation_required",
    );
    expect(() =>
      assertApplyConfirmation("qroqfgbaifzeqlygafjr"),
    ).not.toThrow();
    expect(
      assertProductionSupabaseProjectUrl(
        "https://qroqfgbaifzeqlygafjr.supabase.co",
      ).origin,
    ).toBe("https://qroqfgbaifzeqlygafjr.supabase.co");
    expect(() =>
      assertProductionSupabaseProjectUrl(
        "https://abcdefghijklmnopqrst.supabase.co",
      ),
    ).toThrow("production_project_ref_mismatch");
  });

  it("accepts the production-shaped legacy owner without exposing identity values", () => {
    const snapshot = {
      legacyUserCount: 1,
      verifiedEmailCount: 1,
      legacyAccountCount: 2,
      legacySessionCount: 6,
      legacyDeviceCount: 1,
      authUserCount: 0,
      bindingCount: 0,
      ledgerCount: 0,
      malformedEmailCount: 0,
      legacyProviders: ["google", "github"],
    };
    expect(assessLegacyOwnerSnapshot(snapshot)).toBe("create_auth_user");
    expect(
      assessLegacyOwnerSnapshot({
        ...snapshot,
        authUserCount: 1,
      }),
    ).toBe("adopt_auth_user");
    expect(
      assessLegacyOwnerSnapshot({
        ...snapshot,
        authUserCount: 1,
        bindingCount: 1,
        ledgerCount: 1,
      }),
    ).toBe("already_bound");
  });

  it("fails closed on duplicate or incomplete identity shapes", () => {
    const snapshot = {
      legacyUserCount: 1,
      verifiedEmailCount: 1,
      legacyAccountCount: 2,
      legacySessionCount: 6,
      legacyDeviceCount: 1,
      authUserCount: 2,
      bindingCount: 0,
      ledgerCount: 0,
      malformedEmailCount: 0,
      legacyProviders: ["google", "github"],
    };
    expect(() => assessLegacyOwnerSnapshot(snapshot)).toThrow(
      "duplicate_auth_user",
    );
    expect(() =>
      assessLegacyOwnerSnapshot({
        ...snapshot,
        authUserCount: 1,
        bindingCount: 1,
      }),
    ).toThrow("migration_identity_incomplete");
  });

  it("returns only allow-listed, non-PII result fields", () => {
    const result = safeMigrationResult({
      phase: "prepare-owner",
      dryRun: true,
      gate: "ready",
      nextAction: "create_auth_user",
      counts: { legacyUsers: 1, authUsers: 0 },
    });
    expect(result).toEqual({
      ok: true,
      phase: "prepare-owner",
      dryRun: true,
      gate: "ready",
      nextAction: "create_auth_user",
      counts: { legacyUsers: 1, authUsers: 0 },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /email|password|token|secret|userId/iu,
    );
  });

  it("uses stable machine error codes", () => {
    const error = new ProductionMigrationSafetyError("fixture_error");
    expect(error.message).toBe("fixture_error");
    expect(safeMigrationError(error)).toEqual({
      ok: false,
      code: "fixture_error",
    });
    expect(
      safeMigrationError(
        new ProductionMigrationSafetyError(
          "owner@example.com secret-token-value",
        ),
      ),
    ).toEqual({
      ok: false,
      code: "unexpected_migration_failure",
    });
  });
});
