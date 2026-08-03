import type { Db } from "@rudderhq/db";
import {
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViews,
} from "@rudderhq/db";
import type {
  MessengerCustomGroupHydratedEntry,
  MessengerCustomGroupsResponse,
  MessengerDirectoryItem,
  MessengerThreadSummary,
} from "@rudderhq/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  deleteEmptyMessengerCustomGroup,
  lockMessengerCustomGroupPlacement,
  lockMessengerOwnerPlacement,
} from "./messenger-saved-views.js";

type MessengerCustomGroupListingDeps = {
  listChatSummariesByIds: (orgId: string, conversationIds: string[], userId: string) => Promise<unknown[]>;
  toChatSummary: (conversation: unknown) => MessengerThreadSummary;
  loadIssueThreadSummaryById: (orgId: string, userId: string, issueId: string) => Promise<MessengerThreadSummary | null>;
  loadSyntheticThreadSummaryByKey: (orgId: string, userId: string, threadKey: string) => Promise<MessengerThreadSummary | null>;
  chatConversationIdFromThreadKey: (threadKey: string) => string | null;
  issueIdFromThreadKey: (threadKey: string) => string | null;
  isSyntheticMessengerThreadKey: (threadKey: string) => boolean;
  savedViewIdFromItemKey: (itemKey: string) => string | null;
};

export async function listMessengerCustomGroups(
  db: Db,
  orgId: string,
  userId: string,
  deps: MessengerCustomGroupListingDeps,
): Promise<MessengerCustomGroupsResponse> {
  const [groups, entries] = await Promise.all([
    db
      .select()
      .from(messengerCustomGroups)
      .where(and(eq(messengerCustomGroups.orgId, orgId), eq(messengerCustomGroups.userId, userId)))
      .orderBy(
        sql`${messengerCustomGroups.pinnedAt} IS NULL`,
        asc(messengerCustomGroups.sortOrder),
        asc(messengerCustomGroups.createdAt),
      ),
    db
      .select()
      .from(messengerCustomGroupEntries)
      .where(and(eq(messengerCustomGroupEntries.orgId, orgId), eq(messengerCustomGroupEntries.userId, userId)))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder), asc(messengerCustomGroupEntries.createdAt)),
  ]);

  const savedViewItemKeys = entries
    .map((entry) => entry.threadKey)
    .filter((itemKey) => Boolean(deps.savedViewIdFromItemKey(itemKey)));
  const savedViewIds = savedViewItemKeys
    .map((itemKey) => deps.savedViewIdFromItemKey(itemKey))
    .filter((id): id is string => Boolean(id));
  const savedViews = savedViewIds.length > 0
    ? await db
      .select()
      .from(messengerSavedViews)
      .where(and(
        eq(messengerSavedViews.orgId, orgId),
        eq(messengerSavedViews.userId, userId),
        inArray(messengerSavedViews.id, savedViewIds),
      ))
    : [];
  const savedViewByItemKey = new Map<string, typeof messengerSavedViews.$inferSelect>(
    savedViews.map((savedView) => [`saved-view:${savedView.id}`, savedView]),
  );

  const conversationIds = entries
    .map((entry) => entry.threadKey)
    .filter((itemKey) => !deps.savedViewIdFromItemKey(itemKey))
    .map((threadKey) => deps.chatConversationIdFromThreadKey(threadKey))
    .filter((id): id is string => Boolean(id));
  const conversations = await deps.listChatSummariesByIds(orgId, conversationIds, userId);
  const summaryByThreadKey = new Map<string, MessengerThreadSummary>(
    conversations
      .filter((conversation) => (conversation as { messengerVisible?: boolean }).messengerVisible !== false)
      .map((conversation) => {
        const summary = deps.toChatSummary(conversation);
        return [summary.threadKey, summary];
      }),
  );
  const nonChatThreadKeys = [...new Set(entries
    .map((entry) => entry.threadKey)
    .filter((itemKey) => !deps.savedViewIdFromItemKey(itemKey))
    .filter((threadKey) => !deps.chatConversationIdFromThreadKey(threadKey)))];
  const issueThreadKeys = nonChatThreadKeys.filter((threadKey) => Boolean(deps.issueIdFromThreadKey(threadKey)));
  if (nonChatThreadKeys.length > 0) {
    const syntheticThreadKeys = nonChatThreadKeys.filter((threadKey) => !deps.issueIdFromThreadKey(threadKey));
    const [issueSummaries, syntheticSummaries] = await Promise.all([
      Promise.all(issueThreadKeys.map(async (threadKey) => {
        const issueId = deps.issueIdFromThreadKey(threadKey);
        return issueId ? deps.loadIssueThreadSummaryById(orgId, userId, issueId) : null;
      })),
      Promise.all(syntheticThreadKeys.map((threadKey) => deps.loadSyntheticThreadSummaryByKey(orgId, userId, threadKey))),
    ]);
    for (const summary of issueSummaries) {
      if (summary) summaryByThreadKey.set(summary.threadKey, summary);
    }
    for (const summary of syntheticSummaries) {
      if (summary) summaryByThreadKey.set(summary.threadKey, summary);
    }
  }

  const staleEntryIds: string[] = [];
  const deletedGroupIds = new Set<string>();
  const entriesByGroupId = new Map<string, MessengerCustomGroupHydratedEntry[]>();
  for (const entry of entries) {
    const savedViewId = deps.savedViewIdFromItemKey(entry.threadKey);
    if (savedViewId) {
      const savedView = savedViewByItemKey.get(entry.threadKey);
      if (!savedView) {
        staleEntryIds.push(entry.id);
        continue;
      }
      // Hidden Saved Views retain exact membership/order but stay out of the visible directory.
      if (savedView.hiddenAt) continue;
      const { threadKey: _storedItemKey, ...entryFields } = entry;
      const item = {
        type: "saved_view",
        itemKey: entry.threadKey,
        title: savedView.title,
        savedView,
      } satisfies MessengerDirectoryItem;
      const hydratedEntry = {
        ...entryFields,
        itemKey: entry.threadKey,
        item,
      } satisfies MessengerCustomGroupHydratedEntry;
      const groupEntries = entriesByGroupId.get(entry.groupId);
      if (groupEntries) groupEntries.push(hydratedEntry);
      else entriesByGroupId.set(entry.groupId, [hydratedEntry]);
      continue;
    }
    const summary = summaryByThreadKey.get(entry.threadKey);
    if (!summary) {
      if (deps.isSyntheticMessengerThreadKey(entry.threadKey)) continue;
      staleEntryIds.push(entry.id);
      continue;
    }
    const hydratedEntry = {
      ...entry,
      itemKey: entry.threadKey,
      item: { type: "thread", itemKey: entry.threadKey, title: summary.title, thread: summary },
      thread: summary,
    } satisfies MessengerCustomGroupHydratedEntry;
    const groupEntries = entriesByGroupId.get(entry.groupId);
    if (groupEntries) groupEntries.push(hydratedEntry);
    else entriesByGroupId.set(entry.groupId, [hydratedEntry]);
  }

  if (staleEntryIds.length > 0) {
    const staleSnapshots = entries
      .filter((entry) => staleEntryIds.includes(entry.id))
      .map((entry) => ({ id: entry.id, groupId: entry.groupId, threadKey: entry.threadKey }));
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await lockMessengerOwnerPlacement(txDb, orgId, userId);
      const currentEntries = await txDb
        .select({ id: messengerCustomGroupEntries.id, groupId: messengerCustomGroupEntries.groupId, threadKey: messengerCustomGroupEntries.threadKey })
        .from(messengerCustomGroupEntries)
        .where(and(
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          inArray(messengerCustomGroupEntries.id, staleEntryIds),
        ));
      const affectedGroupIds = [...new Set([
        ...staleSnapshots.map((entry) => entry.groupId),
        ...currentEntries.map((entry) => entry.groupId),
      ])].sort();
      for (const groupId of affectedGroupIds) {
        await lockMessengerCustomGroupPlacement(txDb, orgId, userId, groupId);
      }
      const snapshotById = new Map(staleSnapshots.map((entry) => [entry.id, entry]));
      for (const entry of currentEntries) {
        const snapshot = snapshotById.get(entry.id);
        if (!snapshot || snapshot.groupId !== entry.groupId || snapshot.threadKey !== entry.threadKey) continue;
        await txDb.delete(messengerCustomGroupEntries).where(and(
          eq(messengerCustomGroupEntries.id, entry.id),
          eq(messengerCustomGroupEntries.orgId, orgId),
          eq(messengerCustomGroupEntries.userId, userId),
          eq(messengerCustomGroupEntries.groupId, entry.groupId),
          eq(messengerCustomGroupEntries.threadKey, entry.threadKey),
        ));
      }
      for (const groupId of affectedGroupIds) {
        if (await deleteEmptyMessengerCustomGroup(txDb, orgId, userId, groupId)) deletedGroupIds.add(groupId);
      }
    });
  }

  return {
    groups: groups.filter((group) => !deletedGroupIds.has(group.id)).map((group) => ({
      ...group,
      entries: entriesByGroupId.get(group.id) ?? [],
    })),
  };
}
