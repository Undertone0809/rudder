import type { Db } from "@rudderhq/db";
import {
  activityLog,
  instanceUserRoles,
  mcpConnections,
  mcpOAuthGrants,
  organizationMemberships,
  organizationSecrets,
  principalPermissionGrants,
} from "@rudderhq/db";
import type { PermissionKey, PrincipalType } from "@rudderhq/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { lockManagedMcpOAuthAuthorizer } from "./mcp/authorizer-lock.js";

type MembershipRow = typeof organizationMemberships.$inferSelect;
type GrantInput = {
  permissionKey: PermissionKey;
  scope?: Record<string, unknown> | null;
};

export function accessService(db: Db) {
  type AccessTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

  async function invalidateManagedMcpAuthorizations(
    tx: AccessTransaction,
    userId: string,
    input: {
      orgIds?: string[];
      retainActiveOrganizationOwners?: boolean;
    } = {},
  ): Promise<void> {
    if (input.orgIds?.length === 0) return;
    const candidates = await tx.select().from(mcpOAuthGrants)
      .where(and(
        eq(mcpOAuthGrants.authorizingUserId, userId),
        eq(mcpOAuthGrants.status, "active"),
        ...(input.orgIds ? [inArray(mcpOAuthGrants.orgId, input.orgIds)] : []),
      ));
    for (const candidate of candidates.sort((left, right) => (
      left.connectionId.localeCompare(right.connectionId)
    ))) {
      const connection = await tx.select().from(mcpConnections)
        .where(and(
          eq(mcpConnections.orgId, candidate.orgId),
          eq(mcpConnections.id, candidate.connectionId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!connection) continue;
      const grant = await tx.select().from(mcpOAuthGrants)
        .where(and(
          eq(mcpOAuthGrants.id, candidate.id),
          eq(mcpOAuthGrants.orgId, candidate.orgId),
          eq(mcpOAuthGrants.status, "active"),
          eq(mcpOAuthGrants.authorizingUserId, userId),
        ))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!grant) continue;
      if (input.retainActiveOrganizationOwners) {
        const ownerMembership = await tx.select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(and(
            eq(organizationMemberships.orgId, grant.orgId),
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, userId),
            eq(organizationMemberships.membershipRole, "owner"),
            eq(organizationMemberships.status, "active"),
          ))
          .for("share")
          .then((rows) => rows[0] ?? null);
        if (ownerMembership) continue;
      }
      const now = new Date();
      await tx.update(mcpOAuthGrants).set({
        status: "needs_reauth",
        statusMetadata: { reason: "authorizer_no_longer_authorized" },
        credentialSecretId: null,
        refreshLeaseNonce: null,
        refreshLeaseExpiresAt: null,
        updatedAt: now,
      }).where(eq(mcpOAuthGrants.id, grant.id));
      await tx.update(mcpConnections).set({
        status: "needs_reauth",
        enabled: false,
        disabledAt: now,
        lifecycleRevision: connection.lifecycleRevision + 1,
        updatedAt: now,
      }).where(and(
        eq(mcpConnections.orgId, grant.orgId),
        eq(mcpConnections.id, grant.connectionId),
      ));
      if (grant.credentialSecretId) {
        await tx.delete(organizationSecrets)
          .where(eq(organizationSecrets.id, grant.credentialSecretId));
      }
      await tx.insert(activityLog).values({
        orgId: grant.orgId,
        actorType: "system",
        actorId: "system",
        action: "mcp_oauth.reauthorization_required",
        entityType: "mcp_connection",
        entityId: grant.connectionId,
        details: { reason: "authorizer_no_longer_authorized" },
      });
    }
  }

  async function isInstanceAdmin(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const row = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    return Boolean(row);
  }

  async function getMembership(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
  ): Promise<MembershipRow | null> {
    return db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgId, orgId),
          eq(organizationMemberships.principalType, principalType),
          eq(organizationMemberships.principalId, principalId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function hasPermission(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    const membership = await getMembership(orgId, principalType, principalId);
    if (!membership || membership.status !== "active") return false;
    const grant = await db
      .select({ id: principalPermissionGrants.id })
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.orgId, orgId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);
    return Boolean(grant);
  }

  async function canUser(
    orgId: string,
    userId: string | null | undefined,
    permissionKey: PermissionKey,
  ): Promise<boolean> {
    if (!userId) return false;
    if (await isInstanceAdmin(userId)) return true;
    return hasPermission(orgId, "user", userId, permissionKey);
  }

  async function listMembers(orgId: string) {
    return db
      .select()
      .from(organizationMemberships)
      .where(eq(organizationMemberships.orgId, orgId))
      .orderBy(sql`${organizationMemberships.createdAt} desc`);
  }

  async function listActiveUserMemberships(orgId: string) {
    return db
      .select()
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.orgId, orgId),
          eq(organizationMemberships.principalType, "user"),
          eq(organizationMemberships.status, "active"),
        ),
      )
      .orderBy(sql`${organizationMemberships.createdAt} asc`);
  }

  async function setMemberPermissions(
    orgId: string,
    memberId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    const member = await db
      .select()
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.id, memberId)))
      .then((rows) => rows[0] ?? null);
    if (!member) return null;

    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.orgId, orgId),
            eq(principalPermissionGrants.principalType, member.principalType),
            eq(principalPermissionGrants.principalId, member.principalId),
          ),
        );
      if (grants.length > 0) {
        await tx.insert(principalPermissionGrants).values(
          grants.map((grant) => ({
            orgId,
            principalType: member.principalType,
            principalId: member.principalId,
            permissionKey: grant.permissionKey,
            scope: grant.scope ?? null,
            grantedByUserId,
            createdAt: new Date(),
            updatedAt: new Date(),
          })),
        );
      }
    });

    return member;
  }

  async function promoteInstanceAdmin(userId: string) {
    const existing = await db
      .select()
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return db
      .insert(instanceUserRoles)
      .values({
        userId,
        role: "instance_admin",
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function demoteInstanceAdmin(userId: string) {
    return db.transaction(async (tx) => {
      await lockManagedMcpOAuthAuthorizer(tx, userId);
      await invalidateManagedMcpAuthorizations(tx, userId, {
        retainActiveOrganizationOwners: true,
      });
      return tx
        .delete(instanceUserRoles)
        .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")))
        .returning()
        .then((rows) => rows[0] ?? null);
    });
  }

  async function listUserCompanyAccess(userId: string) {
    return db
      .select()
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.principalType, "user"), eq(organizationMemberships.principalId, userId)))
      .orderBy(sql`${organizationMemberships.createdAt} desc`);
  }

  async function setUserCompanyAccess(userId: string, orgIds: string[]) {
    const existing = await listUserCompanyAccess(userId);
    const existingByCompany = new Map(existing.map((row) => [row.orgId, row]));
    const target = new Set(orgIds);

    await db.transaction(async (tx) => {
      await lockManagedMcpOAuthAuthorizer(tx, userId);
      const toDelete = existing.filter((row) => !target.has(row.orgId)).map((row) => row.id);
      const removedOrgIds = existing
        .filter((row) => !target.has(row.orgId))
        .map((row) => row.orgId);
      await invalidateManagedMcpAuthorizations(tx, userId, { orgIds: removedOrgIds });
      if (toDelete.length > 0) {
        await tx.delete(organizationMemberships).where(inArray(organizationMemberships.id, toDelete));
      }

      for (const orgId of target) {
        if (existingByCompany.has(orgId)) continue;
        await tx.insert(organizationMemberships).values({
          orgId,
          principalType: "user",
          principalId: userId,
          status: "active",
          membershipRole: "member",
        });
      }
    });

    return listUserCompanyAccess(userId);
  }

  async function ensureMembership(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
    membershipRole: string | null = "member",
    status: "pending" | "active" | "suspended" = "active",
  ) {
    const existing = await getMembership(orgId, principalType, principalId);
    if (existing) {
      if (existing.status !== status || existing.membershipRole !== membershipRole) {
        const updated = await db.transaction(async (tx) => {
          if (
            principalType === "user"
            && existing.status === "active"
            && existing.membershipRole === "owner"
            && (status !== "active" || membershipRole !== "owner")
          ) {
            await lockManagedMcpOAuthAuthorizer(tx, principalId);
            await invalidateManagedMcpAuthorizations(tx, principalId, { orgIds: [orgId] });
          }
          return tx
            .update(organizationMemberships)
            .set({ status, membershipRole, updatedAt: new Date() })
            .where(eq(organizationMemberships.id, existing.id))
            .returning()
            .then((rows) => rows[0] ?? null);
        });
        return updated ?? existing;
      }
      return existing;
    }

    return db
      .insert(organizationMemberships)
      .values({
        orgId,
        principalType,
        principalId,
        status,
        membershipRole,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function setPrincipalGrants(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
    grants: GrantInput[],
    grantedByUserId: string | null,
  ) {
    await db.transaction(async (tx) => {
      await tx
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.orgId, orgId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
          ),
        );
      if (grants.length === 0) return;
      await tx.insert(principalPermissionGrants).values(
        grants.map((grant) => ({
          orgId,
          principalType,
          principalId,
          permissionKey: grant.permissionKey,
          scope: grant.scope ?? null,
          grantedByUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      );
    });
  }

  async function copyActiveUserMemberships(sourceCompanyId: string, targetCompanyId: string) {
    const sourceMemberships = await listActiveUserMemberships(sourceCompanyId);
    for (const membership of sourceMemberships) {
      await ensureMembership(
        targetCompanyId,
        "user",
        membership.principalId,
        membership.membershipRole,
        "active",
      );
    }
    return sourceMemberships;
  }

  async function listPrincipalGrants(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
  ) {
    return db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.orgId, orgId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
        ),
      )
      .orderBy(principalPermissionGrants.permissionKey);
  }

  async function setPrincipalPermission(
    orgId: string,
    principalType: PrincipalType,
    principalId: string,
    permissionKey: PermissionKey,
    enabled: boolean,
    grantedByUserId: string | null,
    scope: Record<string, unknown> | null = null,
  ) {
    if (!enabled) {
      await db
        .delete(principalPermissionGrants)
        .where(
          and(
            eq(principalPermissionGrants.orgId, orgId),
            eq(principalPermissionGrants.principalType, principalType),
            eq(principalPermissionGrants.principalId, principalId),
            eq(principalPermissionGrants.permissionKey, permissionKey),
          ),
        );
      return;
    }

    await ensureMembership(orgId, principalType, principalId, "member", "active");

    const existing = await db
      .select()
      .from(principalPermissionGrants)
      .where(
        and(
          eq(principalPermissionGrants.orgId, orgId),
          eq(principalPermissionGrants.principalType, principalType),
          eq(principalPermissionGrants.principalId, principalId),
          eq(principalPermissionGrants.permissionKey, permissionKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      await db
        .update(principalPermissionGrants)
        .set({
          scope,
          grantedByUserId,
          updatedAt: new Date(),
        })
        .where(eq(principalPermissionGrants.id, existing.id));
      return;
    }

    await db.insert(principalPermissionGrants).values({
      orgId,
      principalType,
      principalId,
      permissionKey,
      scope,
      grantedByUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  return {
    isInstanceAdmin,
    canUser,
    hasPermission,
    getMembership,
    ensureMembership,
    listMembers,
    listActiveUserMemberships,
    copyActiveUserMemberships,
    setMemberPermissions,
    promoteInstanceAdmin,
    demoteInstanceAdmin,
    listUserCompanyAccess,
    setUserCompanyAccess,
    setPrincipalGrants,
    listPrincipalGrants,
    setPrincipalPermission,
  };
}
