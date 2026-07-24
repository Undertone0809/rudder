/**
 * Organization- and board-user-scoped persistence for Messenger Saved Views.
 * Saved Views are directory items, not message threads, and deliberately carry
 * no read, unread, attention, or latest-activity state.
 */
import type { Db } from "@rudderhq/db";
import {
  chatConversations,
  issues,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViewMutations,
  messengerSavedViews,
} from "@rudderhq/db";
import {
  messengerSavedViewIdSchema,
  messengerSavedViewTargetSchema,
  type KeepMessengerSavedView,
  type MessengerSavedViewTarget,
  type UpdateMessengerSavedView,
} from "@rudderhq/shared";
import { and, asc, count, desc, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { badRequest, conflict, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type MessengerSavedViewVisibility = "visible" | "hidden" | "all";
export type MessengerSavedViewListOptions = {
  visibility?: MessengerSavedViewVisibility;
  limit?: number;
  offset?: number;
  primaryRailPinned?: boolean;
};
const MAX_PRIMARY_RAIL_PINS = 100;

function savedViewPlacementLockKey(orgId: string, userId: string) {
  return `messenger-saved-views:${orgId}:${userId}`;
}

function customGroupPlacementLockKey(orgId: string, userId: string, groupId: string) {
  return `messenger-custom-group:${orgId}:${userId}:${groupId}`;
}

/**
 * Serializes all Saved View identity and placement mutations for one owner.
 * Callers that also need a group lock must acquire this lock first.
 */
export async function lockMessengerSavedViewPlacement(database: Db, orgId: string, userId: string) {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${savedViewPlacementLockKey(orgId, userId)}))`);
}

/** Serializes entry allocation and mutation within one custom group. */
export async function lockMessengerCustomGroupPlacement(
  database: Db,
  orgId: string,
  userId: string,
  groupId: string,
) {
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${customGroupPlacementLockKey(orgId, userId, groupId)}))`);
}

function assertSavedViewId(id: string) {
  const parsed = messengerSavedViewIdSchema.safeParse(id);
  if (!parsed.success) throw badRequest("Invalid Messenger Saved View id");
  return parsed.data;
}

function validatedTarget(target: MessengerSavedViewTarget) {
  const parsed = messengerSavedViewTargetSchema.safeParse(target);
  if (!parsed.success) throw badRequest("Invalid Messenger Saved View target", parsed.error.issues);
  return parsed.data;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function keepRequestFingerprint(input: KeepMessengerSavedView, target: MessengerSavedViewTarget) {
  return createHash("sha256").update(stableJson({
    version: 1,
    target,
    title: input.title,
    subtitle: input.subtitle ?? null,
    favicon: input.favicon ?? null,
    placement: input.placement,
  })).digest("hex");
}

export function messengerSavedViewItemKey(id: string) {
  return `saved-view:${assertSavedViewId(id)}`;
}

export function messengerSavedViewResourceKey(target: MessengerSavedViewTarget) {
  return `view-instance:${target.viewInstanceId}`;
}

export function messengerSavedViewCanonicalResourceKey(target: MessengerSavedViewTarget) {
  switch (target.kind) {
    case "browser":
      return `browser:${target.tabId}`;
    case "automation":
      return `automation:${target.automationId}`;
    case "library_document":
      return `library-document:${target.documentId}`;
    case "library_entry":
      return `library-entry:${target.entryId}`;
    case "library_file":
      return `library-file:${target.filePath}`;
    case "library_directory":
      return `library-directory:${target.directoryPath}`;
    case "local_app":
      return `local-app:${JSON.stringify([
        target.desktopInstallationId,
        target.appPublicId,
        target.localBindingId,
      ])}`;
  }
}

export function messengerSavedViewsService(db: Db) {
  const ownerWhere = (orgId: string, userId: string) => and(
    eq(messengerSavedViews.orgId, orgId),
    eq(messengerSavedViews.userId, userId),
  );
  async function logMutation(
    database: Db,
    orgId: string,
    userId: string,
    action: string,
    savedView: Pick<typeof messengerSavedViews.$inferSelect, "id" | "targetKind" | "resourceKey">,
    details?: Record<string, unknown>,
  ) {
    await logActivity(database, {
      orgId,
      actorType: "user",
      actorId: userId,
      action,
      entityType: "messenger_saved_view",
      entityId: savedView.id,
      details: {
        targetKind: savedView.targetKind,
        resourceKey: savedView.resourceKey,
        ...details,
      },
    });
  }

  function visibilityWhere(visibility: MessengerSavedViewVisibility) {
    return visibility === "visible"
      ? isNull(messengerSavedViews.hiddenAt)
      : visibility === "hidden"
        ? isNotNull(messengerSavedViews.hiddenAt)
        : undefined;
  }

  async function list(orgId: string, userId: string, options: MessengerSavedViewListOptions = {}) {
    const visibility = options.visibility ?? "visible";
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const offset = Math.max(options.offset ?? 0, 0);
    const where = and(
      ownerWhere(orgId, userId),
      visibilityWhere(visibility),
      options.primaryRailPinned ? isNotNull(messengerSavedViews.primaryRailPinnedAt) : undefined,
    );
    const [items, totalRows] = await Promise.all([
      db
        .select()
        .from(messengerSavedViews)
        .where(where)
        .orderBy(asc(messengerSavedViews.sortOrder), asc(messengerSavedViews.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ value: count() }).from(messengerSavedViews).where(where),
    ]);
    const total = totalRows[0]?.value ?? 0;
    const hasMore = offset + items.length < total;
    return {
      items,
      pageInfo: {
        limit,
        offset,
        total,
        hasMore,
        nextOffset: hasMore ? offset + items.length : null,
      },
    };
  }

  async function getWithDb(database: Db, orgId: string, userId: string, id: string) {
    const validId = assertSavedViewId(id);
    const [row] = await database
      .select()
      .from(messengerSavedViews)
      .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, validId)))
      .limit(1);
    if (!row) throw notFound("Messenger Saved View not found");
    return row;
  }

  async function get(orgId: string, userId: string, id: string) {
    return getWithDb(db, orgId, userId, id);
  }

  async function update(orgId: string, userId: string, id: string, patch: UpdateMessengerSavedView) {
    const validId = assertSavedViewId(id);
    const requestedHidden = (patch as { hidden?: unknown }).hidden;
    if (requestedHidden !== undefined && requestedHidden !== false) {
      throw badRequest("Messenger Saved Views cannot be hidden");
    }
    const target = patch.target ? validatedTarget(patch.target) : undefined;
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      const existing = await getWithDb(txDb, orgId, userId, validId);
      if (patch.primaryRailPinned !== undefined && existing.targetKind !== "local_app") {
        throw badRequest("Only Local App Saved Views can be pinned to the Primary Rail");
      }
      if (patch.primaryRailPinned && !existing.primaryRailPinnedAt) {
        const [pinnedRows] = await txDb
          .select({ value: count() })
          .from(messengerSavedViews)
          .where(and(
            ownerWhere(orgId, userId),
            isNotNull(messengerSavedViews.primaryRailPinnedAt),
          ));
        if ((pinnedRows?.value ?? 0) >= MAX_PRIMARY_RAIL_PINS) {
          throw badRequest(`Primary Rail supports up to ${MAX_PRIMARY_RAIL_PINS} pinned Local Apps`);
        }
      }
      if (target && (
        target.viewInstanceId !== existing.instanceId
        || messengerSavedViewCanonicalResourceKey(target) !== existing.canonicalResourceKey
      )) {
        throw badRequest("Saved View target identity cannot be changed");
      }
      const wasHidden = Boolean(existing.hiddenAt);
      const nextHiddenAt = patch.hidden === false ? null : existing.hiddenAt;
      const [updated] = await txDb
        .update(messengerSavedViews)
        .set({
          ...(target ? { targetKind: target.kind, targetPayload: target } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
          ...(patch.favicon !== undefined ? { favicon: patch.favicon } : {}),
          ...(patch.hidden !== undefined ? { hiddenAt: nextHiddenAt } : {}),
          ...(patch.primaryRailPinned !== undefined
            ? { primaryRailPinnedAt: patch.primaryRailPinned ? new Date() : null }
            : {}),
          updatedAt: new Date(),
        })
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, validId)))
        .returning();
      const isHidden = Boolean(updated.hiddenAt);
      const action = wasHidden !== isHidden
        ? "messenger.saved_view_restored"
        : "messenger.saved_view_updated";
      await logMutation(
        txDb,
        orgId,
        userId,
        action,
        updated,
        patch.primaryRailPinned === undefined
          ? undefined
          : { primaryRailPinned: patch.primaryRailPinned },
      );
      return updated;
    });
  }

  async function reorder(orgId: string, userId: string, ids: string[]) {
    const validIds = ids.map(assertSavedViewId);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      const placements = await txDb
        .select({
          id: messengerSavedViews.id,
          sortOrder: messengerSavedViews.sortOrder,
          hiddenAt: messengerSavedViews.hiddenAt,
          targetKind: messengerSavedViews.targetKind,
          resourceKey: messengerSavedViews.resourceKey,
        })
        .from(messengerSavedViews)
        .where(ownerWhere(orgId, userId))
        .orderBy(asc(messengerSavedViews.sortOrder), asc(messengerSavedViews.createdAt));
      const visible = placements.filter((view) => !view.hiddenAt);
      const visibleById = new Map(visible.map((view) => [view.id, view]));
      if (validIds.some((savedViewId) => !visibleById.has(savedViewId))) {
        throw notFound("Messenger Saved View not found");
      }
      const requested = new Set(validIds);
      const orderedIds = [...validIds, ...visible.map((view) => view.id).filter((savedViewId) => !requested.has(savedViewId))];
      const visibleSlots = visible.map((view) => view.sortOrder);
      const now = new Date();
      for (const [index, savedViewId] of orderedIds.entries()) {
        await txDb
          .update(messengerSavedViews)
          .set({ sortOrder: visibleSlots[index], updatedAt: now })
          .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, savedViewId)));
      }
      const evidence = validIds[0] ? visibleById.get(validIds[0]) : null;
      if (evidence) {
        await logMutation(txDb, orgId, userId, "messenger.saved_views_reordered", evidence, { ids: orderedIds });
      }
    });
    return list(orgId, userId);
  }

  async function remove(orgId: string, userId: string, id: string) {
    const validId = assertSavedViewId(id);
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);
      const existing = await getWithDb(txDb, orgId, userId, validId);
      const memberships = await txDb
        .select({ groupId: messengerCustomGroupEntries.groupId })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.threadKey, messengerSavedViewItemKey(validId)),
        ));
      for (const groupId of [...new Set(memberships.map((membership) => membership.groupId))].sort()) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      }
      await txDb
        .delete(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.threadKey, messengerSavedViewItemKey(validId)),
        ));
      await txDb
        .delete(messengerSavedViews)
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, validId)));
      await logMutation(txDb, orgId, userId, "messenger.saved_view_deleted", existing);
      return existing;
    });
  }

  async function keep(orgId: string, userId: string, input: KeepMessengerSavedView) {
    const target = validatedTarget(input.target);
    const instanceId = target.viewInstanceId;
    const resourceKey = messengerSavedViewResourceKey(target);
    const canonicalResourceKey = messengerSavedViewCanonicalResourceKey(target);
    const requestFingerprint = keepRequestFingerprint(input, target);

    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerSavedViewPlacement(txDb, orgId, userId);

      const [receipt] = await txDb.select().from(messengerSavedViewMutations).where(and(
        eq(messengerSavedViewMutations.orgId, orgId),
        eq(messengerSavedViewMutations.userId, userId),
        eq(messengerSavedViewMutations.clientMutationId, input.clientMutationId),
      )).limit(1);
      if (receipt) {
        if (receipt.requestFingerprint !== requestFingerprint) {
          throw conflict("This Saved View mutation id was already used with different input");
        }
        const savedView = await txDb.select().from(messengerSavedViews).where(and(
          ownerWhere(orgId, userId),
          eq(messengerSavedViews.id, receipt.savedViewId),
        )).limit(1).then((rows) => rows[0] ?? null);
        if (!savedView) {
          throw conflict("The result of this Saved View mutation is no longer available");
        }
        if (receipt.groupId === null) {
          const membership = await txDb.select({ id: messengerCustomGroupEntries.id })
            .from(messengerCustomGroupEntries)
            .where(and(
              eq(messengerCustomGroupEntries.orgId, orgId),
              eq(messengerCustomGroupEntries.userId, userId),
              eq(messengerCustomGroupEntries.threadKey, messengerSavedViewItemKey(receipt.savedViewId)),
            )).limit(1).then((rows) => rows[0] ?? null);
          if (membership) {
            throw conflict("The result of this Saved View mutation is no longer available");
          }
          return { savedView, group: null };
        }
        const [group, membership] = await Promise.all([
          txDb.select().from(messengerCustomGroups).where(and(
            eq(messengerCustomGroups.orgId, orgId),
            eq(messengerCustomGroups.userId, userId),
            eq(messengerCustomGroups.id, receipt.groupId),
          )).limit(1).then((rows) => rows[0] ?? null),
          txDb.select({ id: messengerCustomGroupEntries.id }).from(messengerCustomGroupEntries).where(and(
            eq(messengerCustomGroupEntries.orgId, orgId),
            eq(messengerCustomGroupEntries.userId, userId),
            eq(messengerCustomGroupEntries.groupId, receipt.groupId),
            eq(messengerCustomGroupEntries.threadKey, messengerSavedViewItemKey(receipt.savedViewId)),
          )).limit(1).then((rows) => rows[0] ?? null),
        ]);
        if (!group || !membership) {
          throw conflict("The result of this Saved View mutation is no longer available");
        }
        return { savedView, group: { id: group.id, name: group.name } };
      }

      const [byMutation, byInstance] = await Promise.all([
        txDb.select().from(messengerSavedViews).where(and(
          ownerWhere(orgId, userId),
          eq(messengerSavedViews.clientMutationId, input.clientMutationId),
        )).limit(1).then((rows) => rows[0] ?? null),
        txDb.select().from(messengerSavedViews).where(and(
          ownerWhere(orgId, userId),
          eq(messengerSavedViews.instanceId, instanceId),
        )).limit(1).then((rows) => rows[0] ?? null),
      ]);
      if (byMutation && byMutation.instanceId !== instanceId) {
        throw conflict("This Saved View mutation id was already used for a different view instance");
      }
      if (byMutation && byMutation.canonicalResourceKey !== canonicalResourceKey) {
        throw conflict("This Saved View mutation id was already used for a different target");
      }
      if (byMutation && byInstance && byMutation.id !== byInstance.id) {
        throw conflict("Saved View mutation and instance identities refer to different records");
      }
      const existing = byMutation ?? byInstance;
      if (existing && existing.canonicalResourceKey !== canonicalResourceKey) {
        throw conflict("This view instance is already associated with a different target");
      }

      let group: typeof messengerCustomGroups.$inferSelect | null = null;
      if (input.placement.kind === "group") {
        const [ownedGroup] = await txDb.select().from(messengerCustomGroups).where(and(
          eq(messengerCustomGroups.orgId, orgId),
          eq(messengerCustomGroups.userId, userId),
          eq(messengerCustomGroups.id, input.placement.groupId),
        )).limit(1);
        if (!ownedGroup) throw notFound("Messenger custom group not found");
        group = ownedGroup;
      } else if (input.placement.kind === "anchor") {
        const anchor = input.placement.anchor;
        let anchorKey: string;
        let anchorTitle: string;
        if (anchor.kind === "chat") {
          const [conversation] = await txDb.select({
            title: chatConversations.title,
          }).from(chatConversations).where(and(
            eq(chatConversations.id, anchor.conversationId),
            eq(chatConversations.orgId, orgId),
            eq(chatConversations.messengerVisible, true),
            ne(chatConversations.status, "archived"),
          )).limit(1);
          if (!conversation) throw notFound("Messenger Chat anchor not found");
          anchorKey = `chat:${anchor.conversationId}`;
          anchorTitle = (conversation.title.trim() || "Chat").slice(0, 80);
        } else {
          const [issue] = await txDb.select({ title: issues.title }).from(issues).where(and(
            eq(issues.id, anchor.issueId),
            eq(issues.orgId, orgId),
            isNull(issues.hiddenAt),
          )).limit(1);
          if (!issue) throw notFound("Messenger Issue anchor not found");
          anchorKey = `issue:${anchor.issueId}`;
          anchorTitle = (issue.title.trim() || "Issue").slice(0, 80);
        }

        const [anchorMembership] = await txDb.select({ groupId: messengerCustomGroupEntries.groupId })
          .from(messengerCustomGroupEntries)
          .where(and(
            eq(messengerCustomGroupEntries.orgId, orgId),
            eq(messengerCustomGroupEntries.userId, userId),
            eq(messengerCustomGroupEntries.threadKey, anchorKey),
          )).limit(1);
        if (anchorMembership) {
          const [ownedGroup] = await txDb.select().from(messengerCustomGroups).where(and(
            eq(messengerCustomGroups.orgId, orgId),
            eq(messengerCustomGroups.userId, userId),
            eq(messengerCustomGroups.id, anchorMembership.groupId),
          )).limit(1);
          if (!ownedGroup) throw conflict("Messenger anchor group is unavailable");
          group = ownedGroup;
        } else {
          const [lastGroup] = await txDb.select({ sortOrder: messengerCustomGroups.sortOrder })
            .from(messengerCustomGroups)
            .where(and(eq(messengerCustomGroups.orgId, orgId), eq(messengerCustomGroups.userId, userId)))
            .orderBy(desc(messengerCustomGroups.sortOrder))
            .limit(1);
          const now = new Date();
          [group] = await txDb.insert(messengerCustomGroups).values({
            orgId,
            userId,
            name: anchorTitle,
            sortOrder: (lastGroup?.sortOrder ?? -1) + 1,
            updatedAt: now,
          }).returning();
          await lockMessengerCustomGroupPlacement(txDb, orgId, userId, group.id);
          await txDb.insert(messengerCustomGroupEntries).values({
            orgId,
            userId,
            groupId: group.id,
            threadKey: anchorKey,
            sortOrder: 0,
            updatedAt: now,
          });
        }
      }

      const itemKey = existing ? messengerSavedViewItemKey(existing.id) : null;
      const existingMembership = itemKey
        ? await txDb.select({ groupId: messengerCustomGroupEntries.groupId })
          .from(messengerCustomGroupEntries)
          .where(and(
            eq(messengerCustomGroupEntries.orgId, orgId),
            eq(messengerCustomGroupEntries.userId, userId),
            eq(messengerCustomGroupEntries.threadKey, itemKey),
          )).limit(1).then((rows) => rows[0] ?? null)
        : null;
      const affectedGroupIds = [...new Set(
        [existingMembership?.groupId, group?.id].filter((id): id is string => Boolean(id)),
      )].sort();
      for (const affectedGroupId of affectedGroupIds) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, affectedGroupId);
      }
      if (byMutation) {
        const exactReplay = isDeepStrictEqual(byMutation.targetPayload, target)
          && byMutation.title === input.title
          && byMutation.subtitle === (input.subtitle ?? null)
          && byMutation.favicon === (input.favicon ?? null);
        if (!exactReplay) {
          throw conflict("This Saved View mutation id was already used with different input");
        }
        const placementUnchanged = group
          ? existingMembership?.groupId === group.id
          : !existingMembership;
        if (!byMutation.hiddenAt && placementUnchanged) {
          await txDb.insert(messengerSavedViewMutations).values({
            orgId,
            userId,
            clientMutationId: input.clientMutationId,
            savedViewId: byMutation.id,
            groupId: group?.id ?? null,
            requestFingerprint,
          });
          return {
            savedView: byMutation,
            group: group ? { id: group.id, name: group.name } : null,
          };
        }
      }
      const now = new Date();
      let savedView: typeof messengerSavedViews.$inferSelect;
      let action: string | null;
      if (existing) {
        const wasHidden = Boolean(existing.hiddenAt);
        const unchanged = !wasHidden
          && (group ? existingMembership?.groupId === group.id : !existingMembership)
          && isDeepStrictEqual(existing.targetPayload, target)
          && existing.title === input.title
          && existing.subtitle === (input.subtitle ?? null)
          && existing.favicon === (input.favicon ?? null);
        if (unchanged) {
          savedView = existing;
          action = null;
        } else {
          [savedView] = await txDb.update(messengerSavedViews).set({
            targetKind: target.kind,
            targetPayload: target,
            canonicalResourceKey,
            clientMutationId: existing.clientMutationId ?? input.clientMutationId,
            title: input.title,
            subtitle: input.subtitle ?? null,
            favicon: input.favicon ?? null,
            hiddenAt: null,
            updatedAt: now,
          }).where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, existing.id))).returning();
          action = wasHidden ? "messenger.saved_view_restored" : "messenger.saved_view_updated";
        }
      } else {
        const [last] = await txDb.select({ sortOrder: messengerSavedViews.sortOrder })
          .from(messengerSavedViews)
          .where(ownerWhere(orgId, userId))
          .orderBy(desc(messengerSavedViews.sortOrder))
          .limit(1);
        [savedView] = await txDb.insert(messengerSavedViews).values({
          orgId,
          userId,
          targetKind: target.kind,
          targetPayload: target,
          resourceKey,
          instanceId,
          canonicalResourceKey,
          clientMutationId: input.clientMutationId,
          title: input.title,
          subtitle: input.subtitle ?? null,
          favicon: input.favicon ?? null,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          updatedAt: now,
        }).returning();
        action = "messenger.saved_view_created";
      }
      if (action) await logMutation(txDb, orgId, userId, action, savedView, { source: "keep" });

      const savedItemKey = messengerSavedViewItemKey(savedView.id);
      if (existingMembership && existingMembership.groupId !== group?.id) {
        await txDb.delete(messengerCustomGroupEntries).where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.groupId, existingMembership.groupId),
          eq(messengerCustomGroupEntries.threadKey, savedItemKey),
        ));
        await logMutation(txDb, orgId, userId, "messenger.saved_view_group_removed", savedView, {
          groupId: existingMembership.groupId,
          source: "keep",
        });
      }
      if (group && existingMembership?.groupId !== group.id) {
        const [lastEntry] = await txDb.select({ sortOrder: messengerCustomGroupEntries.sortOrder })
          .from(messengerCustomGroupEntries)
          .where(and(
            eq(messengerCustomGroupEntries.orgId, orgId),
            eq(messengerCustomGroupEntries.userId, userId),
            eq(messengerCustomGroupEntries.groupId, group.id),
          )).orderBy(desc(messengerCustomGroupEntries.sortOrder)).limit(1);
        await txDb.insert(messengerCustomGroupEntries).values({
          orgId,
          userId,
          groupId: group.id,
          threadKey: savedItemKey,
          sortOrder: (lastEntry?.sortOrder ?? -1) + 1,
          updatedAt: now,
        });
        await logMutation(txDb, orgId, userId, "messenger.saved_view_group_assigned", savedView, {
          groupId: group.id,
          source: "keep",
        });
      }

      await txDb.insert(messengerSavedViewMutations).values({
        orgId,
        userId,
        clientMutationId: input.clientMutationId,
        savedViewId: savedView.id,
        groupId: group?.id ?? null,
        requestFingerprint,
      });

      return {
        savedView,
        group: group ? { id: group.id, name: group.name } : null,
      };
    });
  }

  return { list, get, keep, update, reorder, remove };
}
