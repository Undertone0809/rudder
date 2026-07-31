import { and, asc, eq, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { credentialRevocationIntents, securityEvents } from "./schema.js";

export type CredentialRevocationOperation =
  | "password-change"
  | "password-reset"
  | "global-sign-out";

export type CredentialRevocationDeviceScope = "none" | "all";

export type CredentialRevocationIntent = {
  id: string;
  userId: string;
  rootIdentityUserId: string;
  operation: CredentialRevocationOperation;
  deviceScope: CredentialRevocationDeviceScope;
  state: "pending-provider" | "pending-rudder" | "manual-repair" | "completed";
};

export type ClaimedCredentialRevocationIntent = CredentialRevocationIntent & {
  claimOwner: string;
  attemptCount: number;
};

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_PROVIDER_MANUAL_REPAIR_AFTER_MS = 15 * 60_000;
const DEFAULT_MAX_RUDDER_ATTEMPTS = 8;

export async function beginCredentialRevocationIntent(
  db: IdentityDb,
  input: {
    userId: string;
    rootIdentityUserId: string;
    operation: CredentialRevocationOperation;
    deviceScope: CredentialRevocationDeviceScope;
  },
): Promise<CredentialRevocationIntent> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        id: credentialRevocationIntents.id,
        userId: credentialRevocationIntents.userId,
        rootIdentityUserId: credentialRevocationIntents.rootIdentityUserId,
        operation: credentialRevocationIntents.operation,
        deviceScope: credentialRevocationIntents.deviceScope,
        state: credentialRevocationIntents.state,
      })
      .from(credentialRevocationIntents)
      .where(
        and(
          eq(credentialRevocationIntents.userId, input.userId),
          ne(credentialRevocationIntents.state, "completed"),
        ),
      )
      .limit(1)
      .for("update");

    if (existing) {
      if (existing.state === "manual-repair") {
        throw new Error("credential_revocation_manual_repair_required");
      }
      if (existing.state === "pending-rudder") {
        // The provider stage is already durable. Never replay it; the recovery
        // worker owns the remaining Rudder-local idempotent stage.
        throw new Error("credential_revocation_pending");
      }
      if (
        existing.rootIdentityUserId !== input.rootIdentityUserId ||
        existing.operation !== input.operation ||
        existing.deviceScope !== input.deviceScope
      ) {
        throw new Error("credential_revocation_pending");
      }
      await tx
        .update(credentialRevocationIntents)
        .set({
          attemptCount: sql`${credentialRevocationIntents.attemptCount} + 1`,
          lastError: null,
          nextAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(credentialRevocationIntents.id, existing.id));
      return existing;
    }

    const id = randomUUID();
    await tx.insert(credentialRevocationIntents).values({
      id,
      userId: input.userId,
      rootIdentityUserId: input.rootIdentityUserId,
      operation: input.operation,
      deviceScope: input.deviceScope,
      state: "pending-provider",
    });
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: input.userId,
      eventType: "credential.revocation.intent.created",
      metadata: {
        intentId: id,
        operation: input.operation,
        deviceScope: input.deviceScope,
      },
    });
    return { id, ...input, state: "pending-provider" };
  });
}

export async function markCredentialProviderMutationComplete(
  db: IdentityDb,
  intentId: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [intent] = await tx
      .update(credentialRevocationIntents)
      .set({
        state: "pending-rudder",
        providerCompletedAt: now,
        lastError: null,
        nextAttemptAt: now,
        claimOwner: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(credentialRevocationIntents.id, intentId),
          eq(credentialRevocationIntents.state, "pending-provider"),
        ),
      )
      .returning({
        userId: credentialRevocationIntents.userId,
        operation: credentialRevocationIntents.operation,
      });
    if (!intent) return;
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: intent.userId,
      eventType: "credential.revocation.provider.completed",
      metadata: { intentId, operation: intent.operation },
    });
  });
}

export async function markCredentialRevocationFailed(
  db: IdentityDb,
  input: {
    intentId: string;
    stage: "provider" | "rudder";
    error: string;
    claimOwner?: string;
    retryAt?: Date;
  },
): Promise<void> {
  const where = input.claimOwner
    ? and(
        eq(credentialRevocationIntents.id, input.intentId),
        eq(credentialRevocationIntents.claimOwner, input.claimOwner),
      )
    : eq(credentialRevocationIntents.id, input.intentId);
  const [intent] = await db
    .update(credentialRevocationIntents)
    .set({
      attemptCount: sql`${credentialRevocationIntents.attemptCount} + 1`,
      lastError: input.error.slice(0, 1_000),
      nextAttemptAt: input.retryAt ?? new Date(),
      claimOwner: null,
      claimedAt: null,
      updatedAt: new Date(),
    })
    .where(where)
    .returning({
      userId: credentialRevocationIntents.userId,
      operation: credentialRevocationIntents.operation,
    });
  if (intent) {
    await db.insert(securityEvents).values({
      id: randomUUID(),
      userId: intent.userId,
      eventType: "credential.revocation.retry_required",
      metadata: {
        intentId: input.intentId,
        operation: intent.operation,
        stage: input.stage,
      },
    });
  }
}

export async function completeCredentialRevocationIntent(
  db: IdentityDb,
  intentId: string,
  claimOwner?: string,
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [intent] = await tx
      .update(credentialRevocationIntents)
      .set({
        state: "completed",
        rudderCompletedAt: now,
        lastError: null,
        claimOwner: null,
        claimedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(credentialRevocationIntents.id, intentId),
          eq(credentialRevocationIntents.state, "pending-rudder"),
          ...(claimOwner
            ? [eq(credentialRevocationIntents.claimOwner, claimOwner)]
            : []),
        ),
      )
      .returning({
        userId: credentialRevocationIntents.userId,
        operation: credentialRevocationIntents.operation,
      });
    if (!intent) throw new Error("credential_revocation_not_ready");
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: intent.userId,
      eventType: "credential.revocation.completed",
      metadata: { intentId, operation: intent.operation },
    });
  });
}

/**
 * Moves provider-stage intents whose outcome cannot be inferred safely into a
 * durable manual-repair state. Provider mutations may have succeeded before a
 * process crash, so the recovery worker must never replay them blindly.
 */
export async function escalateStaleCredentialProviderIntents(
  db: IdentityDb,
  options: { now?: Date; manualRepairAfterMs?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime()
      - (options.manualRepairAfterMs ?? DEFAULT_PROVIDER_MANUAL_REPAIR_AFTER_MS),
  );
  const rows = await db.transaction(async (tx) => {
    const escalated = await tx
      .update(credentialRevocationIntents)
      .set({
        state: "manual-repair",
        manualRepairAt: now,
        claimOwner: null,
        claimedAt: null,
        lastError: "provider_outcome_requires_manual_verification",
        updatedAt: now,
      })
      .where(
        and(
          eq(credentialRevocationIntents.state, "pending-provider"),
          lt(credentialRevocationIntents.updatedAt, cutoff),
        ),
      )
      .returning({
        id: credentialRevocationIntents.id,
        userId: credentialRevocationIntents.userId,
        operation: credentialRevocationIntents.operation,
      });
    if (escalated.length > 0) {
      await tx.insert(securityEvents).values(
        escalated.map((intent) => ({
          id: randomUUID(),
          userId: intent.userId,
          eventType: "credential.revocation.manual_repair_required",
          metadata: {
            intentId: intent.id,
            operation: intent.operation,
            stage: "provider",
            reason: "provider_outcome_unknown_after_timeout",
          },
        })),
      );
    }
    return escalated;
  });
  return rows.length;
}

export async function escalateExhaustedCredentialRudderIntents(
  db: IdentityDb,
  options: { now?: Date; maxAttempts?: number } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const rows = await db.transaction(async (tx) => {
    const escalated = await tx
      .update(credentialRevocationIntents)
      .set({
        state: "manual-repair",
        manualRepairAt: now,
        claimOwner: null,
        claimedAt: null,
        lastError: "rudder_revocation_retry_budget_exhausted",
        updatedAt: now,
      })
      .where(
        and(
          eq(credentialRevocationIntents.state, "pending-rudder"),
          sql`${credentialRevocationIntents.attemptCount} >= ${
            options.maxAttempts ?? DEFAULT_MAX_RUDDER_ATTEMPTS
          }`,
        ),
      )
      .returning({
        id: credentialRevocationIntents.id,
        userId: credentialRevocationIntents.userId,
        operation: credentialRevocationIntents.operation,
      });
    if (escalated.length > 0) {
      await tx.insert(securityEvents).values(
        escalated.map((intent) => ({
          id: randomUUID(),
          userId: intent.userId,
          eventType: "credential.revocation.manual_repair_required",
          metadata: {
            intentId: intent.id,
            operation: intent.operation,
            stage: "rudder",
            reason: "retry_budget_exhausted",
          },
        })),
      );
    }
    return escalated;
  });
  return rows.length;
}

/**
 * Operator-only recovery primitive. The caller must first verify the root
 * provider's actual state; `providerCompleted` deliberately cannot be guessed.
 */
export async function resolveCredentialProviderManualRepair(
  db: IdentityDb,
  input: {
    intentId: string;
    providerCompleted: boolean;
    operatorReference: string;
  },
): Promise<void> {
  const now = new Date();
  await db.transaction(async (tx) => {
    const [intent] = await tx
      .update(credentialRevocationIntents)
      .set(
        input.providerCompleted
          ? {
              state: "pending-rudder",
              providerCompletedAt: now,
              manualRepairAt: null,
              lastError: null,
              nextAttemptAt: now,
              updatedAt: now,
            }
          : {
              state: "pending-provider",
              providerCompletedAt: null,
              manualRepairAt: null,
              lastError: "provider_manual_repair_reopened",
              nextAttemptAt: now,
              updatedAt: now,
            },
      )
      .where(
        and(
          eq(credentialRevocationIntents.id, input.intentId),
          eq(credentialRevocationIntents.state, "manual-repair"),
        ),
      )
      .returning({
        userId: credentialRevocationIntents.userId,
        operation: credentialRevocationIntents.operation,
      });
    if (!intent) throw new Error("credential_revocation_not_in_manual_repair");
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: intent.userId,
      eventType: "credential.revocation.manual_repair_resolved",
      metadata: {
        intentId: input.intentId,
        operation: intent.operation,
        providerCompleted: input.providerCompleted,
        operatorReference: input.operatorReference.slice(0, 200),
      },
    });
  });
}

export async function claimCredentialRevocationIntent(
  db: IdentityDb,
  input: {
    claimOwner: string;
    now?: Date;
    leaseMs?: number;
    maxAttempts?: number;
  },
): Promise<ClaimedCredentialRevocationIntent | null> {
  const now = input.now ?? new Date();
  const expiredLease = new Date(
    now.getTime() - (input.leaseMs ?? DEFAULT_CLAIM_LEASE_MS),
  );
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(credentialRevocationIntents)
      .where(
        and(
          eq(credentialRevocationIntents.state, "pending-rudder"),
          lte(credentialRevocationIntents.nextAttemptAt, now),
          lt(
            credentialRevocationIntents.attemptCount,
            input.maxAttempts ?? DEFAULT_MAX_RUDDER_ATTEMPTS,
          ),
          or(
            isNull(credentialRevocationIntents.claimedAt),
            lt(credentialRevocationIntents.claimedAt, expiredLease),
          ),
        ),
      )
      .orderBy(
        asc(credentialRevocationIntents.nextAttemptAt),
        asc(credentialRevocationIntents.createdAt),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(credentialRevocationIntents)
      .set({
        claimOwner: input.claimOwner,
        claimedAt: now,
        updatedAt: now,
      })
      .where(eq(credentialRevocationIntents.id, candidate.id))
      .returning();
    return claimed
      ? {
          id: claimed.id,
          userId: claimed.userId,
          rootIdentityUserId: claimed.rootIdentityUserId,
          operation: claimed.operation,
          deviceScope: claimed.deviceScope,
          state: claimed.state,
          claimOwner: input.claimOwner,
          attemptCount: claimed.attemptCount,
        }
      : null;
  });
}

export async function recoverCredentialRevocationIntents(
  db: IdentityDb,
  input: {
    claimOwner: string;
    revokeRudderCredentials: (
      intent: ClaimedCredentialRevocationIntent,
    ) => Promise<void>;
    now?: Date;
    maxClaims?: number;
    manualRepairAfterMs?: number;
    maxAttempts?: number;
  },
): Promise<{ completed: number; failed: number; escalated: number }> {
  const now = input.now ?? new Date();
  const staleProvider = await escalateStaleCredentialProviderIntents(db, {
    now,
    manualRepairAfterMs: input.manualRepairAfterMs,
  });
  const exhaustedRudder = await escalateExhaustedCredentialRudderIntents(db, {
    now,
    maxAttempts: input.maxAttempts,
  });
  let completed = 0;
  let failed = 0;
  for (let index = 0; index < (input.maxClaims ?? 4); index += 1) {
    const intent = await claimCredentialRevocationIntent(db, {
      claimOwner: input.claimOwner,
      now,
      maxAttempts: input.maxAttempts,
    });
    if (!intent) break;
    try {
      await input.revokeRudderCredentials(intent);
      await completeCredentialRevocationIntent(
        db,
        intent.id,
        input.claimOwner,
      );
      completed += 1;
    } catch (error) {
      const delayMs = Math.min(
        60_000,
        1_000 * (2 ** Math.min(intent.attemptCount, 6)),
      );
      await markCredentialRevocationFailed(db, {
        intentId: intent.id,
        stage: "rudder",
        error: error instanceof Error ? error.message : "unknown_error",
        claimOwner: input.claimOwner,
        retryAt: new Date(now.getTime() + delayMs),
      });
      failed += 1;
    }
  }
  return {
    completed,
    failed,
    escalated: staleProvider + exhaustedRudder,
  };
}

export async function hasPendingCredentialRevocationIntent(
  db: IdentityDb,
  userId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: credentialRevocationIntents.id })
    .from(credentialRevocationIntents)
    .where(
      and(
        eq(credentialRevocationIntents.userId, userId),
        ne(credentialRevocationIntents.state, "completed"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
