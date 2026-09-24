import type { Db } from "@rudderhq/db";
import { chatConversations, heartbeatRuns } from "@rudderhq/db";
import { parseShortRef, shortRefFor } from "@rudderhq/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { conflict, forbidden, notFound } from "../errors.js";
import { isShortRunIdReference, resolveHeartbeatRunIdReference } from "./heartbeat-run-reference.js";

export interface RunIntelligenceAccessScope {
  orgIds?: string[];
  sideChatOwnerId?: string | null;
  notFoundMessage?: string;
}

type RunAccessMetadata = {
  scene?: unknown;
  contextSnapshot?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isSideChatRun(run: RunAccessMetadata): boolean {
  const contextSnapshot = asRecord(run.contextSnapshot);
  const unifiedAgentRun = asRecord(contextSnapshot.unifiedAgentRun);
  return run.scene === "side_chat"
    || contextSnapshot.scene === "side_chat"
    || contextSnapshot.rudderScene === "side_chat"
    || unifiedAgentRun.scene === "side_chat";
}

export function sideChatVisibilityCondition(ownerUserId: string | null) {
  const ownerCondition = ownerUserId === null
    ? sql`false`
    : eq(chatConversations.createdByUserId, ownerUserId);
  const sideChatMarker = sql`coalesce((
    ${heartbeatRuns.scene} = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} ->> 'scene' = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} ->> 'rudderScene' = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} -> 'unifiedAgentRun' ->> 'scene' = 'side_chat'
  ), false)`;
  return sql`(
    (
      ${sideChatMarker}
      and exists (
        select 1
        from ${chatConversations}
        where ${chatConversations.id} = ${heartbeatRuns.chatConversationId}
          and ${chatConversations.orgId} = ${heartbeatRuns.orgId}
          and ${chatConversations.conversationKind} = 'side_chat'
          and ${ownerCondition}
      )
    )
    or (
      not ${sideChatMarker}
      and (
        ${heartbeatRuns.chatConversationId} is null
        or exists (
          select 1
          from ${chatConversations}
          where ${chatConversations.id} = ${heartbeatRuns.chatConversationId}
            and ${chatConversations.orgId} = ${heartbeatRuns.orgId}
            and (
              ${chatConversations.conversationKind} <> 'side_chat'
              or ${ownerCondition}
            )
        )
      )
    )
  )`;
}

function assertRunOrgScope(orgId: string, scope: RunIntelligenceAccessScope) {
  if (scope.orgIds && !scope.orgIds.includes(orgId)) {
    throw forbidden("User does not have access to this organization");
  }
}

export async function assertRunIntelligenceAccess(
  db: Db,
  run: { orgId: string; chatConversationId?: string | null } & RunAccessMetadata,
  scope: RunIntelligenceAccessScope = {},
) {
  assertRunOrgScope(run.orgId, scope);
  if (scope.sideChatOwnerId === undefined) return;
  const sideChatOrigin = isSideChatRun(run);
  if (!run.chatConversationId) {
    if (sideChatOrigin) throw notFound(scope.notFoundMessage ?? "Agent run not found");
    return;
  }

  const conversation = await db
    .select({
      orgId: chatConversations.orgId,
      conversationKind: chatConversations.conversationKind,
      createdByUserId: chatConversations.createdByUserId,
    })
    .from(chatConversations)
    .where(eq(chatConversations.id, run.chatConversationId))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (
    !conversation
    || conversation.orgId !== run.orgId
    || (sideChatOrigin
      ? conversation.conversationKind !== "side_chat"
        || scope.sideChatOwnerId === null
        || conversation.createdByUserId !== scope.sideChatOwnerId
      : conversation.conversationKind === "side_chat"
        && (
          scope.sideChatOwnerId === null
          || conversation.createdByUserId !== scope.sideChatOwnerId
        ))
  ) {
    throw notFound(scope.notFoundMessage ?? "Agent run not found");
  }
}

export async function resolveRunIdReferenceForScope(
  db: Db,
  runIdRef: string,
  scope: RunIntelligenceAccessScope = {},
): Promise<string> {
  const ownerUserId = scope.sideChatOwnerId;
  if (ownerUserId === undefined) {
    return resolveHeartbeatRunIdReference(db, runIdRef, scope);
  }

  const typedRef = parseShortRef(runIdRef);
  const normalized = typedRef?.kind === "run" ? typedRef.prefix : runIdRef.trim().toLowerCase();
  if (!isShortRunIdReference(normalized)) {
    return resolveHeartbeatRunIdReference(db, runIdRef, scope);
  }

  const notFoundMessage = scope.notFoundMessage ?? "Agent run not found";
  if (scope.orgIds?.length === 0) throw notFound(notFoundMessage);

  const rows = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      sql`replace(${heartbeatRuns.id}::text, '-', '') like ${`${normalized}%`}`,
      sideChatVisibilityCondition(ownerUserId),
      ...(scope.orgIds ? [inArray(heartbeatRuns.orgId, scope.orgIds)] : []),
    ))
    .orderBy(desc(heartbeatRuns.createdAt))
    .limit(2);

  if (rows.length === 0) throw notFound(notFoundMessage);
  if (rows.length === 1) return rows[0]!.id;

  throw conflict("Run ID prefix is ambiguous", {
    runId: normalized,
    matches: rows.map((row) => shortRefFor("run", row.id)),
  });
}

export async function filterRunsByRunIntelligenceAccess<
  Run extends { orgId: string; chatConversationId?: string | null } & RunAccessMetadata,
>(db: Db, runs: readonly Run[], scope: RunIntelligenceAccessScope = {}): Promise<Run[]> {
  if (scope.sideChatOwnerId === undefined || runs.length === 0) return [...runs];

  const conversationIds = [...new Set(
    runs
      .map((run) => run.chatConversationId)
      .filter((value): value is string => Boolean(value)),
  )];
  const conversations = conversationIds.length === 0
    ? []
    : await db
      .select({
        id: chatConversations.id,
        orgId: chatConversations.orgId,
        conversationKind: chatConversations.conversationKind,
        createdByUserId: chatConversations.createdByUserId,
      })
      .from(chatConversations)
      .where(inArray(chatConversations.id, conversationIds));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));

  return runs.filter((run) => {
    const sideChatOrigin = isSideChatRun(run);
    if (!run.chatConversationId) return !sideChatOrigin;
    const conversation = conversationById.get(run.chatConversationId);
    if (!conversation || conversation.orgId !== run.orgId) return false;
    if (sideChatOrigin) {
      return conversation.conversationKind === "side_chat"
        && scope.sideChatOwnerId !== null
        && conversation.createdByUserId === scope.sideChatOwnerId;
    }
    return conversation.conversationKind !== "side_chat"
      || (
        scope.sideChatOwnerId !== null
        && conversation.createdByUserId === scope.sideChatOwnerId
      );
  });
}
