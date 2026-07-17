import { approvals, chatConversations } from "@rudderhq/db";
import { sql } from "drizzle-orm";

export function approvalVisibleOutsideArchivedChats() {
  return sql<boolean>`not exists (
    select 1
    from ${chatConversations}
    where ${chatConversations.orgId} = ${approvals.orgId}
      and ${chatConversations.status} = 'archived'
      and (
        ${chatConversations.id}::text = ${approvals.payload}->>'chatConversationId'
        or ${chatConversations.id}::text = ${approvals.payload}->>'conversationId'
      )
  )`;
}
