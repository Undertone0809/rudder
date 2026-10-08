import { chatConversations, heartbeatRuns } from "@rudderhq/db";
import { eq, sql } from "drizzle-orm";

// Reference admission must not reveal private Run IDs through prefix ambiguity.
// Native Run and live-run authorities independently apply the same owner fence
// before selecting any public payload. This adapter only resolves identity.
export function sideChatVisibilityCondition(ownerUserId: string | null) {
  const ownerCondition = ownerUserId === null
    ? sql`false`
    : eq(chatConversations.createdByUserId, ownerUserId);
  const sideChatMarker = sql`coalesce((
    ${heartbeatRuns.scene} = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} ->> 'scene' = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} ->> 'rudderScene' = 'side_chat'
    or ${heartbeatRuns.contextSnapshot} -> 'unifiedAgentRun' ->> 'scene' = 'side_chat'
    or (${heartbeatRuns.chatConversationId} is null and (
      ${heartbeatRuns.scene} = 'chat'
      or ${heartbeatRuns.contextSnapshot} ->> 'scene' = 'chat'
      or ${heartbeatRuns.contextSnapshot} ->> 'rudderScene' = 'chat'
      or ${heartbeatRuns.contextSnapshot} -> 'unifiedAgentRun' ->> 'scene' = 'chat'
    ))
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

