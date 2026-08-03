import { and, desc, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { identityProductAnalyticsConsent } from "./schema.js";

export type IdentityProductAnalyticsMode = "anonymous" | "account_linked";
export type IdentityProductAnalyticsDecision = "granted" | "revoked";

type ConsentInput = {
  userId: string;
  installationId: string;
  mode: IdentityProductAnalyticsMode;
  decision: IdentityProductAnalyticsDecision;
  consentVersion: string;
};

function assertInput(input: ConsentInput): void {
  if (!input.userId || !input.installationId || !input.consentVersion
    || (input.mode !== "anonymous" && input.mode !== "account_linked")
    || (input.decision !== "granted" && input.decision !== "revoked")) {
    throw new Error("invalid_product_analytics_consent");
  }
  if (input.installationId.length > 200 || input.consentVersion.length > 80) {
    throw new Error("invalid_product_analytics_consent");
  }
}

async function latestConsent(db: IdentityDb, input: Pick<ConsentInput, "userId" | "installationId" | "mode">) {
  const [row] = await db.select().from(identityProductAnalyticsConsent).where(and(
    eq(identityProductAnalyticsConsent.userId, input.userId),
    eq(identityProductAnalyticsConsent.installationId, input.installationId),
    eq(identityProductAnalyticsConsent.mode, input.mode),
  )).orderBy(desc(identityProductAnalyticsConsent.consentEpoch)).limit(1);
  return row ?? null;
}

/** Record a monotonic consent decision in the Identity-owned ledger. */
export async function recordIdentityProductAnalyticsConsent(db: IdentityDb, input: ConsentInput) {
  assertInput(input);
  return db.transaction(async (tx) => {
    // Serialize the per-subject stream even when two Desktop processes grant
    // consent at the same time and no row exists yet.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.userId}:${input.installationId}:${input.mode}`}, 0))`);
    const previous = await latestConsent(tx as unknown as IdentityDb, input);
    if (previous && previous.decision === input.decision && previous.consentVersion === input.consentVersion) {
      return previous;
    }
    const [row] = await tx.insert(identityProductAnalyticsConsent).values({
      id: randomUUID(),
      userId: input.userId,
      installationId: input.installationId,
      mode: input.mode,
      decision: input.decision,
      consentVersion: input.consentVersion,
      consentEpoch: (previous?.consentEpoch ?? 0) + 1,
    }).returning();
    if (!row) throw new Error("product_analytics_consent_write_failed");
    return row;
  });
}

export async function getIdentityProductAnalyticsConsent(
  db: IdentityDb,
  input: Pick<ConsentInput, "userId" | "installationId" | "mode">,
) {
  return latestConsent(db, input);
}

export async function assertIdentityProductAnalyticsConsent(
  db: IdentityDb,
  input: Pick<ConsentInput, "userId" | "installationId" | "mode" | "consentVersion"> & { consentEpoch?: number },
) {
  const current = await latestConsent(db, input);
  if (!current || current.decision !== "granted" || current.consentVersion !== input.consentVersion
    || (input.consentEpoch !== undefined && current.consentEpoch !== input.consentEpoch)) {
    throw new Error("product_analytics_consent_required");
  }
  return current;
}
