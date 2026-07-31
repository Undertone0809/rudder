import { hashOpaqueSecret } from "@rudderhq/identity-core";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { hasPendingCredentialRevocationIntent } from "./credential-revocation.js";
import {
  deviceAccessCredentials,
  deviceRefreshCredentials,
  identityAuthState,
  identityDeviceCodes,
  identityDevices,
  identityUsers,
  securityEvents,
} from "./schema.js";

export const DEVICE_AUTHORIZATION_DEFAULT_TTL_SECONDS = 10 * 60;
export const DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const DEVICE_AUTHORIZATION_SLOW_DOWN_SECONDS = 5;

const USER_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export type DeviceAuthorizationPollRecord = {
  clientId: string | null;
  status: string;
  userId: string | null;
  expiresAt: Date;
  lastPolledAt: Date | null;
  pollingInterval: number | null;
};

export type DeviceAuthorizationPollDecision =
  | { status: "authorization_pending"; interval: number }
  | { status: "slow_down"; interval: number }
  | { status: "approved"; userId: string }
  | { status: "access_denied" }
  | { status: "expired_token" }
  | { status: "invalid_client" }
  | { status: "invalid_grant" };

export type DeviceAuthorizationMutationResult =
  | { status: "approved"; userId: string }
  | { status: "denied"; userId: string }
  | { status: "expired_token" }
  | { status: "invalid_user_code" }
  | { status: "user_mismatch" };

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function normalizeDeviceAuthorizationUserCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(/[\s-]/gu, "");
}

export function hashDeviceAuthorizationCode(value: string): string {
  return hashOpaqueSecret(requireNonEmpty(value, "deviceCode"));
}

export function generateDeviceAuthorizationCodes(): {
  deviceCode: string;
  userCode: string;
} {
  const bytes = randomBytes(8);
  let compactUserCode = "";
  for (const byte of bytes) {
    compactUserCode += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  }
  return {
    deviceCode: randomBytes(32).toString("base64url"),
    userCode: `${compactUserCode.slice(0, 4)}-${compactUserCode.slice(4)}`,
  };
}

export function evaluateDeviceAuthorizationPoll(
  record: DeviceAuthorizationPollRecord,
  input: { clientId: string; now: Date },
): DeviceAuthorizationPollDecision {
  if (record.clientId !== input.clientId) return { status: "invalid_client" };
  if (record.expiresAt.getTime() <= input.now.getTime()) {
    return { status: "expired_token" };
  }

  const interval = Math.max(
    DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
    record.pollingInterval ??
      DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
  );

  switch (record.status) {
    case "pending": {
      if (
        record.lastPolledAt &&
        input.now.getTime() <
          record.lastPolledAt.getTime() + interval * 1_000
      ) {
        return {
          status: "slow_down",
          interval: interval + DEVICE_AUTHORIZATION_SLOW_DOWN_SECONDS,
        };
      }
      return { status: "authorization_pending", interval };
    }
    case "approved":
      return record.userId
        ? { status: "approved", userId: record.userId }
        : { status: "invalid_grant" };
    case "denied":
      return { status: "access_denied" };
    default:
      return { status: "invalid_grant" };
  }
}

export async function issueDeviceAuthorization(
  db: IdentityDb,
  input: {
    clientId: string;
    scope?: string | null;
    expiresIn?: number;
    pollingInterval?: number;
    now?: Date;
  },
): Promise<{
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}> {
  const clientId = requireNonEmpty(input.clientId, "clientId");
  const expiresIn = Math.max(
    60,
    Math.floor(input.expiresIn ?? DEVICE_AUTHORIZATION_DEFAULT_TTL_SECONDS),
  );
  const interval = Math.max(
    DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
    Math.floor(
      input.pollingInterval ??
        DEVICE_AUTHORIZATION_DEFAULT_POLL_INTERVAL_SECONDS,
    ),
  );
  const now = input.now ?? new Date();
  const codes = generateDeviceAuthorizationCodes();

  await db.insert(identityDeviceCodes).values({
    id: randomUUID(),
    deviceCodeHash: hashDeviceAuthorizationCode(codes.deviceCode),
    userCode: normalizeDeviceAuthorizationUserCode(codes.userCode),
    expiresAt: new Date(now.getTime() + expiresIn * 1_000),
    status: "pending",
    pollingInterval: interval,
    clientId,
    scope: input.scope?.trim() || null,
  });

  return { ...codes, expiresIn, interval };
}

export async function verifyDeviceAuthorization(
  db: IdentityDb,
  input: { userCode: string; now?: Date },
): Promise<
  | {
      status: "pending";
      clientId: string;
      scope: string | null;
      expiresAt: Date;
    }
  | { status: "expired_token" }
  | { status: "invalid_user_code" }
> {
  const userCode = normalizeDeviceAuthorizationUserCode(input.userCode);
  if (!userCode) return { status: "invalid_user_code" };
  const now = input.now ?? new Date();
  const [request] = await db
    .select({
      clientId: identityDeviceCodes.clientId,
      scope: identityDeviceCodes.scope,
      expiresAt: identityDeviceCodes.expiresAt,
      status: identityDeviceCodes.status,
    })
    .from(identityDeviceCodes)
    .where(eq(identityDeviceCodes.userCode, userCode))
    .limit(1);

  if (!request || request.status !== "pending" || !request.clientId) {
    return { status: "invalid_user_code" };
  }
  if (request.expiresAt.getTime() <= now.getTime()) {
    return { status: "expired_token" };
  }
  return {
    status: "pending",
    clientId: request.clientId,
    scope: request.scope,
    expiresAt: request.expiresAt,
  };
}

async function resolveDeviceAuthorization(
  db: IdentityDb,
  input: {
    userCode: string;
    userId: string;
    resolution: "approved" | "denied";
    now?: Date;
  },
): Promise<DeviceAuthorizationMutationResult> {
  const userCode = normalizeDeviceAuthorizationUserCode(input.userCode);
  const userId = requireNonEmpty(input.userId, "userId");
  if (!userCode) return { status: "invalid_user_code" };
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select({
        id: identityDeviceCodes.id,
        status: identityDeviceCodes.status,
        userId: identityDeviceCodes.userId,
        expiresAt: identityDeviceCodes.expiresAt,
      })
      .from(identityDeviceCodes)
      .where(eq(identityDeviceCodes.userCode, userCode))
      .limit(1)
      .for("update");

    if (!request) return { status: "invalid_user_code" };
    if (request.expiresAt.getTime() <= now.getTime()) {
      await tx
        .delete(identityDeviceCodes)
        .where(eq(identityDeviceCodes.id, request.id));
      return { status: "expired_token" };
    }
    if (request.userId && request.userId !== userId) {
      return { status: "user_mismatch" };
    }
    if (request.status === "approved" && request.userId === userId) {
      return { status: "approved", userId };
    }
    if (request.status === "denied" && request.userId === userId) {
      return { status: "denied", userId };
    }
    if (request.status !== "pending") {
      return { status: "invalid_user_code" };
    }

    await tx
      .update(identityDeviceCodes)
      .set({ status: input.resolution, userId })
      .where(
        and(
          eq(identityDeviceCodes.id, request.id),
          eq(identityDeviceCodes.status, "pending"),
          gt(identityDeviceCodes.expiresAt, now),
        ),
      );
    return { status: input.resolution, userId };
  });
}

export async function approveDeviceAuthorization(
  db: IdentityDb,
  input: { userCode: string; userId: string; now?: Date },
): Promise<DeviceAuthorizationMutationResult> {
  return resolveDeviceAuthorization(db, { ...input, resolution: "approved" });
}

export async function denyDeviceAuthorization(
  db: IdentityDb,
  input: { userCode: string; userId: string; now?: Date },
): Promise<DeviceAuthorizationMutationResult> {
  return resolveDeviceAuthorization(db, { ...input, resolution: "denied" });
}

export async function pollDeviceAuthorization(
  db: IdentityDb,
  input: { deviceCode: string; clientId: string; now?: Date },
): Promise<DeviceAuthorizationPollDecision> {
  const deviceCode = requireNonEmpty(input.deviceCode, "deviceCode");
  const clientId = requireNonEmpty(input.clientId, "clientId");
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const deviceCodeHash = hashDeviceAuthorizationCode(deviceCode);
    const [request] = await tx
      .select()
      .from(identityDeviceCodes)
      .where(
        or(
          eq(identityDeviceCodes.deviceCodeHash, deviceCodeHash),
          // Rollback-window compatibility for already-issued, short-lived rows.
          eq(identityDeviceCodes.deviceCode, deviceCode),
        ),
      )
      .limit(1)
      .for("update");
    if (!request) return { status: "invalid_grant" };

    const decision = evaluateDeviceAuthorizationPoll(request, {
      clientId,
      now,
    });
    switch (decision.status) {
      case "authorization_pending":
        await tx
          .update(identityDeviceCodes)
          .set({ lastPolledAt: now })
          .where(eq(identityDeviceCodes.id, request.id));
        return decision;
      case "slow_down":
        await tx
          .update(identityDeviceCodes)
          .set({
            lastPolledAt: now,
            pollingInterval: decision.interval,
          })
          .where(eq(identityDeviceCodes.id, request.id));
        return decision;
      case "approved":
      case "access_denied":
      case "expired_token":
      case "invalid_grant":
        await tx
          .delete(identityDeviceCodes)
          .where(eq(identityDeviceCodes.id, request.id));
        return decision;
      case "invalid_client":
        return decision;
    }
  });
}

const DEVICE_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const DEVICE_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Consumes an approved code and creates the device session in one transaction.
 * Database failures roll the code consumption back, so the client can retry
 * without losing an approved authorization.
 */
export async function redeemApprovedDeviceAuthorization(
  db: IdentityDb,
  input: {
    deviceCode: string;
    clientId: string;
    installationId: string;
    deviceName: string;
    devicePublicKeyThumbprint?: string | null;
    now?: Date;
  },
): Promise<
  | Exclude<DeviceAuthorizationPollDecision, { status: "approved" }>
  | {
      status: "approved";
      session: {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
        account: { id: string; email: string; name: string; image: string | null };
        device: {
          id: string;
          installationId: string;
          displayName: string;
          publicKeyThumbprint: string | null;
        };
        offlineGrantState: {
          authSchemaEpoch: number;
          accountAuthEpoch: number;
          deviceAuthEpoch: number;
        };
      };
    }
> {
  const deviceCode = requireNonEmpty(input.deviceCode, "deviceCode");
  const clientId = requireNonEmpty(input.clientId, "clientId");
  const installationId = requireNonEmpty(input.installationId, "installationId");
  const displayName = requireNonEmpty(input.deviceName, "deviceName").slice(0, 160);
  const now = input.now ?? new Date();
  const deviceCodeHash = hashDeviceAuthorizationCode(deviceCode);

  return db.transaction(async (tx) => {
    const [request] = await tx
      .select()
      .from(identityDeviceCodes)
      .where(
        or(
          eq(identityDeviceCodes.deviceCodeHash, deviceCodeHash),
          eq(identityDeviceCodes.deviceCode, deviceCode),
        ),
      )
      .limit(1)
      .for("update");
    if (!request) return { status: "invalid_grant" } as const;

    const decision = evaluateDeviceAuthorizationPoll(request, { clientId, now });
    if (decision.status === "authorization_pending") {
      await tx
        .update(identityDeviceCodes)
        .set({ lastPolledAt: now })
        .where(eq(identityDeviceCodes.id, request.id));
      return decision;
    }
    if (decision.status === "slow_down") {
      await tx
        .update(identityDeviceCodes)
        .set({ lastPolledAt: now, pollingInterval: decision.interval })
        .where(eq(identityDeviceCodes.id, request.id));
      return decision;
    }
    if (decision.status !== "approved") {
      if (decision.status !== "invalid_client") {
        await tx
          .delete(identityDeviceCodes)
          .where(eq(identityDeviceCodes.id, request.id));
      }
      return decision;
    }
    if (
      await hasPendingCredentialRevocationIntent(
        tx as unknown as IdentityDb,
        decision.userId,
      )
    ) {
      throw new Error("credential_revocation_pending");
    }

    const [existingDevice] = await tx
      .select({ id: identityDevices.id })
      .from(identityDevices)
      .where(
        and(
          eq(identityDevices.userId, decision.userId),
          eq(identityDevices.installationId, installationId),
        ),
      )
      .limit(1);
    const deviceId = existingDevice?.id ?? randomUUID();
    await tx
      .insert(identityDevices)
      .values({
        id: deviceId,
        userId: decision.userId,
        installationId,
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

    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    await tx.insert(deviceAccessCredentials).values({
      id: randomUUID(),
      deviceId,
      secretHash: hashOpaqueSecret(accessToken),
      expiresAt: new Date(
        now.getTime() + DEVICE_ACCESS_TOKEN_TTL_SECONDS * 1_000,
      ),
    });
    await tx.insert(deviceRefreshCredentials).values({
      id: randomUUID(),
      deviceId,
      clientId,
      secretHash: hashOpaqueSecret(refreshToken),
      expiresAt: new Date(
        now.getTime() + DEVICE_REFRESH_TOKEN_TTL_SECONDS * 1_000,
      ),
    });
    const [account] = await tx
      .select({
        id: identityUsers.id,
        email: identityUsers.email,
        name: identityUsers.name,
        image: identityUsers.image,
        accountAuthEpoch: identityUsers.authEpoch,
        deviceAuthEpoch: identityDevices.authEpoch,
        authSchemaEpoch: identityAuthState.offlineGrantSchemaEpoch,
      })
      .from(identityUsers)
      .innerJoin(identityDevices, eq(identityDevices.id, deviceId))
      .leftJoin(identityAuthState, eq(identityAuthState.id, "global"))
      .where(eq(identityUsers.id, decision.userId))
      .limit(1);
    if (!account) throw new Error("invalid_grant");
    await tx.insert(securityEvents).values({
      id: randomUUID(),
      userId: decision.userId,
      deviceId,
      eventType: "device.session.created",
      metadata: { clientId, installationId },
    });
    await tx
      .delete(identityDeviceCodes)
      .where(
        and(
          eq(identityDeviceCodes.id, request.id),
          isNull(identityDeviceCodes.consumedAt),
        ),
      );

    return {
      status: "approved",
      session: {
        accessToken,
        refreshToken,
        expiresIn: DEVICE_ACCESS_TOKEN_TTL_SECONDS,
        account: {
          id: account.id,
          email: account.email,
          name: account.name,
          image: account.image,
        },
        device: {
          id: deviceId,
          installationId,
          displayName,
          publicKeyThumbprint: input.devicePublicKeyThumbprint ?? null,
        },
        offlineGrantState: {
          authSchemaEpoch: account.authSchemaEpoch ?? 2,
          accountAuthEpoch: account.accountAuthEpoch,
          deviceAuthEpoch: account.deviceAuthEpoch,
        },
      },
    };
  });
}
