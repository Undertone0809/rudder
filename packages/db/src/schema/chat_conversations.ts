import { type AnyPgColumn, boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { chatMessages } from "./chat_messages.js";
import { issues } from "./issues.js";
import { organizations } from "./organizations.js";

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    conversationKind: text("conversation_kind").notNull().default("chat"),
    messengerVisible: boolean("messenger_visible").notNull().default(true),
    sideChatState: text("side_chat_state"),
    sideChatExpiresAt: timestamp("side_chat_expires_at", { withTimezone: true }),
    sideChatCompletedAt: timestamp("side_chat_completed_at", { withTimezone: true }),
    sideChatKeptAt: timestamp("side_chat_kept_at", { withTimezone: true }),
    sideChatClientMutationId: text("side_chat_client_mutation_id"),
    initialClientMutationId: text("initial_client_mutation_id"),
    title: text("title").notNull().default("New chat"),
    summary: text("summary"),
    preferredAgentId: uuid("preferred_agent_id").references(() => agents.id, { onDelete: "set null" }),
    modelOverride: text("model_override"),
    effortOverride: text("effort_override"),
    routedAgentId: uuid("routed_agent_id").references(() => agents.id, { onDelete: "set null" }),
    primaryIssueId: uuid("primary_issue_id").references(() => issues.id, { onDelete: "set null" }),
    forkedFromConversationId: uuid("forked_from_conversation_id").references((): AnyPgColumn => chatConversations.id, { onDelete: "set null" }),
    forkedFromMessageId: uuid("forked_from_message_id").references((): AnyPgColumn => chatMessages.id, { onDelete: "set null" }),
    forkRootConversationId: uuid("fork_root_conversation_id").references((): AnyPgColumn => chatConversations.id, { onDelete: "set null" }),
    issueCreationMode: text("issue_creation_mode").notNull().default("manual_approval"),
    planMode: boolean("plan_mode").notNull().default(false),
    createdByUserId: text("created_by_user_id"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgUpdatedIdx: index("chat_conversations_org_updated_idx").on(table.orgId, table.updatedAt),
    orgStatusUpdatedIdx: index("chat_conversations_org_status_updated_idx").on(
      table.orgId,
      table.status,
      table.updatedAt,
    ),
    orgMessengerVisibilityIdx: index("chat_conversations_org_messenger_visibility_idx").on(
      table.orgId,
      table.messengerVisible,
      table.status,
      table.updatedAt,
    ),
    sideChatOwnerMutationUnique: uniqueIndex("chat_conversations_side_chat_owner_mutation_idx").on(
      table.orgId,
      table.createdByUserId,
      table.sideChatClientMutationId,
    ),
    initialOwnerMutationUnique: uniqueIndex("chat_conversations_initial_owner_mutation_idx").on(
      table.orgId,
      table.createdByUserId,
      table.initialClientMutationId,
    ),
    primaryIssueIdx: index("chat_conversations_primary_issue_idx").on(table.primaryIssueId),
    forkedFromConversationIdx: index("chat_conversations_forked_from_conversation_idx").on(table.forkedFromConversationId),
    forkRootIdx: index("chat_conversations_fork_root_idx").on(table.forkRootConversationId),
  }),
);
