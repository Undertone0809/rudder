import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { IdentityDb } from "./client.js";
import { identityUsers, securityEvents } from "./schema.js";

export type IdentityProductAnalyticsWindow = { from: Date; to: Date };

/** Read-only account funnel facts. No email, provider subject, or device identifier is returned. */
export async function readIdentityProductAnalytics(db: IdentityDb, window: IdentityProductAnalyticsWindow) {
  const [accounts] = await db.select({ count: sql<number>`count(*)` }).from(identityUsers).where(and(
    gte(identityUsers.createdAt, window.from),
    lt(identityUsers.createdAt, window.to),
  ));
  const [verified] = await db.select({ count: sql<number>`count(*)` }).from(identityUsers).where(and(
    gte(identityUsers.createdAt, window.from),
    lt(identityUsers.createdAt, window.to),
    eq(identityUsers.emailVerified, true),
  ));
  const [authorized] = await db.select({ count: sql<number>`count(distinct ${securityEvents.userId})` }).from(securityEvents).where(and(
    gte(securityEvents.createdAt, window.from),
    lt(securityEvents.createdAt, window.to),
    eq(securityEvents.eventType, "device.session.created"),
  ));
  const [connected] = await db.select({ count: sql<number>`count(distinct ${securityEvents.userId})` }).from(securityEvents).where(and(
    gte(securityEvents.createdAt, window.from),
    lt(securityEvents.createdAt, window.to),
    eq(securityEvents.eventType, "server.exchange.consumed"),
  ));
  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    metrics: {
      new_accounts: Number(accounts?.count ?? 0),
      verified_accounts: Number(verified?.count ?? 0),
      desktop_authorized_accounts: Number(authorized?.count ?? 0),
      local_connected_accounts: Number(connected?.count ?? 0),
    },
    dataQuality: {
      source: "identity_security_events",
      contentFree: true,
      accountLinkedProductTelemetry: false,
    },
  };
}
