import { hashOpaqueSecret } from "@rudderhq/identity-core";
import { and, eq, gt, isNull } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import {
  accountEmails,
  identityDevices,
  identityServerExchangeCodes,
  identityUsers,
  securityEvents,
} from "./schema.js";

const SERVER_EXCHANGE_TTL_SECONDS = 60;

export async function issueServerExchangeCode(
  db: IdentityDb,
  input: {
    userId: string;
    deviceId: string;
    installationId: string;
    audience: string;
  },
): Promise<{ code: string; expiresIn: number }> {
  if (input.audience !== input.installationId) throw new Error("invalid_audience");
  const device = await db
    .select({ id: identityDevices.id })
    .from(identityDevices)
    .where(
      and(
        eq(identityDevices.id, input.deviceId),
        eq(identityDevices.userId, input.userId),
        eq(identityDevices.installationId, input.installationId),
        isNull(identityDevices.revokedAt),
      ),
    )
    .limit(1);
  if (!device[0]) throw new Error("invalid_device");

  const code = randomBytes(32).toString("base64url");
  await db.insert(identityServerExchangeCodes).values({
    id: randomUUID(),
    codeHash: hashOpaqueSecret(code),
    userId: input.userId,
    deviceId: input.deviceId,
    installationId: input.installationId,
    audience: input.audience,
    jti: randomUUID(),
    expiresAt: new Date(Date.now() + SERVER_EXCHANGE_TTL_SECONDS * 1000),
  });
  return { code, expiresIn: SERVER_EXCHANGE_TTL_SECONDS };
}

export async function consumeServerExchangeCode(
  db: IdentityDb,
  input: { code: string; expectedAudience: string; expectedInstallationId: string },
) {
  if (input.expectedAudience !== input.expectedInstallationId) throw new Error("invalid_grant");
  const now = new Date();
  return db.transaction(async (tx) => {
    const consumed = await tx
      .update(identityServerExchangeCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(identityServerExchangeCodes.codeHash, hashOpaqueSecret(input.code)),
          eq(identityServerExchangeCodes.audience, input.expectedAudience),
          eq(identityServerExchangeCodes.installationId, input.expectedInstallationId),
          gt(identityServerExchangeCodes.expiresAt, now),
          isNull(identityServerExchangeCodes.consumedAt),
        ),
      )
      .returning({
        userId: identityServerExchangeCodes.userId,
        installationId: identityServerExchangeCodes.installationId,
        audience: identityServerExchangeCodes.audience,
        jti: identityServerExchangeCodes.jti,
        expiresAt: identityServerExchangeCodes.expiresAt,
      });
    const exchange = consumed[0];
    if (!exchange) throw new Error("invalid_grant");

    const account = await tx
      .select({
        subject: identityUsers.id,
        email: accountEmails.normalizedEmail,
        name: identityUsers.name,
      })
      .from(identityUsers)
      .innerJoin(
        accountEmails,
        and(eq(accountEmails.userId, identityUsers.id), eq(accountEmails.isPrimary, true)),
      )
      .where(eq(identityUsers.id, exchange.userId))
      .limit(1);
    if (!account[0]) throw new Error("invalid_grant");

    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: exchange.userId,
      eventType: "server.exchange.consumed",
      metadata: {
        audience: exchange.audience,
        installationId: exchange.installationId,
        jti: exchange.jti,
      },
    });
    return { ...exchange, ...account[0] };
  });
}
