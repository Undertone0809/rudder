import { z } from "zod";
import {
  AUTOMATION_CATCH_UP_POLICIES,
  AUTOMATION_CONCURRENCY_POLICIES,
  AUTOMATION_OUTPUT_MODES,
  AUTOMATION_STATUSES,
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

const chatRichReferenceDisplaySchema = z.enum(["card", "inline"]);
const chatIssueIdentifierSchema = z.string().trim().min(1).max(64).regex(/^[A-Z0-9][A-Z0-9-]*$/i);
const chatAskUserIdentifierSchema = z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

export const chatAskUserOptionSchema = z.object({
  id: chatAskUserIdentifierSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(220).optional(),
  recommended: z.boolean().optional(),
});

export const chatAskUserQuestionSchema = z.object({
  id: chatAskUserIdentifierSchema,
  header: z.string().trim().min(1).max(32).optional(),
  question: z.string().trim().min(1).max(240),
  options: z.array(chatAskUserOptionSchema).min(2).max(3),
  selectionMode: z.enum(["single", "multiple"]).optional(),
  allowFreeform: z.boolean().optional(),
}).superRefine((question, ctx) => {
  const optionIds = new Set<string>();
  question.options.forEach((option, index) => {
    if (optionIds.has(option.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Option ids must be unique within each question",
        path: ["options", index, "id"],
      });
      return;
    }
    optionIds.add(option.id);
  });
});

export const chatAskUserRequestSchema = z.object({
  questions: z.array(chatAskUserQuestionSchema).min(1).max(3),
}).superRefine((request, ctx) => {
  const questionIds = new Set<string>();
  request.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Question ids must be unique within requestUserInput",
        path: ["questions", index, "id"],
      });
      return;
    }
    questionIds.add(question.id);
  });
});

const chatIssueRichReferenceSchema = z.object({
  type: z.literal("issue"),
  issueId: z.string().uuid().optional(),
  identifier: chatIssueIdentifierSchema.optional(),
  display: chatRichReferenceDisplaySchema.optional(),
}).refine((value) => Boolean(value.issueId || value.identifier), {
  message: "issueId or identifier is required",
});

const chatIssueCommentRichReferenceSchema = z.object({
  type: z.literal("issue_comment"),
  issueId: z.string().uuid().optional(),
  identifier: chatIssueIdentifierSchema.optional(),
  commentId: z.string().uuid(),
  display: chatRichReferenceDisplaySchema.optional(),
}).refine((value) => Boolean(value.issueId || value.identifier), {
  message: "issueId or identifier is required",
});

export const chatRichReferenceSchema = z.union([
  chatIssueRichReferenceSchema,
  chatIssueCommentRichReferenceSchema,
]);

export const chatRichReferencesSchema = z.array(chatRichReferenceSchema).max(5);

export function chatRichReferencesFromStructuredPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawReferences = (payload as Record<string, unknown>).richReferences;
  if (!Array.isArray(rawReferences)) return [];

  return rawReferences
    .map((reference) => chatRichReferenceSchema.safeParse(reference))
    .filter((result): result is z.SafeParseSuccess<z.infer<typeof chatRichReferenceSchema>> => result.success)
    .map((result) => result.data)
    .slice(0, 5);
}

export function chatAskUserRequestFromStructuredPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rawRequest = (payload as Record<string, unknown>).requestUserInput;
  const parsed = chatAskUserRequestSchema.safeParse(rawRequest);
  return parsed.success ? parsed.data : null;
}

export const chatAutomationCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(20_000).optional().nullable(),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentIssueId: z.string().uuid().optional().nullable(),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  status: z.enum(AUTOMATION_STATUSES).optional().default("active"),
  concurrencyPolicy: z.enum(AUTOMATION_CONCURRENCY_POLICIES).optional().default("coalesce_if_active"),
  catchUpPolicy: z.enum(AUTOMATION_CATCH_UP_POLICIES).optional().default("skip_missed"),
  outputMode: z.enum(AUTOMATION_OUTPUT_MODES).optional().default("track_issue"),
  schedule: z.object({
    cronExpression: z.string().trim().min(1),
    timezone: z.string().trim().min(1),
    label: z.string().trim().max(120).optional().nullable(),
    enabled: z.boolean().optional().default(true),
  }),
});

export function chatAutomationCreateFromStructuredPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const rawRequest = (payload as Record<string, unknown>).automationCreate;
  const parsed = chatAutomationCreateSchema.safeParse(rawRequest);
  return parsed.success ? parsed.data : null;
}

export function sanitizeChatStructuredPayload(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const next = { ...payload };
  const requestUserInput = chatAskUserRequestFromStructuredPayload(payload);
  if (requestUserInput) {
    next.requestUserInput = requestUserInput;
  } else {
    delete next.requestUserInput;
  }
  const richReferences = chatRichReferencesFromStructuredPayload(payload);
  if (richReferences.length > 0) {
    next.richReferences = richReferences;
  } else {
    delete next.richReferences;
  }
  const automationCreate = chatAutomationCreateFromStructuredPayload(payload);
  if (automationCreate) {
    next.automationCreate = automationCreate;
  } else {
    delete next.automationCreate;
  }
  return Object.keys(next).length > 0 ? next : null;
}

export const createChatAttachmentMetadataSchema = z.object({
  messageId: z.string().uuid(),
});

export const chatIssueProposalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(20000),
  status: z.enum(ISSUE_STATUSES).optional().default("todo"),
  priority: z.enum(["critical", "high", "medium", "low"]).optional().default("medium"),
  projectId: z.string().uuid().optional().nullable(),
  goalId: z.string().uuid().optional().nullable(),
  parentId: z.string().uuid().optional().nullable(),
  assigneeAgentId: z.string().uuid().optional().nullable(),
  assigneeUserId: z.string().trim().optional().nullable(),
  assigneeUnassignedReason: z.string().trim().min(1).max(500).optional().nullable(),
  reviewerAgentId: z.string().uuid().optional().nullable(),
  reviewerUserId: z.string().trim().optional().nullable(),
  labelIds: z.array(z.string().uuid()).optional(),
}).superRefine((proposal, ctx) => {
  const hasAssignee = Boolean(proposal.assigneeAgentId || proposal.assigneeUserId);
  const hasUnassignedReason = Boolean(proposal.assigneeUnassignedReason?.trim());
  if (hasAssignee && hasUnassignedReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Issue proposals with an assignee must not also declare an unassigned reason",
      path: ["assigneeUnassignedReason"],
    });
  }
  if (!hasAssignee && !hasUnassignedReason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Issue proposals without an owner must include assigneeUnassignedReason",
      path: ["assigneeUnassignedReason"],
    });
  }
});

export const convertChatToIssueSchema = z.object({
  messageId: z.string().uuid().optional().nullable(),
  proposal: chatIssueProposalSchema.optional(),
});

export function chatIssueProposalFromStructuredPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const rawProposal =
    root.issueProposal && typeof root.issueProposal === "object" && !Array.isArray(root.issueProposal)
      ? root.issueProposal
      : root;
  const parsed = chatIssueProposalSchema.safeParse(rawProposal);
  return parsed.success ? parsed.data : null;
}

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
  unread: z.boolean().optional(),
});

export const updateMessengerThreadUserStateSchema = z.object({
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
export type UpdateMessengerThreadUserState = z.infer<typeof updateMessengerThreadUserStateSchema>;
export type ChatAskUserOption = z.infer<typeof chatAskUserOptionSchema>;
export type ChatAskUserQuestion = z.infer<typeof chatAskUserQuestionSchema>;
export type ChatAskUserRequest = z.infer<typeof chatAskUserRequestSchema>;
export type ChatRichReference = z.infer<typeof chatRichReferenceSchema>;
export type ChatAutomationCreate = z.infer<typeof chatAutomationCreateSchema>;
export type CreateChatAttachmentMetadata = z.infer<typeof createChatAttachmentMetadataSchema>;
export type ConvertChatToIssue = z.infer<typeof convertChatToIssueSchema>;
export type ChatOperationProposal = z.infer<typeof chatOperationProposalSchema>;
export type ResolveChatOperationProposal = z.infer<typeof resolveChatOperationProposalSchema>;
export type UpdateChatConversationUserState = z.infer<typeof updateChatConversationUserStateSchema>;
