import type { Db } from "@rudderhq/db";
import {
  activityLog,
  authSessions,
  authUsers,
  externalUserBindings,
  installationAccountBindings,
  instanceUserRoles,
  organizationMemberships,
  serverExchangeRedemptions,
} from "@rudderhq/db";
import {
  offlineRequestBodyHash,
  verifyOfflineGrantAndProof,
  type OfflineGrantProof,
} from "@rudderhq/identity-core";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { conflict, forbidden, unauthorized } from "../errors.js";

const LOCAL_BOARD_USER_ID = "local-board";
const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type VerifiedServerExchange = {
  issuer: string;
  subject: string;
  audience: string;
  installationId: string;
  jti: string;
  expiresAt: Date;
  email: string;
  emailVerified: true;
  name?: string | null;
};

export interface ServerExchangeVerifier {
  verify(exchangeCode: string): Promise<VerifiedServerExchange>;
}

export type LocalAccountExchangePolicy = {
  expectedIssuer: string;
  audience: string;
  installationId: string;
  verifier: ServerExchangeVerifier;
  /** Better Auth session secret used to sign its session cookie value. */
  sessionSecret: string;
  secureCookie?: boolean;
  now?: () => Date;
  offline?: {
    identityKeyId: string;
    identityPublicKeySpki: string;
    expectedAccountId: string;
    expectedDeviceId: string;
    lastTrustedTimeMs: number;
    localSignOutEpoch: number;
  };
};

export type LocalSession = {
  id: string;
  userId: string;
  expiresAt: Date;
  setCookie: string;
};

function normalizeIssuer(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function assertExchangeClaims(claims: VerifiedServerExchange, policy: LocalAccountExchangePolicy, now: Date) {
  if (normalizeIssuer(claims.issuer) !== normalizeIssuer(policy.expectedIssuer)) {
    throw unauthorized("Server exchange issuer is not accepted");
  }
  if (claims.audience !== policy.audience) {
    throw unauthorized("Server exchange audience does not match this installation");
  }
  if (claims.installationId !== policy.installationId) {
    throw unauthorized("Server exchange installation does not match this runtime");
  }
  if (claims.expiresAt.getTime() <= now.getTime()) {
    throw unauthorized("Server exchange code has expired");
  }
  if (!claims.jti.trim() || !claims.subject.trim() || !claims.emailVerified) {
    throw unauthorized("Server exchange claims are incomplete");
  }
}

function allowedIdentityOrigin(value: string): string {
  const url = new URL(value);
  const isLoopback =
    url.protocol === "http:"
    && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (url.protocol !== "https:" && !isLoopback) {
    throw new Error("Rudder Identity verifier requires HTTPS or an explicit loopback development origin");
  }
  if (url.username || url.password) throw new Error("Rudder Identity origin cannot contain credentials");
  return url.origin;
}

function requiredString(record: Record<string, unknown>, key: string, max = 512): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw unauthorized("Rudder Identity returned invalid server exchange claims");
  }
  return value;
}

export function createIdentityServerExchangeVerifier(options: {
  identityOrigin: string;
  expectedAudience: string;
  expectedInstallationId: string;
  fetch?: typeof globalThis.fetch;
}): ServerExchangeVerifier {
  const identityOrigin = allowedIdentityOrigin(options.identityOrigin);
  const request = options.fetch ?? globalThis.fetch;
  return {
    async verify(exchangeCode: string): Promise<VerifiedServerExchange> {
      const response = await request(new URL("/api/server/exchange/verify", identityOrigin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: exchangeCode,
          expected_audience: options.expectedAudience,
          expected_installation_id: options.expectedInstallationId,
        }),
      });
      if (!response.ok) throw unauthorized("Rudder Identity rejected the server exchange");
      const value = await response.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw unauthorized("Rudder Identity returned invalid server exchange claims");
      }
      const record = value as Record<string, unknown>;
      const expiresAt = new Date(requiredString(record, "expiresAt"));
      const email = requiredString(record, "email", 320).trim().toLowerCase();
      if (Number.isNaN(expiresAt.getTime()) || !email.includes("@")) {
        throw unauthorized("Rudder Identity returned invalid server exchange claims");
      }
      // The exchange endpoint only emits users whose email was verified by
      // Rudder Identity. The local runtime accepts that assertion exclusively
      // from its pinned HTTPS (or explicit loopback-dev) issuer.
      return {
        issuer: requiredString(record, "issuer"),
        subject: requiredString(record, "subject"),
        audience: requiredString(record, "audience"),
        installationId: requiredString(record, "installationId"),
        jti: requiredString(record, "jti"),
        expiresAt,
        email,
        emailVerified: true,
        name: typeof record.name === "string" ? record.name : null,
      };
    },
  };
}

function cookieValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = Array.isArray(headers.cookie) ? headers.cookie.join(";") : headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function verifySignedSessionToken(value: string, secret: string): string | null {
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const token = value.slice(0, separator);
  const supplied = Buffer.from(value.slice(separator + 1), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", secret).update(token).digest("base64"),
    "utf8",
  );
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return token;
}

export function createLocalAccountSessionResolver(db: Db, options: {
  sessionSecret: string;
  secureCookie?: boolean;
}) {
  const cookieName = options.secureCookie
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  return async (headers: IncomingHttpHeaders) => {
    const signed = cookieValue(headers, cookieName);
    const token = signed ? verifySignedSessionToken(signed, options.sessionSecret) : null;
    if (!token) return null;
    const row = await db
      .select({
        sessionId: authSessions.id,
        userId: authUsers.id,
        email: authUsers.email,
        name: authUsers.name,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .innerJoin(authUsers, eq(authSessions.userId, authUsers.id))
      .where(eq(authSessions.token, token))
      .then((rows) => rows[0] ?? null);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    return {
      session: { id: row.sessionId, userId: row.userId },
      user: { id: row.userId, email: row.email, name: row.name },
    };
  };
}

function localSessionCookie(token: string, expiresAt: Date, secure: boolean, secret: string) {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  const signedToken = `${token}.${signature}`;
  const cookieName = secure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
  const parts = [
    `${cookieName}=${encodeURIComponent(signedToken)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function localAccountAuthService(db: Db, policy: LocalAccountExchangePolicy) {
  async function redeem(exchangeCode: string): Promise<{ userId: string; session: LocalSession }> {
    const claims = await policy.verifier.verify(exchangeCode);
    const now = policy.now?.() ?? new Date();
    assertExchangeClaims(claims, policy, now);

    const result = await db.transaction(async (tx) => {
      const redemption = await tx
        .insert(serverExchangeRedemptions)
        .values({
          issuer: normalizeIssuer(claims.issuer),
          jti: claims.jti,
          audience: claims.audience,
          subject: claims.subject,
          expiresAt: claims.expiresAt,
        })
        .onConflictDoNothing({
          target: [serverExchangeRedemptions.issuer, serverExchangeRedemptions.jti],
        })
        .returning({ id: serverExchangeRedemptions.id })
        .then((rows) => rows[0] ?? null);
      if (!redemption) throw conflict("Server exchange code has already been redeemed");

      await tx.execute(sql`
        select pg_advisory_xact_lock(
          hashtext(${normalizeIssuer(claims.issuer)}),
          hashtext(${claims.subject})
        )
      `);
      let binding = await tx
        .select({ localUserId: externalUserBindings.localUserId })
        .from(externalUserBindings)
        .where(
          and(
            eq(externalUserBindings.issuer, normalizeIssuer(claims.issuer)),
            eq(externalUserBindings.subject, claims.subject),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!binding) {
        const userId = randomUUID();
        await tx.insert(authUsers).values({
          id: userId,
          name: claims.name?.trim() || claims.email,
          email: claims.email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        });
        binding = await tx
          .insert(externalUserBindings)
          .values({
            issuer: normalizeIssuer(claims.issuer),
            subject: claims.subject,
            localUserId: userId,
            lastVerifiedAt: now,
          })
          .returning({ localUserId: externalUserBindings.localUserId })
          .then((rows) => rows[0]);
      } else {
        await tx
          .update(externalUserBindings)
          .set({ lastVerifiedAt: now })
          .where(
            and(
              eq(externalUserBindings.issuer, normalizeIssuer(claims.issuer)),
              eq(externalUserBindings.subject, claims.subject),
            ),
          );
      }

      const sessionId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(now.getTime() + LOCAL_SESSION_TTL_MS);
      await tx.insert(authSessions).values({
        id: sessionId,
        token,
        userId: binding.localUserId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(serverExchangeRedemptions)
        .set({ localUserId: binding.localUserId })
        .where(eq(serverExchangeRedemptions.id, redemption.id));

      return {
        userId: binding.localUserId,
        session: {
          id: sessionId,
          userId: binding.localUserId,
          expiresAt,
          setCookie: localSessionCookie(
            token,
            expiresAt,
            policy.secureCookie ?? true,
            policy.sessionSecret,
          ),
        },
      };
    });

    return result;
  }

  async function redeemOffline(input: {
    grant: string;
    proof: OfflineGrantProof;
    devicePublicKeySpki: string;
  }): Promise<{
    userId: string;
    session: LocalSession;
    nextTrustedTimeMs: number;
  }> {
    const offline = policy.offline;
    if (!offline) throw unauthorized("Offline Grant authentication is unavailable");
    const now = policy.now?.() ?? new Date();
    let verified: ReturnType<typeof verifyOfflineGrantAndProof>;
    try {
      verified = verifyOfflineGrantAndProof({
        grant: input.grant,
        proof: input.proof,
        identityPublicKey: createPublicKey({
          key: Buffer.from(offline.identityPublicKeySpki, "base64url"),
          format: "der",
          type: "spki",
        }),
        expectedKeyId: offline.identityKeyId,
        devicePublicKey: createPublicKey({
          key: Buffer.from(input.devicePublicKeySpki, "base64url"),
          format: "der",
          type: "spki",
        }),
        expectedIssuer: policy.expectedIssuer,
        expectedInstallationId: policy.installationId,
        expectedDeviceId: offline.expectedDeviceId,
        expectedAccountId: offline.expectedAccountId,
        expectedMethod: "POST",
        expectedPath: "/api/auth/local-offline",
        expectedBodyHash: offlineRequestBodyHash(""),
        nowMs: now.getTime(),
        lastTrustedTimeMs: offline.lastTrustedTimeMs,
        localSignOutEpoch: offline.localSignOutEpoch,
        // Durable consumption happens in the transaction below, after all
        // cryptographic and binding checks have passed.
        consumeNonce: () => true,
      });
    } catch {
      throw unauthorized("Offline Grant proof was rejected");
    }

    const result = await db.transaction(async (tx) => {
      await tx
        .delete(serverExchangeRedemptions)
        .where(lt(serverExchangeRedemptions.expiresAt, now));
      const nonceHash = createHash("sha256")
        .update(input.proof.payload.nonce)
        .digest("base64url");
      const consumed = await tx
        .insert(serverExchangeRedemptions)
        .values({
          issuer: normalizeIssuer(verified.claims.issuer),
          jti: `offline:${verified.claims.jti}:${nonceHash}`,
          audience: verified.claims.audience,
          subject: verified.claims.accountId,
          expiresAt: new Date(verified.claims.expiresAtMs),
        })
        .onConflictDoNothing({
          target: [serverExchangeRedemptions.issuer, serverExchangeRedemptions.jti],
        })
        .returning({ id: serverExchangeRedemptions.id })
        .then((rows) => rows[0] ?? null);
      if (!consumed) throw conflict("Offline Grant proof has already been redeemed");

      const binding = await tx
        .select({ localUserId: externalUserBindings.localUserId })
        .from(externalUserBindings)
        .where(and(
          eq(externalUserBindings.issuer, normalizeIssuer(verified.claims.issuer)),
          eq(externalUserBindings.subject, verified.claims.accountId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!binding) throw forbidden("Offline Grant account is not bound to this Local Workspace");

      const installation = await tx
        .select({ localUserId: installationAccountBindings.localUserId })
        .from(installationAccountBindings)
        .where(and(
          eq(installationAccountBindings.installationId, policy.installationId),
          eq(installationAccountBindings.issuer, normalizeIssuer(verified.claims.issuer)),
          eq(installationAccountBindings.subject, verified.claims.accountId),
          eq(installationAccountBindings.localUserId, binding.localUserId),
        ))
        .then((rows) => rows[0] ?? null);
      if (!installation) throw forbidden("Offline Grant does not match the claimed Local Workspace");

      const sessionId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Math.min(
        now.getTime() + LOCAL_SESSION_TTL_MS,
        verified.claims.expiresAtMs,
      ));
      await tx.insert(authSessions).values({
        id: sessionId,
        token,
        userId: binding.localUserId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      await tx
        .update(serverExchangeRedemptions)
        .set({ localUserId: binding.localUserId })
        .where(eq(serverExchangeRedemptions.id, consumed.id));

      return {
        userId: binding.localUserId,
        nextTrustedTimeMs: verified.nextTrustedTimeMs,
        session: {
          id: sessionId,
          userId: binding.localUserId,
          expiresAt,
          setCookie: localSessionCookie(
            token,
            expiresAt,
            policy.secureCookie ?? true,
            policy.sessionSecret,
          ),
        },
      };
    });
    // The server process must advance its own trusted-time floor immediately;
    // Desktop persists the same returned value for the next process start.
    offline.lastTrustedTimeMs = Math.max(
      offline.lastTrustedTimeMs,
      result.nextTrustedTimeMs,
    );
    return result;
  }

  async function claimLegacyInstallation(input: {
    installationId: string;
    issuer: string;
    subject: string;
    localUserId: string;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.installationId}))`);

      const existing = await tx
        .select()
        .from(installationAccountBindings)
        .where(eq(installationAccountBindings.installationId, input.installationId))
        .then((rows) => rows[0] ?? null);
      if (
        existing &&
        (
          normalizeIssuer(existing.issuer) !== normalizeIssuer(input.issuer) ||
          existing.subject !== input.subject ||
          existing.localUserId !== input.localUserId
        )
      ) {
        throw forbidden("This Rudder installation is already claimed by another account");
      }
      if (existing) {
        return { status: "already_claimed" as const, localUserId: existing.localUserId, orgIds: [] as string[] };
      }

      const externalBinding = await tx
        .select({ localUserId: externalUserBindings.localUserId })
        .from(externalUserBindings)
        .where(
          and(
            eq(externalUserBindings.issuer, normalizeIssuer(input.issuer)),
            eq(externalUserBindings.subject, input.subject),
            eq(externalUserBindings.localUserId, input.localUserId),
          ),
        )
        .then((rows) => rows[0] ?? null);
      if (!externalBinding) throw forbidden("The local user does not match the authenticated Rudder Account");

      const legacyMemberships = await tx
        .select()
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, LOCAL_BOARD_USER_ID),
            eq(organizationMemberships.status, "active"),
          ),
        );

      await tx.insert(installationAccountBindings).values({
        installationId: input.installationId,
        issuer: normalizeIssuer(input.issuer),
        subject: input.subject,
        localUserId: input.localUserId,
      });
      await tx
        .insert(instanceUserRoles)
        .values({ userId: input.localUserId, role: "instance_admin" })
        .onConflictDoNothing({
          target: [instanceUserRoles.userId, instanceUserRoles.role],
        });
      await tx
        .delete(instanceUserRoles)
        .where(
          and(
            eq(instanceUserRoles.userId, LOCAL_BOARD_USER_ID),
            eq(instanceUserRoles.role, "instance_admin"),
          ),
        );

      for (const membership of legacyMemberships) {
        await tx
          .insert(organizationMemberships)
          .values({
            orgId: membership.orgId,
            principalType: "user",
            principalId: input.localUserId,
            status: "active",
            membershipRole: membership.membershipRole,
          })
          .onConflictDoUpdate({
            target: [
              organizationMemberships.orgId,
              organizationMemberships.principalType,
              organizationMemberships.principalId,
            ],
            set: {
              status: "active",
              membershipRole: membership.membershipRole,
              updatedAt: new Date(),
            },
          });
        await tx
          .update(organizationMemberships)
          .set({ status: "revoked", updatedAt: new Date() })
          .where(eq(organizationMemberships.id, membership.id));
        await tx.insert(activityLog).values({
          orgId: membership.orgId,
          actorType: "user",
          actorId: input.localUserId,
          action: "installation.legacy_local_claimed",
          entityType: "installation",
          entityId: input.installationId,
          details: {
            priorPrincipalId: LOCAL_BOARD_USER_ID,
            issuer: normalizeIssuer(input.issuer),
          },
        });
      }

      return {
        status: "claimed" as const,
        localUserId: input.localUserId,
        orgIds: legacyMemberships.map((membership) => membership.orgId),
      };
    });
  }

  async function revokeAllSessions(localUserId: string) {
    return db.transaction(async (tx) => {
      const revoked = await tx
        .delete(authSessions)
        .where(eq(authSessions.userId, localUserId))
        .returning({ id: authSessions.id });
      const memberships = await tx
        .select({ orgId: organizationMemberships.orgId })
        .from(organizationMemberships)
        .where(and(
          eq(organizationMemberships.principalType, "user"),
          eq(organizationMemberships.principalId, localUserId),
          eq(organizationMemberships.status, "active"),
        ));
      if (memberships.length > 0) {
        await tx.insert(activityLog).values(memberships.map(({ orgId }) => ({
          orgId,
          actorType: "user" as const,
          actorId: localUserId,
          action: "account.local_sessions_revoked",
          entityType: "user",
          entityId: localUserId,
          details: { revokedSessionCount: revoked.length },
        })));
      }
      return { revokedSessionCount: revoked.length };
    });
  }

  return { redeem, redeemOffline, claimLegacyInstallation, revokeAllSessions };
}
