/**
 * Organization- and board-user-scoped persistence for Messenger Saved Views.
 * Saved Views are directory items, not message threads, and deliberately carry
 * no read, unread, attention, or latest-activity state.
 */
import type { Db } from "@rudderhq/db";
import { messengerCustomGroupEntries, messengerSavedViews } from "@rudderhq/db";
import {
  messengerSavedViewIdSchema,
  messengerSavedViewTargetSchema,
  type CreateMessengerSavedView,
  type MessengerSavedViewTarget,
  type UpdateMessengerSavedView,
} from "@rudderhq/shared";
import { and, asc, count, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type MessengerSavedViewVisibility = "visible" | "hidden" | "all";
export type MessengerSavedViewListOptions = {
  visibility?: MessengerSavedViewVisibility;
  limit?: number;
  offset?: number;
};

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

export function messengerSavedViewItemKey(id: string) {
  return `saved-view:${assertSavedViewId(id)}`;
}

export function messengerSavedViewResourceKey(target: MessengerSavedViewTarget) {
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
  }
}

export function messengerSavedViewsService(db: Db) {
  const ownerWhere = (orgId: string, userId: string) => and(
    eq(messengerSavedViews.orgId, orgId),
    eq(messengerSavedViews.userId, userId),
  );
  const placementLockKey = (orgId: string, userId: string) => `messenger-saved-views:${orgId}:${userId}`;

  async function lockPlacement(database: Db, orgId: string, userId: string) {
    await database.execute(sql`select pg_advisory_xact_lock(hashtext(${placementLockKey(orgId, userId)}))`);
  }

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
    const where = and(ownerWhere(orgId, userId), visibilityWhere(visibility));
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

  async function create(orgId: string, userId: string, input: CreateMessengerSavedView) {
    const target = validatedTarget(input.target);
    const resourceKey = messengerSavedViewResourceKey(target);
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockPlacement(txDb, orgId, userId);
      const existing = await txDb
        .select()
        .from(messengerSavedViews)
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.resourceKey, resourceKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const now = new Date();
      if (existing) {
        const wasHidden = Boolean(existing.hiddenAt);
        const [updated] = await txDb
          .update(messengerSavedViews)
          .set({
            targetKind: target.kind,
            targetPayload: target,
            title: input.title,
            subtitle: input.subtitle ?? null,
            favicon: input.favicon ?? null,
            hiddenAt: null,
            updatedAt: now,
          })
          .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, existing.id)))
          .returning();
        await logMutation(
          txDb,
          orgId,
          userId,
          wasHidden ? "messenger.saved_view_restored" : "messenger.saved_view_updated",
          updated,
          { source: "create" },
        );
        return updated;
      }

      const [last] = await txDb
        .select({ sortOrder: messengerSavedViews.sortOrder })
        .from(messengerSavedViews)
        .where(ownerWhere(orgId, userId))
        .orderBy(desc(messengerSavedViews.sortOrder))
        .limit(1);
      const [created] = await txDb
        .insert(messengerSavedViews)
        .values({
          orgId,
          userId,
          targetKind: target.kind,
          targetPayload: target,
          resourceKey,
          title: input.title,
          subtitle: input.subtitle ?? null,
          favicon: input.favicon ?? null,
          sortOrder: (last?.sortOrder ?? -1) + 1,
          updatedAt: now,
        })
        .returning();
      await logMutation(txDb, orgId, userId, "messenger.saved_view_created", created);
      return created;
    });
  }

  async function update(orgId: string, userId: string, id: string, patch: UpdateMessengerSavedView) {
    const validId = assertSavedViewId(id);
    const target = patch.target ? validatedTarget(patch.target) : undefined;
    return db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockPlacement(txDb, orgId, userId);
      const existing = await getWithDb(txDb, orgId, userId, validId);
      if (target && messengerSavedViewResourceKey(target) !== existing.resourceKey) {
        throw badRequest("Saved View target identity cannot be changed");
      }
      const wasHidden = Boolean(existing.hiddenAt);
      const nextHiddenAt = patch.hidden === undefined
        ? existing.hiddenAt
        : patch.hidden
          ? existing.hiddenAt ?? new Date()
          : null;
      const [updated] = await txDb
        .update(messengerSavedViews)
        .set({
          ...(target ? { targetKind: target.kind, targetPayload: target } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
          ...(patch.favicon !== undefined ? { favicon: patch.favicon } : {}),
          ...(patch.hidden !== undefined ? { hiddenAt: nextHiddenAt } : {}),
          updatedAt: new Date(),
        })
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, validId)))
        .returning();
      const isHidden = Boolean(updated.hiddenAt);
      const action = wasHidden !== isHidden
        ? isHidden ? "messenger.saved_view_hidden" : "messenger.saved_view_restored"
        : "messenger.saved_view_updated";
      await logMutation(txDb, orgId, userId, action, updated);
      return updated;
    });
  }

  async function reorder(orgId: string, userId: string, ids: string[]) {
    const validIds = ids.map(assertSavedViewId);
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockPlacement(txDb, orgId, userId);
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
      await lockPlacement(txDb, orgId, userId);
      const existing = await getWithDb(txDb, orgId, userId, validId);
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

  return { list, get, create, update, reorder, remove };
}
