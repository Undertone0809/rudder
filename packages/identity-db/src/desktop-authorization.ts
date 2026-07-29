import { hashOpaqueSecret } from "@rudderhq/identity-core";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import {
  deviceAccessCredentials,
  deviceRefreshCredentials,
  identityAuthorizationCodes,
  identityDevices,
  identityUsers,
  securityEvents,
} from "./schema.js";

const AUTHORIZATION_CODE_TTL_SECONDS = 120;
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export async function issueDesktopAuthorizationCode(
  db: IdentityDb,
  input: {
    userId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    audience: string;
  },
): Promise<{ code: string; expiresIn: number }> {
  const code = randomSecret();
  await db.insert(identityAuthorizationCodes).values({
    id: randomUUID(),
    codeHash: hashOpaqueSecret(code),
    userId: input.userId,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: "S256",
    audience: input.audience,
    jti: randomUUID(),
    expiresAt: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000),
  });
  return { code, expiresIn: AUTHORIZATION_CODE_TTL_SECONDS };
}

export async function redeemDesktopAuthorizationCode(
  db: IdentityDb,
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    installationId: string;
    deviceName: string;
    devicePublicKeyThumbprint?: string | null;
  },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const redeemed = await tx
      .update(identityAuthorizationCodes)
      .set({ consumedAt: now })
      .where(
        and(
          eq(identityAuthorizationCodes.codeHash, hashOpaqueSecret(input.code)),
          eq(identityAuthorizationCodes.clientId, input.clientId),
          eq(identityAuthorizationCodes.redirectUri, input.redirectUri),
          eq(identityAuthorizationCodes.audience, input.installationId),
          eq(identityAuthorizationCodes.codeChallenge, pkceS256(input.codeVerifier)),
          isNull(identityAuthorizationCodes.consumedAt),
          gt(identityAuthorizationCodes.expiresAt, now),
        ),
      )
      .returning({
        userId: identityAuthorizationCodes.userId,
        codeChallenge: identityAuthorizationCodes.codeChallenge,
      });
    const authorization = redeemed[0];
    if (!authorization) {
      throw new Error("invalid_grant");
    }

    const existingDevice = await tx
      .select({ id: identityDevices.id })
      .from(identityDevices)
      .where(
        and(
          eq(identityDevices.userId, authorization.userId),
          eq(identityDevices.installationId, input.installationId),
        ),
      )
      .limit(1);
    const deviceId = existingDevice[0]?.id ?? randomUUID();
    await tx
      .insert(identityDevices)
      .values({
        id: deviceId,
        userId: authorization.userId,
        installationId: input.installationId,
        displayName: input.deviceName.slice(0, 160),
        publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
      })
      .onConflictDoUpdate({
        target: [identityDevices.userId, identityDevices.installationId],
        set: {
          displayName: input.deviceName.slice(0, 160),
          publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
          lastSeenAt: now,
          revokedAt: null,
        },
      });

    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    await tx.insert(deviceAccessCredentials).values({
      id: randomUUID(),
      deviceId,
      secretHash: hashOpaqueSecret(accessToken),
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    await tx.insert(deviceRefreshCredentials).values({
      id: randomUUID(),
      deviceId,
      clientId: input.clientId,
      secretHash: hashOpaqueSecret(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });

    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: authorization.userId,
      deviceId,
      eventType: "device.session.created",
      metadata: { clientId: input.clientId, installationId: input.installationId },
    });

    const users = await tx
      .select({
        id: identityUsers.id,
        email: identityUsers.email,
        name: identityUsers.name,
        image: identityUsers.image,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, authorization.userId))
      .limit(1);
    const user = users[0];
    if (!user) throw new Error("invalid_grant");

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      account: user,
      device: {
        id: deviceId,
        installationId: input.installationId,
        displayName: input.deviceName.slice(0, 160),
        publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
      },
    };
  });
}

export async function issueDesktopDeviceSession(
  db: IdentityDb,
  input: {
    userId: string;
    clientId: string;
    installationId: string;
    deviceName: string;
    devicePublicKeyThumbprint?: string | null;
  },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const existingDevice = await tx
      .select({ id: identityDevices.id })
      .from(identityDevices)
      .where(
        and(
          eq(identityDevices.userId, input.userId),
          eq(identityDevices.installationId, input.installationId),
        ),
      )
      .limit(1);
    const deviceId = existingDevice[0]?.id ?? randomUUID();
    const displayName = input.deviceName.slice(0, 160);
    await tx
      .insert(identityDevices)
      .values({
        id: deviceId,
        userId: input.userId,
        installationId: input.installationId,
        displayName,
        publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
      })
      .onConflictDoUpdate({
        target: [identityDevices.userId, identityDevices.installationId],
        set: {
          displayName,
          publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
          lastSeenAt: now,
          revokedAt: null,
        },
      });

    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    await tx.insert(deviceAccessCredentials).values({
      id: randomUUID(),
      deviceId,
      secretHash: hashOpaqueSecret(accessToken),
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1_000),
    });
    await tx.insert(deviceRefreshCredentials).values({
      id: randomUUID(),
      deviceId,
      clientId: input.clientId,
      secretHash: hashOpaqueSecret(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1_000),
    });
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: input.userId,
      deviceId,
      eventType: "device.session.created",
      metadata: { clientId: input.clientId, installationId: input.installationId },
    });

    const [user] = await tx
      .select({
        id: identityUsers.id,
        email: identityUsers.email,
        name: identityUsers.name,
        image: identityUsers.image,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, input.userId))
      .limit(1);
    if (!user) throw new Error("invalid_grant");
    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      account: user,
      device: {
        id: deviceId,
        installationId: input.installationId,
        displayName,
        publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
      },
    };
  });
}

export async function resolveDeviceAccessToken(db: IdentityDb, accessToken: string) {
  const rows = await db
    .select({
      userId: identityDevices.userId,
      deviceId: identityDevices.id,
    })
    .from(deviceAccessCredentials)
    .innerJoin(identityDevices, eq(deviceAccessCredentials.deviceId, identityDevices.id))
    .where(
      and(
        eq(deviceAccessCredentials.secretHash, hashOpaqueSecret(accessToken)),
        gt(deviceAccessCredentials.expiresAt, new Date()),
        isNull(deviceAccessCredentials.revokedAt),
        isNull(identityDevices.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function rotateDeviceRefreshToken(
  db: IdentityDb,
  input: { refreshToken: string; clientId: string },
) {
  const now = new Date();
  return db.transaction(async (tx) => {
    const current = await tx
      .select({
        id: deviceRefreshCredentials.id,
        deviceId: identityDevices.id,
        userId: identityDevices.userId,
        installationId: identityDevices.installationId,
        displayName: identityDevices.displayName,
        publicKeyThumbprint: identityDevices.publicKeyThumbprint,
      })
      .from(deviceRefreshCredentials)
      .innerJoin(identityDevices, eq(deviceRefreshCredentials.deviceId, identityDevices.id))
      .where(
        and(
          eq(deviceRefreshCredentials.secretHash, hashOpaqueSecret(input.refreshToken)),
          eq(deviceRefreshCredentials.clientId, input.clientId),
          gt(deviceRefreshCredentials.expiresAt, now),
          isNull(deviceRefreshCredentials.revokedAt),
          isNull(identityDevices.revokedAt),
        ),
      )
      .limit(1);
    const credential = current[0];
    if (!credential) throw new Error("invalid_grant");

    const consumed = await tx
      .update(deviceRefreshCredentials)
      .set({ rotatedAt: now, revokedAt: now })
      .where(
        and(
          eq(deviceRefreshCredentials.id, credential.id),
          isNull(deviceRefreshCredentials.revokedAt),
        ),
      )
      .returning({ id: deviceRefreshCredentials.id });
    if (!consumed[0]) throw new Error("invalid_grant");

    const accessToken = randomSecret();
    const refreshToken = randomSecret();
    await tx.insert(deviceAccessCredentials).values({
      id: randomUUID(),
      deviceId: credential.deviceId,
      secretHash: hashOpaqueSecret(accessToken),
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    });
    await tx.insert(deviceRefreshCredentials).values({
      id: randomUUID(),
      deviceId: credential.deviceId,
      clientId: input.clientId,
      secretHash: hashOpaqueSecret(refreshToken),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    });
    await tx
      .update(identityDevices)
      .set({ lastSeenAt: now })
      .where(eq(identityDevices.id, credential.deviceId));

    const users = await tx
      .select({
        id: identityUsers.id,
        email: identityUsers.email,
        name: identityUsers.name,
        image: identityUsers.image,
      })
      .from(identityUsers)
      .where(eq(identityUsers.id, credential.userId))
      .limit(1);
    if (!users[0]) throw new Error("invalid_grant");

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      account: users[0],
      device: {
        id: credential.deviceId,
        installationId: credential.installationId,
        displayName: credential.displayName,
        publicKeyThumbprint: credential.publicKeyThumbprint,
      },
    };
  });
}

export async function listIdentityDevices(db: IdentityDb, userId: string) {
  return db
    .select({
      id: identityDevices.id,
      installationId: identityDevices.installationId,
      displayName: identityDevices.displayName,
      createdAt: identityDevices.createdAt,
      lastSeenAt: identityDevices.lastSeenAt,
      revokedAt: identityDevices.revokedAt,
    })
    .from(identityDevices)
    .where(and(eq(identityDevices.userId, userId), isNull(identityDevices.revokedAt)))
    .orderBy(desc(identityDevices.lastSeenAt));
}

export async function revokeIdentityDevice(
  db: IdentityDb,
  input: { userId: string; deviceId: string },
): Promise<boolean> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(identityDevices)
      .set({ revokedAt: now })
      .where(and(eq(identityDevices.id, input.deviceId), eq(identityDevices.userId, input.userId)))
      .returning({ id: identityDevices.id });
    if (!revoked[0]) return false;
    await tx
      .update(deviceAccessCredentials)
      .set({ revokedAt: now })
      .where(and(eq(deviceAccessCredentials.deviceId, input.deviceId), isNull(deviceAccessCredentials.revokedAt)));
    await tx
      .update(deviceRefreshCredentials)
      .set({ revokedAt: now })
      .where(and(eq(deviceRefreshCredentials.deviceId, input.deviceId), isNull(deviceRefreshCredentials.revokedAt)));
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: input.userId,
      deviceId: input.deviceId,
      eventType: "device.revoked",
      metadata: {},
    });
    return true;
  });
}

export async function revokeAllIdentityDevices(
  db: IdentityDb,
  input: { userId: string; reason: "password-reset" | "password-change" },
): Promise<number> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const revoked = await tx
      .update(identityDevices)
      .set({ revokedAt: now })
      .where(and(eq(identityDevices.userId, input.userId), isNull(identityDevices.revokedAt)))
      .returning({ id: identityDevices.id });
    if (revoked.length === 0) return 0;
    const deviceIds = revoked.map((device) => device.id);
    for (const deviceId of deviceIds) {
      await tx
        .update(deviceAccessCredentials)
        .set({ revokedAt: now })
        .where(and(eq(deviceAccessCredentials.deviceId, deviceId), isNull(deviceAccessCredentials.revokedAt)));
      await tx
        .update(deviceRefreshCredentials)
        .set({ revokedAt: now })
        .where(and(eq(deviceRefreshCredentials.deviceId, deviceId), isNull(deviceRefreshCredentials.revokedAt)));
    }
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: input.userId,
      eventType: "device.sessions.revoked",
      metadata: { reason: input.reason, count: revoked.length },
    });
    return revoked.length;
  });
}
