import type { Db } from "@rudderhq/db";
import { agentIntegrationUserBindings, organizationMemberships } from "@rudderhq/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { isPostgresError } from "../../postgres-errors.js";

export function feishuIntegrationUserBindingService(db: Db) {
  return {
    bindActiveOrgUserByOpenId: async (input: {
      orgId: string;
      integrationId: string;
      userId: string;
      externalOpenId: string;
      externalUnionId?: string | null;
    }) => {
      const membership = await db
        .select({ id: organizationMemberships.id })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.orgId, input.orgId),
            eq(organizationMemberships.principalType, "user"),
            eq(organizationMemberships.principalId, input.userId),
            eq(organizationMemberships.status, "active"),
          ),
        )
        .then((rows) => rows[0] ?? null);

      if (!membership) return null;

      const existingConditions = [
        eq(agentIntegrationUserBindings.integrationId, input.integrationId),
        isNull(agentIntegrationUserBindings.revokedAt),
      ];
      const identityCondition = input.externalUnionId
        ? or(
          eq(agentIntegrationUserBindings.externalOpenId, input.externalOpenId),
          eq(agentIntegrationUserBindings.externalUnionId, input.externalUnionId),
        )
        : eq(agentIntegrationUserBindings.externalOpenId, input.externalOpenId);
      if (!identityCondition) return null;

      const existing = await db
        .select()
        .from(agentIntegrationUserBindings)
        .where(and(...existingConditions, identityCondition))
        .then((rows) => rows[0] ?? null);
      if (existing) return existing;

      try {
        return await db
          .insert(agentIntegrationUserBindings)
          .values({
            orgId: input.orgId,
            integrationId: input.integrationId,
            userId: input.userId,
            externalOpenId: input.externalOpenId,
            externalUnionId: input.externalUnionId ?? null,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      } catch (error) {
        if (!isPostgresError(error, "23505")) throw error;
        return db
          .select()
          .from(agentIntegrationUserBindings)
          .where(and(...existingConditions, identityCondition))
          .then((rows) => rows[0] ?? null);
      }
    },
  };
}
