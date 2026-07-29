import { createHmac, randomUUID } from "node:crypto";
import type { IdentityDb } from "./client.js";
import { securityEvents } from "./schema.js";

export type SecurityEventInput = {
  eventType: string;
  userId?: string | null;
  deviceId?: string | null;
  ipAddress?: string | null;
  ipHashKey: string;
  userAgent?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export function hashSecurityEventIp(ipAddress: string, key: string): string {
  return createHmac("sha256", key)
    .update("rudder.identity.security-event.ip.v1\u0000", "utf8")
    .update(ipAddress, "utf8")
    .digest("base64url");
}

export async function recordSecurityEvent(db: IdentityDb, input: SecurityEventInput): Promise<void> {
  const ipHash = input.ipAddress
    ? hashSecurityEventIp(input.ipAddress, input.ipHashKey)
    : null;
  await db.insert(securityEvents).values({
    id: randomUUID(),
    userId: input.userId ?? null,
    deviceId: input.deviceId ?? null,
    eventType: input.eventType,
    ipHash,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    metadata: input.metadata ?? {},
  });
}
