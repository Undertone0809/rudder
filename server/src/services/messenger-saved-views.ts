/**
 * Organization- and board-user-scoped persistence for Messenger Saved Views.
 * Saved Views are directory items, not message threads, and deliberately carry
 * no read, unread, attention, or latest-activity state.
 */
import type { Db } from "@rudderhq/db";
import { messengerCustomGroupEntries, messengerSavedViews } from "@rudderhq/db";
import type {
  CreateMessengerSavedView,
  MessengerSavedViewTarget,
  UpdateMessengerSavedView,
} from "@rudderhq/shared";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { badRequest, notFound } from "../errors.js";
import { logActivity } from "./activity-log.js";

export type MessengerSavedViewVisibility = "visible" | "hidden" | "all";

export function messengerSavedViewItemKey(id: string) {
  return `saved-view:${id}`;
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

  async function logMutation(
    orgId: string,
    userId: string,
    action: string,
    savedView: typeof messengerSavedViews.$inferSelect,
    details?: Record<string, unknown>,
  ) {
    await logActivity(db, {
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

  async function list(orgId: string, userId: string, visibility: MessengerSavedViewVisibility = "visible") {
    const visibilityWhere = visibility === "visible"
      ? isNull(messengerSavedViews.hiddenAt)
      : visibility === "hidden"
        ? isNotNull(messengerSavedViews.hiddenAt)
        : undefined;
    return db
      .select()
      .from(messengerSavedViews)
      .where(and(ownerWhere(orgId, userId), visibilityWhere))
      .orderBy(asc(messengerSavedViews.sortOrder), asc(messengerSavedViews.createdAt));
  }

  async function get(orgId: string, userId: string, id: string) {
    const [row] = await db
      .select()
      .from(messengerSavedViews)
      .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, id)))
      .limit(1);
    if (!row) throw notFound("Messenger Saved View not found");
    return row;
  }

  async function create(orgId: string, userId: string, input: CreateMessengerSavedView) {
    const resourceKey = messengerSavedViewResourceKey(input.target);
    const existing = await db
      .select()
      .from(messengerSavedViews)
      .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.resourceKey, resourceKey)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    const now = new Date();

    if (existing) {
      const wasHidden = Boolean(existing.hiddenAt);
      const [restored] = await db
        .update(messengerSavedViews)
        .set({
          targetKind: input.target.kind,
          targetPayload: input.target,
          title: input.title,
          subtitle: input.subtitle ?? null,
          favicon: input.favicon ?? null,
          hiddenAt: null,
          updatedAt: now,
        })
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, existing.id)))
        .returning();
      await logMutation(orgId, userId, wasHidden ? "messenger.saved_view_restored" : "messenger.saved_view_updated", restored, {
        source: "create",
      });
      return restored;
    }

    const [lastVisible] = await db
      .select({ sortOrder: messengerSavedViews.sortOrder })
      .from(messengerSavedViews)
      .where(and(ownerWhere(orgId, userId), isNull(messengerSavedViews.hiddenAt)))
      .orderBy(desc(messengerSavedViews.sortOrder))
      .limit(1);
    const [created] = await db
      .insert(messengerSavedViews)
      .values({
        orgId,
        userId,
        targetKind: input.target.kind,
        targetPayload: input.target,
        resourceKey,
        title: input.title,
        subtitle: input.subtitle ?? null,
        favicon: input.favicon ?? null,
        sortOrder: (lastVisible?.sortOrder ?? -1) + 1,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messengerSavedViews.orgId,
          messengerSavedViews.userId,
          messengerSavedViews.resourceKey,
        ],
        set: {
          targetKind: input.target.kind,
          targetPayload: input.target,
          title: input.title,
          subtitle: input.subtitle ?? null,
          favicon: input.favicon ?? null,
          hiddenAt: null,
          updatedAt: now,
        },
      })
      .returning();
    await logMutation(orgId, userId, "messenger.saved_view_created", created);
    return created;
  }

  async function update(orgId: string, userId: string, id: string, patch: UpdateMessengerSavedView) {
    const existing = await get(orgId, userId, id);
    if (patch.target && messengerSavedViewResourceKey(patch.target) !== existing.resourceKey) {
      throw badRequest("Saved View target identity cannot be changed");
    }
    const wasHidden = Boolean(existing.hiddenAt);
    const nextHiddenAt = patch.hidden === undefined
      ? existing.hiddenAt
      : patch.hidden
        ? existing.hiddenAt ?? new Date()
        : null;
    const [updated] = await db
      .update(messengerSavedViews)
      .set({
        ...(patch.target ? { targetKind: patch.target.kind, targetPayload: patch.target } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.subtitle !== undefined ? { subtitle: patch.subtitle } : {}),
        ...(patch.favicon !== undefined ? { favicon: patch.favicon } : {}),
        ...(patch.hidden !== undefined ? { hiddenAt: nextHiddenAt } : {}),
        updatedAt: new Date(),
      })
      .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, id)))
      .returning();
    const isHidden = Boolean(updated.hiddenAt);
    const action = wasHidden !== isHidden
      ? isHidden ? "messenger.saved_view_hidden" : "messenger.saved_view_restored"
      : "messenger.saved_view_updated";
    await logMutation(orgId, userId, action, updated);
    return updated;
  }

  async function reorder(orgId: string, userId: string, ids: string[]) {
    if (ids.length === 0) return list(orgId, userId, "visible");
    const visible = await list(orgId, userId, "visible");
    const visibleById = new Map(visible.map((view) => [view.id, view]));
    if (ids.some((id) => !visibleById.has(id))) {
      throw notFound("Messenger Saved View not found");
    }
    const requested = new Set(ids);
    const orderedIds = [...ids, ...visible.map((view) => view.id).filter((id) => !requested.has(id))];
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [sortOrder, savedViewId] of orderedIds.entries()) {
        await tx
          .update(messengerSavedViews)
          .set({ sortOrder, updatedAt: now })
          .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, savedViewId)));
      }
    });
    const first = visibleById.get(ids[0]!);
    if (first) await logMutation(orgId, userId, "messenger.saved_views_reordered", first, { ids: orderedIds });
    return list(orgId, userId, "visible");
  }

  async function remove(orgId: string, userId: string, id: string) {
    const existing = await get(orgId, userId, id);
    await db.transaction(async (tx) => {
      await tx
        .delete(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.threadKey, messengerSavedViewItemKey(id)),
        ));
      await tx
        .delete(messengerSavedViews)
        .where(and(ownerWhere(orgId, userId), eq(messengerSavedViews.id, id)));
    });
    await logMutation(orgId, userId, "messenger.saved_view_deleted", existing);
    return existing;
  }

  return { list, get, create, update, reorder, remove };
}
