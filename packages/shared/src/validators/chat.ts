import { z } from "zod";
import {
  CHAT_CONTEXT_ENTITY_TYPES,
  CHAT_CONVERSATION_STATUSES,
  CHAT_ISSUE_CREATION_MODES,
  CHAT_MESSAGE_KINDS,
  CHAT_MESSAGE_ROLES,
  CHAT_MESSAGE_STATUSES,
  ISSUE_STATUSES,
} from "../constants.js";

export const chatConversationStatusSchema = z.enum(CHAT_CONVERSATION_STATUSES);
export const chatIssueCreationModeSchema = z.enum(CHAT_ISSUE_CREATION_MODES);
export const chatMessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);
export const chatMessageKindSchema = z.enum(CHAT_MESSAGE_KINDS);
export const chatMessageStatusSchema = z.enum(CHAT_MESSAGE_STATUSES);
export const chatContextEntityTypeSchema = z.enum(CHAT_CONTEXT_ENTITY_TYPES);

export const createChatContextLinkSchema = z.object({
  entityType: chatContextEntityTypeSchema,
  entityId: z.string().min(1),
  metadata: z.record(z.unknown()).optional().nullable(),
});

export const createChatConversationSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(5000).optional().nullable(),
  preferredAgentId: z.string().uuid().optional().nullable(),
  issueCreationMode: chatIssueCreationModeSchema.optional(),
  planMode: z.boolean().optional(),
  contextLinks: z.array(createChatContextLinkSchema).optional().default([]),
});

export const setChatProjectContextSchema = z.object({
  projectId: z.string().uuid().optional().nullable(),
});

export const updateChatConversationSchema = createChatConversationSchema
  .partial()
  .extend({
    status: chatConversationStatusSchema.optional(),
    routedAgentId: z.string().uuid().optional().nullable(),
    primaryIssueId: z.string().uuid().optional().nullable(),
    resolvedAt: z.string().datetime().optional().nullable(),
  });

export const addChatMessageSchema = z.object({
  body: z.string().trim().min(1).max(20000),
  editUserMessageId: z.string().uuid().optional().nullable(),
});

export const createChatAttachmentMetadataSchema = z.object({
  messageId: z.string().uuid(),
});

const chatIssueProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20000),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  status: z.enum(ISSUE_STATUSES).optional(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().trim().optional().nullable(),
});

export const convertChatToIssueSchema = z.object({
  messageId: z.string().uuid().optional().nullable(),
  proposal: chatIssueProposalSchema.optional(),
});

export const chatOperationProposalSchema = z.object({
  targetType: z.enum(["organization", "agent"]),
  targetId: z.string().min(1),
  summary: z.string().trim().min(1).max(500),
  patch: z.record(z.unknown()),
});

export const resolveChatOperationProposalSchema = z.object({
  action: z.enum(["approve", "reject", "requestRevision"]),
  decisionNote: z.string().trim().max(5000).optional().nullable(),
});

export const updateChatConversationUserStateSchema = z.object({
  pinned: z.boolean().optional(),
});

export type ChatConversationStatus = z.infer<typeof chatConversationStatusSchema>;
export type ChatIssueCreationMode = z.infer<typeof chatIssueCreationModeSchema>;
export type ChatMessageRole = z.infer<typeof chatMessageRoleSchema>;
export type ChatMessageKind = z.infer<typeof chatMessageKindSchema>;
export type ChatMessageStatus = z.infer<typeof chatMessageStatusSchema>;
export type ChatContextEntityType = z.infer<typeof chatContextEntityTypeSchema>;
export type CreateChatContextLink = z.infer<typeof createChatContextLinkSchema>;
export type CreateChatConversation = z.infer<typeof createChatConversationSchema>;
export type SetChatProjectContext = z.infer<typeof setChatProjectContextSchema>;
export type UpdateChatConversation = z.infer<typeof updateChatConversationSchema>;
export type AddChatMessage = z.infer<typeof addChatMessageSchema>;
export type CreateChatAttachmentMetadata = z.infer<typeof createChatAttachmentMetadataSchema>;
export type ConvertChatToIssue = z.infer<typeof convertChatToIssueSchema>;
export type ChatOperationProposal = z.infer<typeof chatOperationProposalSchema>;
export type ResolveChatOperationProposal = z.infer<typeof resolveChatOperationProposalSchema>;
export type UpdateChatConversationUserState = z.infer<typeof updateChatConversationUserStateSchema>;
