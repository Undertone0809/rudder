import type { Db } from "@rudderhq/db";
import {
  activityLog,
  chatConversationUserStates,
  issueFollows,
  issueReadStates,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViewMutations,
  messengerSavedViews,
  messengerThreadUserStates,
  operatorProfiles,
  organizationMemberships,
} from "@rudderhq/db";
import { and, eq, inArray, or, sql, type SQLWrapper } from "drizzle-orm";
import { createHash } from "node:crypto";
import { lockMessengerOwnerPlacement } from "./messenger-saved-views.js";

const LEGACY_BOARD_USER_ID = "local-board";
const LEGACY_STATE_COPIED_ACTION = "installation.legacy_operator_state_copied";
const CUSTOM_GROUP_REMOVED_ACTION = "messenger.custom_group_removed";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function deterministicUuid(sourceId: string, targetUserId: string) {
  const hex = createHash("md5")
    .update(`${sourceId}:${targetUserId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function chunks<T>(values: T[], size = 250): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

export async function copyLegacyOperatorState(
  tx: Transaction,
  input: {
    installationId: string;
    targetUserId: string;
  },
) {
  const scopedMemberships = await tx
    .select({ orgId: organizationMemberships.orgId })
    .from(organizationMemberships)
    .where(and(
      eq(organizationMemberships.principalType, "user"),
      eq(organizationMemberships.status, "active"),
      or(
        eq(organizationMemberships.principalId, LEGACY_BOARD_USER_ID),
        eq(organizationMemberships.principalId, input.targetUserId),
      ),
    ));
  const orgIds = Array.from(new Set(scopedMemberships.map((row) => row.orgId)));
  if (orgIds.length === 0) return { status: "no_scoped_organizations" as const, orgIds };
  for (const orgId of [...orgIds].sort()) {
    for (const userId of [LEGACY_BOARD_USER_ID, input.targetUserId].sort()) {
      await lockMessengerOwnerPlacement(tx, orgId, userId);
    }
  }
  const inScope = (orgId: SQLWrapper) =>
    sql`${orgId} in (${sql.join(orgIds.map((orgId) => sql`${orgId}`), sql`, `)})`;

  const legacyGroups = await tx
    .select()
    .from(messengerCustomGroups)
    .where(and(eq(messengerCustomGroups.userId, LEGACY_BOARD_USER_ID), inScope(messengerCustomGroups.orgId)));
  const deterministicGroupIds = legacyGroups.map((group) => deterministicUuid(group.id, input.targetUserId));
  const removedTargetGroupIds = deterministicGroupIds.length > 0
    ? new Set((await tx
      .select({ groupId: activityLog.entityId })
      .from(activityLog)
      .where(and(
        eq(activityLog.actorType, "user"),
        eq(activityLog.actorId, input.targetUserId),
        eq(activityLog.action, CUSTOM_GROUP_REMOVED_ACTION),
        eq(activityLog.entityType, "messenger_custom_group"),
        inArray(activityLog.entityId, deterministicGroupIds),
        inScope(activityLog.orgId),
      )))
      .map((row) => row.groupId))
    : new Set<string>();
  const recoverableLegacyGroups = legacyGroups.filter((group) => (
    !removedTargetGroupIds.has(deterministicUuid(group.id, input.targetUserId))
  ));
  const groupIdMap = new Map(
    recoverableLegacyGroups.map((group) => [
      group.id,
      deterministicUuid(group.id, input.targetUserId),
    ]),
  );
  if (recoverableLegacyGroups.length > 0) {
    await tx.insert(messengerCustomGroups).values(recoverableLegacyGroups.map((group) => ({
      ...group,
      id: groupIdMap.get(group.id)!,
      userId: input.targetUserId,
    }))).onConflictDoNothing();
  }

  const legacySavedViews = await tx
    .select()
    .from(messengerSavedViews)
    .where(and(eq(messengerSavedViews.userId, LEGACY_BOARD_USER_ID), inScope(messengerSavedViews.orgId)));
  const targetSavedViews = await tx
    .select()
    .from(messengerSavedViews)
    .where(and(eq(messengerSavedViews.userId, input.targetUserId), inScope(messengerSavedViews.orgId)));
  const targetByResource = new Map(targetSavedViews.map((view) => [`${view.orgId}:${view.resourceKey}`, view]));
  const targetByInstance = new Map(targetSavedViews.map((view) => [`${view.orgId}:${view.instanceId}`, view]));
  const targetByMutation = new Map(
    targetSavedViews
      .filter((view) => view.clientMutationId)
      .map((view) => [`${view.orgId}:${view.clientMutationId}`, view]),
  );
  const savedViewIdMap = new Map<string, string>();
  for (const view of legacySavedViews) {
    const target =
      (view.clientMutationId ? targetByMutation.get(`${view.orgId}:${view.clientMutationId}`) : undefined)
      ?? targetByInstance.get(`${view.orgId}:${view.instanceId}`)
      ?? targetByResource.get(`${view.orgId}:${view.resourceKey}`);
    const targetId = target?.id ?? deterministicUuid(view.id, input.targetUserId);
    savedViewIdMap.set(view.id, targetId);
    if (target) continue;
    await tx.insert(messengerSavedViews).values({
      ...view,
      id: targetId,
      userId: input.targetUserId,
    }).onConflictDoNothing();
  }

  const legacyEntries = await tx
    .select()
    .from(messengerCustomGroupEntries)
    .where(and(
      eq(messengerCustomGroupEntries.userId, LEGACY_BOARD_USER_ID),
      inScope(messengerCustomGroupEntries.orgId),
    ));
  const recoverableLegacyEntries = legacyEntries.flatMap((entry) => {
    const groupId = groupIdMap.get(entry.groupId);
    if (!groupId) return [];
    const savedViewMatch = /^saved-view:(.+)$/.exec(entry.threadKey);
    const mappedSavedViewId = savedViewMatch ? savedViewIdMap.get(savedViewMatch[1]!) : undefined;
    return [{
      ...entry,
      id: deterministicUuid(entry.id, input.targetUserId),
      userId: input.targetUserId,
      groupId,
      threadKey: mappedSavedViewId ? `saved-view:${mappedSavedViewId}` : entry.threadKey,
    }];
  });
  if (recoverableLegacyEntries.length > 0) {
    await tx.insert(messengerCustomGroupEntries).values(recoverableLegacyEntries).onConflictDoNothing();
  }

  const targetEntries = await tx
    .select()
    .from(messengerCustomGroupEntries)
    .where(and(
      eq(messengerCustomGroupEntries.userId, input.targetUserId),
      inScope(messengerCustomGroupEntries.orgId),
    ));
  const targetEntryByThreadKey = new Map(
    targetEntries.map((entry) => [`${entry.orgId}:${entry.threadKey}`, entry]),
  );
  const legacyMutations = await tx
    .select()
    .from(messengerSavedViewMutations)
    .where(and(
      eq(messengerSavedViewMutations.userId, LEGACY_BOARD_USER_ID),
      inScope(messengerSavedViewMutations.orgId),
    ));
  const mappedMutations = legacyMutations.flatMap((mutation) => {
    const savedViewId = savedViewIdMap.get(mutation.savedViewId);
    if (!savedViewId) return [];
    const placement = targetEntryByThreadKey.get(`${mutation.orgId}:saved-view:${savedViewId}`);
    return [{
      ...mutation,
      id: deterministicUuid(mutation.id, input.targetUserId),
      userId: input.targetUserId,
      savedViewId,
      groupId: placement?.groupId ?? null,
    }];
  });
  if (mappedMutations.length > 0) {
    await tx.insert(messengerSavedViewMutations).values(mappedMutations).onConflictDoNothing();
  }

  const legacyThreadStates = await tx
    .select()
    .from(messengerThreadUserStates)
    .where(and(
      eq(messengerThreadUserStates.userId, LEGACY_BOARD_USER_ID),
      inScope(messengerThreadUserStates.orgId),
    ));
  for (const batch of chunks(legacyThreadStates)) {
    await tx.insert(messengerThreadUserStates).values(batch.map((state) => ({
      ...state,
      id: deterministicUuid(state.id, input.targetUserId),
      userId: input.targetUserId,
    }))).onConflictDoUpdate({
      target: [
        messengerThreadUserStates.orgId,
        messengerThreadUserStates.threadKey,
        messengerThreadUserStates.userId,
      ],
      set: {
        lastReadAt: sql`greatest(${messengerThreadUserStates.lastReadAt}, excluded.last_read_at)`,
        pinnedAt: sql`case
          when excluded.updated_at > ${messengerThreadUserStates.updatedAt}
            then excluded.pinned_at
          else ${messengerThreadUserStates.pinnedAt}
        end`,
        updatedAt: sql`greatest(${messengerThreadUserStates.updatedAt}, excluded.updated_at)`,
      },
    });
  }

  const legacyChatStates = await tx
    .select()
    .from(chatConversationUserStates)
    .where(and(
      eq(chatConversationUserStates.userId, LEGACY_BOARD_USER_ID),
      inScope(chatConversationUserStates.orgId),
    ));
  for (const batch of chunks(legacyChatStates)) {
    await tx.insert(chatConversationUserStates).values(batch.map((state) => ({
      ...state,
      id: deterministicUuid(state.id, input.targetUserId),
      userId: input.targetUserId,
    }))).onConflictDoUpdate({
      target: [
        chatConversationUserStates.orgId,
        chatConversationUserStates.conversationId,
        chatConversationUserStates.userId,
      ],
      set: {
        lastReadAt: sql`greatest(${chatConversationUserStates.lastReadAt}, excluded.last_read_at)`,
        pinnedAt: sql`case
          when excluded.updated_at > ${chatConversationUserStates.updatedAt}
            then excluded.pinned_at
          else ${chatConversationUserStates.pinnedAt}
        end`,
        updatedAt: sql`greatest(${chatConversationUserStates.updatedAt}, excluded.updated_at)`,
      },
    });
  }

  const legacyIssueReadStates = await tx
    .select()
    .from(issueReadStates)
    .where(and(eq(issueReadStates.userId, LEGACY_BOARD_USER_ID), inScope(issueReadStates.orgId)));
  for (const batch of chunks(legacyIssueReadStates)) {
    await tx.insert(issueReadStates).values(batch.map((state) => ({
      ...state,
      id: deterministicUuid(state.id, input.targetUserId),
      userId: input.targetUserId,
    }))).onConflictDoUpdate({
      target: [issueReadStates.orgId, issueReadStates.issueId, issueReadStates.userId],
      set: {
        lastReadAt: sql`greatest(${issueReadStates.lastReadAt}, excluded.last_read_at)`,
        updatedAt: sql`greatest(${issueReadStates.updatedAt}, excluded.updated_at)`,
      },
    });
  }

  const legacyIssueFollows = await tx
    .select()
    .from(issueFollows)
    .where(and(eq(issueFollows.userId, LEGACY_BOARD_USER_ID), inScope(issueFollows.orgId)));
  if (legacyIssueFollows.length > 0) {
    await tx.insert(issueFollows).values(legacyIssueFollows.map((follow) => ({
      ...follow,
      id: deterministicUuid(follow.id, input.targetUserId),
      userId: input.targetUserId,
    }))).onConflictDoNothing();
  }

  const legacyProfile = await tx
    .select()
    .from(operatorProfiles)
    .where(eq(operatorProfiles.userId, LEGACY_BOARD_USER_ID))
    .then((rows) => rows[0] ?? null);
  if (legacyProfile) {
    const targetProfile = await tx
      .select()
      .from(operatorProfiles)
      .where(eq(operatorProfiles.userId, input.targetUserId))
      .then((rows) => rows[0] ?? null);
    if (targetProfile) {
      await tx.update(operatorProfiles).set({
        nickname: targetProfile.nickname ?? legacyProfile.nickname,
        moreAboutYou: targetProfile.moreAboutYou ?? legacyProfile.moreAboutYou,
        preferences: { ...legacyProfile.preferences, ...targetProfile.preferences },
        updatedAt: targetProfile.updatedAt > legacyProfile.updatedAt
          ? targetProfile.updatedAt
          : legacyProfile.updatedAt,
      }).where(eq(operatorProfiles.userId, input.targetUserId));
    } else {
      await tx.insert(operatorProfiles).values({
        ...legacyProfile,
        userId: input.targetUserId,
      });
    }
  }

  const existingReceiptOrgIds = new Set(
    (await tx
      .select({ orgId: activityLog.orgId })
      .from(activityLog)
      .where(and(
        eq(activityLog.actorType, "user"),
        eq(activityLog.actorId, input.targetUserId),
        eq(activityLog.action, LEGACY_STATE_COPIED_ACTION),
        eq(activityLog.entityType, "installation"),
        eq(activityLog.entityId, input.installationId),
      )))
      .map((row) => row.orgId),
  );
  const receiptOrgIds = orgIds.filter((orgId) => !existingReceiptOrgIds.has(orgId));
  if (receiptOrgIds.length > 0) await tx.insert(activityLog).values(receiptOrgIds.map((orgId) => ({
    orgId,
    actorType: "user" as const,
    actorId: input.targetUserId,
    action: LEGACY_STATE_COPIED_ACTION,
    entityType: "installation",
    entityId: input.installationId,
    details: {
      priorPrincipalId: LEGACY_BOARD_USER_ID,
      compatibilityMode: "copy_preserving_legacy",
    },
  })));

  return { status: receiptOrgIds.length > 0 ? "copied" as const : "reconciled" as const, orgIds };
}
