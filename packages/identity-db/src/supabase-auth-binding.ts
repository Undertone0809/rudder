import { normalizeVerifiedEmail } from "@rudderhq/identity-core";
import type { InferSelectModel } from "drizzle-orm";
import { and, eq, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import {
  supabaseAuthMigrationLedger,
  supabaseAuthUserBindings,
} from "./schema.js";

export const SUPABASE_AUTH_MIGRATION_STATES = [
  "pending",
  "auth_user_created",
  "bound",
  "linked",
  "verified",
  "failed",
] as const;

export type SupabaseAuthMigrationState =
  (typeof SUPABASE_AUTH_MIGRATION_STATES)[number];
export type RecoverableSupabaseAuthMigrationState = Exclude<
  SupabaseAuthMigrationState,
  "failed"
>;
export type SupabaseAuthMigrationLedgerRow = InferSelectModel<
  typeof supabaseAuthMigrationLedger
>;
export type SupabaseAuthUserBinding = InferSelectModel<
  typeof supabaseAuthUserBindings
>;

export type SupabaseAuthMigrationIdentity = {
  migrationBatch: string;
  rudderUserId: string;
  email: string;
};

export type SupabaseAuthMigrationRecoveryAction =
  | "find_or_create_auth_user"
  | "persist_binding"
  | "link_provider_identities"
  | "verify_migration"
  | "complete"
  | "resume_or_review_failure";

const STATE_RANK: Record<RecoverableSupabaseAuthMigrationState, number> = {
  pending: 0,
  auth_user_created: 1,
  bound: 2,
  linked: 3,
  verified: 4,
};

export class SupabaseAuthBindingCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthBindingCollisionError";
  }
}

export class SupabaseAuthMigrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseAuthMigrationStateError";
  }
}

export function normalizeSupabaseAuthUserId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      normalized,
    )
  ) {
    throw new Error("Supabase Auth user ID must be a UUID");
  }
  return normalized;
}

export function normalizeSupabaseAuthMigrationIdentity(
  input: SupabaseAuthMigrationIdentity,
): {
  migrationBatch: string;
  rudderUserId: string;
  normalizedEmail: string;
} {
  const migrationBatch = input.migrationBatch.trim();
  const rudderUserId = input.rudderUserId.trim();
  if (!migrationBatch) throw new Error("Migration batch is required");
  if (!rudderUserId) throw new Error("Rudder user ID is required");
  return {
    migrationBatch,
    rudderUserId,
    normalizedEmail: normalizeVerifiedEmail(input.email),
  };
}

export function transitionSupabaseAuthMigrationState(
  current: SupabaseAuthMigrationState,
  requested: RecoverableSupabaseAuthMigrationState,
): RecoverableSupabaseAuthMigrationState {
  if (current === "failed") {
    throw new SupabaseAuthMigrationStateError(
      "Failed migration must be resumed before advancing",
    );
  }
  const currentRank = STATE_RANK[current];
  const requestedRank = STATE_RANK[requested];
  if (requestedRank <= currentRank) return current;
  if (requestedRank !== currentRank + 1) {
    throw new SupabaseAuthMigrationStateError(
      `Cannot advance Supabase Auth migration from ${current} to ${requested}`,
    );
  }
  return requested;
}

export function getSupabaseAuthMigrationRecoveryAction(
  state: SupabaseAuthMigrationState,
): SupabaseAuthMigrationRecoveryAction {
  switch (state) {
    case "pending":
      return "find_or_create_auth_user";
    case "auth_user_created":
      return "persist_binding";
    case "bound":
      return "link_provider_identities";
    case "linked":
      return "verify_migration";
    case "verified":
      return "complete";
    case "failed":
      return "resume_or_review_failure";
  }
}

export function assertExactSupabaseAuthMigrationIdentity(
  row: SupabaseAuthMigrationLedgerRow,
  expected: {
    migrationBatch: string;
    rudderUserId: string;
    normalizedEmail: string;
    authUserId?: string;
  },
): void {
  if (row.rudderUserId !== expected.rudderUserId) {
    throw new SupabaseAuthBindingCollisionError(
      "Normalized email already belongs to another Rudder subject",
    );
  }
  if (row.normalizedEmail !== expected.normalizedEmail) {
    throw new SupabaseAuthBindingCollisionError(
      "Rudder subject already belongs to another normalized email",
    );
  }
  if (
    expected.authUserId &&
    row.authUserId &&
    row.authUserId !== expected.authUserId
  ) {
    throw new SupabaseAuthBindingCollisionError(
      "Migration ledger already belongs to another Supabase Auth user",
    );
  }
  if (row.migrationBatch !== expected.migrationBatch) {
    throw new SupabaseAuthBindingCollisionError(
      "Legacy Rudder subject already belongs to another migration batch",
    );
  }
}

function assertExactBinding(
  row: SupabaseAuthUserBinding,
  expected: {
    migrationBatch: string;
    rudderUserId: string;
    normalizedEmail: string;
    authUserId: string;
  },
): void {
  if (row.authUserId !== expected.authUserId) {
    throw new SupabaseAuthBindingCollisionError(
      "Rudder subject or normalized email already belongs to another Supabase Auth user",
    );
  }
  if (row.rudderUserId !== expected.rudderUserId) {
    throw new SupabaseAuthBindingCollisionError(
      "Supabase Auth user or normalized email already belongs to another Rudder subject",
    );
  }
  if (row.normalizedEmail !== expected.normalizedEmail) {
    throw new SupabaseAuthBindingCollisionError(
      "Supabase Auth user or Rudder subject already belongs to another normalized email",
    );
  }
  if (row.migrationBatch !== expected.migrationBatch) {
    throw new SupabaseAuthBindingCollisionError(
      "Existing binding belongs to another migration batch",
    );
  }
}

async function lockMigrationIdentity(
  tx: Parameters<Parameters<IdentityDb["transaction"]>[0]>[0],
  keys: string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
  }
}

async function selectLedgerForIdentity(
  tx: Parameters<Parameters<IdentityDb["transaction"]>[0]>[0],
  identity: {
    migrationBatch: string;
    rudderUserId: string;
    normalizedEmail: string;
    authUserId?: string;
  },
): Promise<SupabaseAuthMigrationLedgerRow | undefined> {
  const authPredicate = identity.authUserId
    ? eq(supabaseAuthMigrationLedger.authUserId, identity.authUserId)
    : undefined;
  const rows = await tx
    .select()
    .from(supabaseAuthMigrationLedger)
    .where(
      or(
        eq(supabaseAuthMigrationLedger.rudderUserId, identity.rudderUserId),
        eq(
          supabaseAuthMigrationLedger.normalizedEmail,
          identity.normalizedEmail,
        ),
        authPredicate,
      ),
    );
  for (const row of rows) {
    assertExactSupabaseAuthMigrationIdentity(row, identity);
  }
  return rows[0];
}

export async function beginSupabaseAuthMigration(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity,
): Promise<SupabaseAuthMigrationLedgerRow> {
  const identity = normalizeSupabaseAuthMigrationIdentity(input);
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const existing = await selectLedgerForIdentity(tx, identity);
    if (existing) return existing;

    const inserted = await tx
      .insert(supabaseAuthMigrationLedger)
      .values({
        id: randomUUID(),
        ...identity,
        state: "pending",
      })
      .returning();
    if (!inserted[0]) {
      throw new Error("Failed to create Supabase Auth migration ledger row");
    }
    return inserted[0];
  });
}

export async function recordSupabaseAuthUserCreated(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity & { authUserId: string },
): Promise<SupabaseAuthMigrationLedgerRow> {
  const identity = {
    ...normalizeSupabaseAuthMigrationIdentity(input),
    authUserId: normalizeSupabaseAuthUserId(input.authUserId),
  };
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `auth-user:${identity.authUserId}`,
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const existing = await selectLedgerForIdentity(tx, identity);
    if (!existing) {
      throw new SupabaseAuthMigrationStateError(
        "Migration ledger must be prepared before creating the Auth user",
      );
    }
    if (existing.state === "failed") {
      throw new SupabaseAuthMigrationStateError(
        "Failed migration must be resumed before recording the Auth user",
      );
    }
    const state = transitionSupabaseAuthMigrationState(
      existing.state,
      "auth_user_created",
    );
    if (existing.authUserId === identity.authUserId && state === existing.state) {
      return existing;
    }
    const updated = await tx
      .update(supabaseAuthMigrationLedger)
      .set({
        authUserId: identity.authUserId,
        state,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(supabaseAuthMigrationLedger.id, existing.id))
      .returning();
    return updated[0]!;
  });
}

export async function bindSupabaseAuthUser(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity & { authUserId: string },
): Promise<SupabaseAuthUserBinding> {
  const identity = {
    ...normalizeSupabaseAuthMigrationIdentity(input),
    authUserId: normalizeSupabaseAuthUserId(input.authUserId),
  };
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `auth-user:${identity.authUserId}`,
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const ledger = await selectLedgerForIdentity(tx, identity);
    if (!ledger || !ledger.authUserId) {
      throw new SupabaseAuthMigrationStateError(
        "Supabase Auth user must be recorded before binding",
      );
    }
    if (ledger.state === "failed") {
      throw new SupabaseAuthMigrationStateError(
        "Failed migration must be resumed before binding",
      );
    }
    const state = transitionSupabaseAuthMigrationState(ledger.state, "bound");

    const bindings = await tx
      .select()
      .from(supabaseAuthUserBindings)
      .where(
        or(
          eq(supabaseAuthUserBindings.authUserId, identity.authUserId),
          eq(supabaseAuthUserBindings.rudderUserId, identity.rudderUserId),
          eq(
            supabaseAuthUserBindings.normalizedEmail,
            identity.normalizedEmail,
          ),
        ),
      );
    for (const binding of bindings) assertExactBinding(binding, identity);

    let binding = bindings[0];
    if (!binding) {
      const inserted = await tx
        .insert(supabaseAuthUserBindings)
        .values(identity)
        .returning();
      binding = inserted[0];
    }
    if (!binding) throw new Error("Failed to persist Supabase Auth binding");

    if (state !== ledger.state) {
      await tx
        .update(supabaseAuthMigrationLedger)
        .set({ state, lastError: null, updatedAt: new Date() })
        .where(eq(supabaseAuthMigrationLedger.id, ledger.id));
    }
    return binding;
  });
}

export async function advanceSupabaseAuthMigration(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity & {
    authUserId: string;
    state: "linked" | "verified";
  },
): Promise<SupabaseAuthMigrationLedgerRow> {
  const identity = {
    ...normalizeSupabaseAuthMigrationIdentity(input),
    authUserId: normalizeSupabaseAuthUserId(input.authUserId),
  };
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `auth-user:${identity.authUserId}`,
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const existing = await selectLedgerForIdentity(tx, identity);
    if (!existing) {
      throw new SupabaseAuthMigrationStateError("Migration ledger does not exist");
    }
    const state = transitionSupabaseAuthMigrationState(
      existing.state,
      input.state,
    );
    if (state === existing.state) return existing;
    const updated = await tx
      .update(supabaseAuthMigrationLedger)
      .set({ state, lastError: null, updatedAt: new Date() })
      .where(eq(supabaseAuthMigrationLedger.id, existing.id))
      .returning();
    return updated[0]!;
  });
}

export async function failSupabaseAuthMigration(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity & { error: string },
): Promise<SupabaseAuthMigrationLedgerRow> {
  const identity = normalizeSupabaseAuthMigrationIdentity(input);
  const error = input.error.trim();
  if (!error) throw new Error("Migration failure reason is required");
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const existing = await selectLedgerForIdentity(tx, identity);
    if (!existing) {
      throw new SupabaseAuthMigrationStateError("Migration ledger does not exist");
    }
    if (existing.state === "verified") {
      throw new SupabaseAuthMigrationStateError(
        "Verified migration cannot be marked failed",
      );
    }
    if (existing.state === "failed") {
      const updated = await tx
        .update(supabaseAuthMigrationLedger)
        .set({ lastError: error, updatedAt: new Date() })
        .where(eq(supabaseAuthMigrationLedger.id, existing.id))
        .returning();
      return updated[0]!;
    }
    const updated = await tx
      .update(supabaseAuthMigrationLedger)
      .set({
        state: "failed",
        resumeState: existing.state,
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(supabaseAuthMigrationLedger.id, existing.id))
      .returning();
    return updated[0]!;
  });
}

export async function resumeSupabaseAuthMigration(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity,
): Promise<SupabaseAuthMigrationLedgerRow> {
  const identity = normalizeSupabaseAuthMigrationIdentity(input);
  return db.transaction(async (tx) => {
    await lockMigrationIdentity(tx, [
      `email:${identity.normalizedEmail}`,
      `rudder-user:${identity.rudderUserId}`,
    ]);
    const existing = await selectLedgerForIdentity(tx, identity);
    if (!existing) {
      throw new SupabaseAuthMigrationStateError("Migration ledger does not exist");
    }
    if (existing.state !== "failed" || !existing.resumeState) return existing;
    const updated = await tx
      .update(supabaseAuthMigrationLedger)
      .set({
        state: existing.resumeState,
        resumeState: null,
        attemptCount: sql`${supabaseAuthMigrationLedger.attemptCount} + 1`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(supabaseAuthMigrationLedger.id, existing.id))
      .returning();
    return updated[0]!;
  });
}

export async function getSupabaseAuthUserBinding(
  db: IdentityDb,
  authUserId: string,
): Promise<SupabaseAuthUserBinding | null> {
  const normalizedAuthUserId = normalizeSupabaseAuthUserId(authUserId);
  const rows = await db
    .select()
    .from(supabaseAuthUserBindings)
    .where(eq(supabaseAuthUserBindings.authUserId, normalizedAuthUserId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getSupabaseAuthMigrationByIdentity(
  db: IdentityDb,
  input: SupabaseAuthMigrationIdentity,
): Promise<SupabaseAuthMigrationLedgerRow | null> {
  const identity = normalizeSupabaseAuthMigrationIdentity(input);
  const rows = await db
    .select()
    .from(supabaseAuthMigrationLedger)
    .where(
      and(
        eq(supabaseAuthMigrationLedger.migrationBatch, identity.migrationBatch),
        eq(supabaseAuthMigrationLedger.rudderUserId, identity.rudderUserId),
        eq(
          supabaseAuthMigrationLedger.normalizedEmail,
          identity.normalizedEmail,
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
