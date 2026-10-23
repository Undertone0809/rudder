import type { Db } from "@rudderhq/db";
import {
  authUsers,
  boardApiKeys,
  cliAuthChallenges,
  instanceUserRoles,
  organizationMemberships,
  organizations,
} from "@rudderhq/db";
import { and, eq, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";

export function hashBearerToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function boardAuthService(db: Db) {
  async function resolveBoardAccess(userId: string) {
    const [user, memberships, adminRole] = await Promise.all([
      db
        .select({
          id: authUsers.id,
          name: authUsers.name,
          email: authUsers.email,
        })
        .from(authUsers)
        .where(eq(authUsers.id, userId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ orgId: organizationMemberships.orgId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, userId),
            eq(organizationMemberships.status, "active"),
          ),
        )
        .then((rows) => rows.map((row) => row.orgId)),
      db
        .select({ id: instanceUserRoles.id })
        .from(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .then((rows) => rows[0] ?? null),
    ]);

    return {
      user,
      orgIds: memberships,
      isInstanceAdmin: Boolean(adminRole),
    };
  }

  async function resolveBoardActivityCompanyIds(input: {
    userId: string;
    requestedCompanyId?: string | null;
    boardApiKeyId?: string | null;
  }) {
    const access = await resolveBoardAccess(input.userId);
    const orgIds = new Set(access.orgIds);

    if (orgIds.size === 0 && input.requestedCompanyId?.trim()) {
      orgIds.add(input.requestedCompanyId.trim());
    }

    if (orgIds.size === 0 && input.boardApiKeyId?.trim()) {
      const challengeCompanyIds = await db
        .select({ requestedCompanyId: cliAuthChallenges.requestedCompanyId })
        .from(cliAuthChallenges)
        .where(eq(cliAuthChallenges.boardApiKeyId, input.boardApiKeyId.trim()))
        .then((rows) =>
          rows
            .map((row) => row.requestedCompanyId?.trim() ?? null)
            .filter((value): value is string => Boolean(value)),
        );
      for (const orgId of challengeCompanyIds) {
        orgIds.add(orgId);
      }
    }

    if (orgIds.size === 0 && access.isInstanceAdmin) {
      const allCompanyIds = await db
        .select({ id: organizations.id })
        .from(organizations)
        .then((rows) => rows.map((row) => row.id));
      for (const orgId of allCompanyIds) {
        orgIds.add(orgId);
      }
    }

    return Array.from(orgIds);
  }

  async function findBoardApiKeyByToken(token: string) {
    const tokenHash = hashBearerToken(token);
    const now = new Date();
    return db
      .select()
      .from(boardApiKeys)
      .where(
        and(
          eq(boardApiKeys.keyHash, tokenHash),
          isNull(boardApiKeys.revokedAt),
        ),
      )
      .then((rows) => rows.find((row) => !row.expiresAt || row.expiresAt.getTime() > now.getTime()) ?? null);
  }

  async function touchBoardApiKey(id: string) {
    await db.update(boardApiKeys).set({ lastUsedAt: new Date() }).where(eq(boardApiKeys.id, id));
  }

  return {
    resolveBoardAccess,
    findBoardApiKeyByToken,
    touchBoardApiKey,
    resolveBoardActivityCompanyIds,
  };
}
