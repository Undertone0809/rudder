import type { Db } from "@rudderhq/db";
import {
  entityTombstones,
  organizationIssuePrefixAliases,
  organizations,
} from "@rudderhq/db";
import { and, eq } from "drizzle-orm";

export type TombstoneEntityType = "issue" | "chat";

export type CreateEntityTombstoneInput = {
  orgId: string;
  entityType: TombstoneEntityType;
  entityId: string;
  title: string;
  issueNumber?: number | null;
  deletedByActorType: "agent" | "user" | "system";
  deletedByActorId: string;
  deletedAt?: Date;
};

export function entityTombstoneService(db: Db) {
  return {
    create: async (input: CreateEntityTombstoneInput) => {
      const [row] = await db
        .insert(entityTombstones)
        .values({
          ...input,
          issueNumber: input.issueNumber ?? null,
          deletedAt: input.deletedAt ?? new Date(),
        })
        .onConflictDoNothing({
          target: [entityTombstones.entityType, entityTombstones.entityId],
        })
        .returning();
      if (row) return row;
      return db
        .select()
        .from(entityTombstones)
        .where(
          and(
            eq(entityTombstones.entityType, input.entityType),
            eq(entityTombstones.entityId, input.entityId),
          ),
        )
        .then((rows) => rows[0] ?? null);
    },

    getByEntityId: (entityType: TombstoneEntityType, entityId: string) =>
      db
        .select()
        .from(entityTombstones)
        .where(
          and(
            eq(entityTombstones.entityType, entityType),
            eq(entityTombstones.entityId, entityId),
          ),
        )
        .then((rows) => rows[0] ?? null),

    getIssueByNumber: (orgId: string, issueNumber: number) =>
      db
        .select()
        .from(entityTombstones)
        .where(
          and(
            eq(entityTombstones.orgId, orgId),
            eq(entityTombstones.entityType, "issue"),
            eq(entityTombstones.issueNumber, issueNumber),
          ),
        )
        .then((rows) => rows[0] ?? null),

    getIssueByIdentifier: async (identifier: string) => {
      const match = identifier.trim().toUpperCase().match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
      if (!match) return null;
      const prefix = match[1]!;
      const issueNumber = Number(match[2]);
      const currentOrg = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.issuePrefix, prefix))
        .then((rows) => rows[0] ?? null);
      const aliasOrg = currentOrg
        ? null
        : await db
          .select({ id: organizationIssuePrefixAliases.orgId })
          .from(organizationIssuePrefixAliases)
          .where(eq(organizationIssuePrefixAliases.prefix, prefix))
          .then((rows) => rows[0] ?? null);
      const orgId = currentOrg?.id ?? aliasOrg?.id ?? null;
      if (!orgId) return null;
      return db
        .select()
        .from(entityTombstones)
        .where(and(
          eq(entityTombstones.orgId, orgId),
          eq(entityTombstones.entityType, "issue"),
          eq(entityTombstones.issueNumber, issueNumber),
        ))
        .then((rows) => rows[0] ?? null);
    },
  };
}

export function entityDeletedResponse(tombstone: {
  entityType: string;
  entityId: string;
  title: string;
  issueNumber: number | null;
  deletedAt: Date;
}) {
  return {
    error: `${tombstone.entityType === "issue" ? "Issue" : "Chat"} has been deleted`,
    code: "ENTITY_DELETED",
    tombstone: {
      entityType: tombstone.entityType,
      id: tombstone.entityId,
      title: tombstone.title,
      issueNumber: tombstone.issueNumber,
      deletedAt: tombstone.deletedAt,
    },
  };
}
