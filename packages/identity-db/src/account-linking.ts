import { normalizeVerifiedEmail } from "@rudderhq/identity-core";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { accountEmails, identityAuthAccounts, identityUsers, securityEvents } from "./schema.js";

export class IdentityCollisionError extends Error {
  constructor(message = "Verified identity is already linked to another Rudder Account") {
    super(message);
    this.name = "IdentityCollisionError";
  }
}

export type ResolveVerifiedIdentityInput = {
  provider: "google" | "github" | "email";
  providerSubject: string;
  email: string;
  emailVerified: boolean;
  name?: string | null;
  image?: string | null;
};

/**
 * Serializes verified-email resolution inside PostgreSQL.
 *
 * The advisory lock is transaction-scoped and keyed from normalized email, so
 * concurrent first logins through different providers cannot create two users.
 */
export async function resolveVerifiedIdentity(
  db: IdentityDb,
  input: ResolveVerifiedIdentityInput,
): Promise<{ userId: string; created: boolean }> {
  if (!input.emailVerified) throw new Error("Unverified provider email cannot be linked");
  const normalizedEmail = normalizeVerifiedEmail(input.email);

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalizedEmail}))`);

    const existingProvider = await tx
      .select({ userId: identityAuthAccounts.userId })
      .from(identityAuthAccounts)
      .where(
        and(
          eq(identityAuthAccounts.providerId, input.provider),
          eq(identityAuthAccounts.accountId, input.providerSubject),
        ),
      )
      .limit(1);

    const existingEmail = await tx
      .select({ userId: accountEmails.userId })
      .from(accountEmails)
      .where(eq(accountEmails.normalizedEmail, normalizedEmail))
      .limit(1);

    if (
      existingProvider[0] &&
      existingEmail[0] &&
      existingProvider[0].userId !== existingEmail[0].userId
    ) {
      throw new IdentityCollisionError();
    }

    const userId = existingProvider[0]?.userId ?? existingEmail[0]?.userId ?? randomUUID();
    const created = !existingProvider[0] && !existingEmail[0];

    if (created) {
      await tx.insert(identityUsers).values({
        id: userId,
        email: normalizedEmail,
        emailVerified: true,
        name: input.name?.trim() || normalizedEmail.split("@")[0],
        image: input.image ?? null,
      });
    }

    await tx
      .insert(accountEmails)
      .values({
        id: randomUUID(),
        userId,
        email: normalizedEmail,
        normalizedEmail,
        verifiedAt: new Date(),
        isPrimary: true,
      })
      .onConflictDoUpdate({
        target: accountEmails.normalizedEmail,
        set: { email: normalizedEmail, updatedAt: new Date() },
      });

    await tx
      .insert(identityAuthAccounts)
      .values({
        id: randomUUID(),
        userId,
        providerId: input.provider,
        accountId: input.providerSubject,
      })
      .onConflictDoNothing({
        target: [identityAuthAccounts.providerId, identityAuthAccounts.accountId],
      });

    const linkedProvider = await tx
      .select({ userId: identityAuthAccounts.userId })
      .from(identityAuthAccounts)
      .where(
        and(
          eq(identityAuthAccounts.providerId, input.provider),
          eq(identityAuthAccounts.accountId, input.providerSubject),
        ),
      )
      .limit(1);
    if (linkedProvider[0]?.userId !== userId) throw new IdentityCollisionError();

    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId,
      eventType: created ? "account.created" : "identity.linked",
      metadata: { provider: input.provider },
    });

    return { userId, created };
  });
}

export async function claimVerifiedEmail(
  db: IdentityDb,
  input: { userId: string; email: string },
): Promise<void> {
  const normalizedEmail = normalizeVerifiedEmail(input.email);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${normalizedEmail}))`);
    const owner = await tx
      .select({ userId: accountEmails.userId })
      .from(accountEmails)
      .where(eq(accountEmails.normalizedEmail, normalizedEmail))
      .limit(1);
    if (owner[0] && owner[0].userId !== input.userId) throw new IdentityCollisionError();
    await tx
      .insert(accountEmails)
      .values({
        id: randomUUID(),
        userId: input.userId,
        email: normalizedEmail,
        normalizedEmail,
        verifiedAt: new Date(),
        isPrimary: true,
      })
      .onConflictDoUpdate({
        target: accountEmails.normalizedEmail,
        set: { email: normalizedEmail, updatedAt: new Date() },
      });
  });
}
