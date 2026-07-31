import { describe, expect, it } from "vitest";
import {
  assertExactSupabaseAuthMigrationIdentity,
  getSupabaseAuthMigrationRecoveryAction,
  normalizeSupabaseAuthMigrationIdentity,
  normalizeSupabaseAuthUserId,
  SupabaseAuthBindingCollisionError,
  transitionSupabaseAuthMigrationState,
  type SupabaseAuthMigrationLedgerRow,
} from "./supabase-auth-binding.js";

const ledgerRow: SupabaseAuthMigrationLedgerRow = {
  id: "ledger-1",
  migrationBatch: "2026-07-30-owner-cutover",
  rudderUserId: "legacy_owner_non_uuid",
  normalizedEmail: "owner@example.com",
  authUserId: "0198f1c2-aabb-7ccd-8eef-001122334455",
  state: "auth_user_created",
  resumeState: null,
  attemptCount: 1,
  lastError: null,
  createdAt: new Date("2026-07-30T00:00:00Z"),
  updatedAt: new Date("2026-07-30T00:00:00Z"),
};

describe("Supabase Auth migration identity", () => {
  it("preserves a non-UUID legacy Rudder subject and normalizes verified email", () => {
    expect(
      normalizeSupabaseAuthMigrationIdentity({
        migrationBatch: " 2026-07-30-owner-cutover ",
        rudderUserId: " legacy_owner_non_uuid ",
        email: " Owner@Example.COM ",
      }),
    ).toEqual({
      migrationBatch: "2026-07-30-owner-cutover",
      rudderUserId: "legacy_owner_non_uuid",
      normalizedEmail: "owner@example.com",
    });
  });

  it("requires a real UUID only for the Supabase Auth user", () => {
    const supabaseUserId = ["0198f1c2", "aabb", "7ccd", "8eef", "001122334455"].join("-");
    expect(
      normalizeSupabaseAuthUserId(supabaseUserId.toUpperCase()),
    ).toBe(supabaseUserId);
    expect(() => normalizeSupabaseAuthUserId("legacy_owner_non_uuid")).toThrow(
      "must be a UUID",
    );
  });

  it.each([
    [
      "migration batch",
      { ...ledgerRow, migrationBatch: "other-batch" },
      "another migration batch",
    ],
    [
      "legacy subject",
      { ...ledgerRow, rudderUserId: "different-owner" },
      "another Rudder subject",
    ],
    [
      "normalized email",
      { ...ledgerRow, normalizedEmail: "different@example.com" },
      "another normalized email",
    ],
    [
      "Supabase UUID",
      {
        ...ledgerRow,
        authUserId: "0198f1c2-aabb-7ccd-8eef-001122334456",
      },
      "another Supabase Auth user",
    ],
  ])("fails closed on an exact %s conflict", (_name, row, message) => {
    const assertConflict = () =>
      assertExactSupabaseAuthMigrationIdentity(row, {
        migrationBatch: ledgerRow.migrationBatch,
        rudderUserId: ledgerRow.rudderUserId,
        normalizedEmail: ledgerRow.normalizedEmail,
        authUserId: ledgerRow.authUserId!,
      });
    expect(assertConflict).toThrowError(SupabaseAuthBindingCollisionError);
    expect(assertConflict).toThrow(message);
  });

  it("accepts the exact UUID/email/legacy-subject tuple for crash recovery", () => {
    expect(() =>
      assertExactSupabaseAuthMigrationIdentity(ledgerRow, {
        migrationBatch: ledgerRow.migrationBatch,
        rudderUserId: ledgerRow.rudderUserId,
        normalizedEmail: ledgerRow.normalizedEmail,
        authUserId: ledgerRow.authUserId!,
      }),
    ).not.toThrow();
  });
});

describe("Supabase Auth migration state machine", () => {
  it("makes repeated and already-completed operations idempotent", () => {
    expect(
      transitionSupabaseAuthMigrationState("pending", "pending"),
    ).toBe("pending");
    expect(
      transitionSupabaseAuthMigrationState("bound", "auth_user_created"),
    ).toBe("bound");
    expect(
      transitionSupabaseAuthMigrationState("verified", "verified"),
    ).toBe("verified");
  });

  it("allows only the next durable migration step", () => {
    expect(
      transitionSupabaseAuthMigrationState("pending", "auth_user_created"),
    ).toBe("auth_user_created");
    expect(
      transitionSupabaseAuthMigrationState("auth_user_created", "bound"),
    ).toBe("bound");
    expect(transitionSupabaseAuthMigrationState("bound", "linked")).toBe(
      "linked",
    );
    expect(transitionSupabaseAuthMigrationState("linked", "verified")).toBe(
      "verified",
    );
    expect(() =>
      transitionSupabaseAuthMigrationState("pending", "bound"),
    ).toThrow("Cannot advance");
    expect(() =>
      transitionSupabaseAuthMigrationState("failed", "auth_user_created"),
    ).toThrow("must be resumed");
  });

  it.each([
    ["pending", "find_or_create_auth_user"],
    ["auth_user_created", "persist_binding"],
    ["bound", "link_provider_identities"],
    ["linked", "verify_migration"],
    ["verified", "complete"],
    ["failed", "resume_or_review_failure"],
  ] as const)(
    "selects the required recovery operation after a crash in %s",
    (state, action) => {
      expect(getSupabaseAuthMigrationRecoveryAction(state)).toBe(action);
    },
  );
});
