import type { Db } from "@rudderhq/db";
import {
  chatConversations,
  messengerCustomGroupEntries,
  messengerCustomGroups,
} from "@rudderhq/db";
import { MESSENGER_FORK_GROUP_DEFAULT_ICON } from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  lockMessengerCustomGroupPlacement,
  lockMessengerOwnerPlacement,
} from "./messenger-saved-views.js";

type ChatFamilyGroupClient = Pick<Db, "delete" | "execute" | "insert" | "select">;

async function findChatFamilyGroup(
  client: Pick<Db, "select">,
  orgId: string,
  userId: string,
  rootConversationId: string,
) {
  const rootThreadKey = `chat:${rootConversationId}`;
  return client
    .select({ id: messengerCustomGroups.id })
    .from(messengerCustomGroups)
    .innerJoin(messengerCustomGroupEntries, eq(messengerCustomGroupEntries.groupId, messengerCustomGroups.id))
    .where(and(
      eq(messengerCustomGroups.orgId, orgId),
      eq(messengerCustomGroups.userId, userId),
      eq(messengerCustomGroupEntries.orgId, orgId),
      eq(messengerCustomGroupEntries.userId, userId),
      eq(messengerCustomGroupEntries.threadKey, rootThreadKey),
    ))
    .orderBy(asc(messengerCustomGroups.sortOrder), asc(messengerCustomGroups.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

async function createChatFamilyGroup(
  client: Pick<Db, "insert" | "select">,
  orgId: string,
  userId: string,
  name: string,
) {
  const [lastGroup] = await client
    .select({ sortOrder: messengerCustomGroups.sortOrder })
    .from(messengerCustomGroups)
    .where(and(eq(messengerCustomGroups.orgId, orgId), eq(messengerCustomGroups.userId, userId)))
    .orderBy(desc(messengerCustomGroups.sortOrder))
    .limit(1);
  const now = new Date();
  const [group] = await client
    .insert(messengerCustomGroups)
    .values({
      orgId,
      userId,
      name: name.trim() || "Forked conversation",
      icon: MESSENGER_FORK_GROUP_DEFAULT_ICON,
      sortOrder: (lastGroup?.sortOrder ?? -1) + 1,
      updatedAt: now,
    })
    .returning();
  if (!group) throw new Error("Failed to create Messenger conversation family group");
  return group;
}

async function assignChatToFamilyGroup(
  client: Pick<Db, "insert" | "select">,
  orgId: string,
  userId: string,
  groupId: string,
  conversationId: string,
) {
  const [lastEntry] = await client
    .select({ sortOrder: messengerCustomGroupEntries.sortOrder })
    .from(messengerCustomGroupEntries)
    .where(and(
      eq(messengerCustomGroupEntries.orgId, orgId),
      eq(messengerCustomGroupEntries.userId, userId),
      eq(messengerCustomGroupEntries.groupId, groupId),
    ))
    .orderBy(desc(messengerCustomGroupEntries.sortOrder))
    .limit(1);
  const nextSortOrder = (lastEntry?.sortOrder ?? -1) + 1;
  const now = new Date();
  await client
    .insert(messengerCustomGroupEntries)
    .values({
      orgId,
      userId,
      groupId,
      threadKey: `chat:${conversationId}`,
      sortOrder: nextSortOrder,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        messengerCustomGroupEntries.orgId,
        messengerCustomGroupEntries.userId,
        messengerCustomGroupEntries.threadKey,
      ],
      set: {
        groupId,
        sortOrder: sql<number>`CASE
          WHEN ${messengerCustomGroupEntries.groupId} = ${groupId}
            THEN ${messengerCustomGroupEntries.sortOrder}
          ELSE ${nextSortOrder}
        END`,
        updatedAt: now,
      },
  });
}

export async function assignChatToExistingMessengerGroup(
  client: ChatFamilyGroupClient,
  input: {
    orgId: string;
    userId: string;
    groupId: string;
    conversationId: string;
  },
) {
  await lockMessengerOwnerPlacement(client, input.orgId, input.userId);
  await lockMessengerCustomGroupPlacement(client, input.orgId, input.userId, input.groupId);

  const [group] = await client
    .select({ id: messengerCustomGroups.id })
    .from(messengerCustomGroups)
    .where(and(
      eq(messengerCustomGroups.orgId, input.orgId),
      eq(messengerCustomGroups.userId, input.userId),
      eq(messengerCustomGroups.id, input.groupId),
    ))
    .limit(1);
  if (!group) return false;

  await assignChatToFamilyGroup(
    client,
    input.orgId,
    input.userId,
    group.id,
    input.conversationId,
  );
  return true;
}

export async function ensureChatFamilyGroup(
  client: ChatFamilyGroupClient,
  input: {
    orgId: string;
    userId: string;
    rootConversationId: string;
    sourceConversationId: string;
    childConversationId: string;
    groupName: string;
  },
) {
  await lockMessengerOwnerPlacement(client, input.orgId, input.userId);

  // Family membership is user-scoped, but the root row is the stable lock shared
  // by concurrent Fork and Side Chat promotions in the same conversation family.
  await client.execute(sql`
    SELECT ${chatConversations.id}
    FROM ${chatConversations}
    WHERE ${chatConversations.id} = ${input.rootConversationId}
      AND ${chatConversations.orgId} = ${input.orgId}
    FOR UPDATE
  `);

  const familyThreadKeys = [...new Set([
    input.rootConversationId,
    input.sourceConversationId,
    input.childConversationId,
  ])].map((conversationId) => `chat:${conversationId}`);
  const existingMemberships = await client
    .select({ groupId: messengerCustomGroupEntries.groupId, threadKey: messengerCustomGroupEntries.threadKey })
    .from(messengerCustomGroupEntries)
    .where(and(
      eq(messengerCustomGroupEntries.orgId, input.orgId),
      eq(messengerCustomGroupEntries.userId, input.userId),
      inArray(messengerCustomGroupEntries.threadKey, familyThreadKeys),
    ));
  const existing = await findChatFamilyGroup(
    client,
    input.orgId,
    input.userId,
    input.rootConversationId,
  );
  const group = existing ?? await createChatFamilyGroup(
    client,
    input.orgId,
    input.userId,
    input.groupName,
  );
  const existingGroupIds = [...new Set(existingMemberships.map((membership) => membership.groupId))];
  const affectedGroupIds = [...new Set([...existingGroupIds, group.id])].sort();
  for (const groupId of affectedGroupIds) {
    await lockMessengerCustomGroupPlacement(client, input.orgId, input.userId, groupId);
  }
  const familyConversationIds = new Set([
    input.rootConversationId,
    input.sourceConversationId,
    input.childConversationId,
  ]);
  for (const conversationId of familyConversationIds) {
    await assignChatToFamilyGroup(client, input.orgId, input.userId, group.id, conversationId);
  }
  return group;
}
