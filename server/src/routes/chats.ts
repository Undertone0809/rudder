import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  addChatMessageSchema,
  cancelChatQueuedMessageSchema,
  chatAutomationCreateFromStructuredPayload,
  createChatConversationSchema,
  createChatQueuedMessageSchema,
  createSideChatSchema,
  forkChatConversationSchema,
  parseCodexInlineVisualDirectives,
  steerChatQueuedMessageSchema,
  updateChatConversationSchema,
  updateChatQueuedMessageSchema,
  type ChatAttachment,
  type ChatContextLink,
  type ChatControlDisposition,
  type ChatConversation,
  type ChatMessage,
  type ChatQueueRequestActor,
} from "@rudderhq/shared";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { conflict, forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { validate } from "../middleware/validate.js";
import { assertTimeZone } from "../services/automations.scheduler.js";
import { chatAgentRunService } from "../services/chat-agent-runs.js";
import {
  CHAT_ASSISTANT_USER_ERROR_MESSAGE,
  chatAssistantService,
  ChatAssistantStreamError,
  userVisiblePartialBodyFromError,
  type ChatAssistantResult,
  type ChatGeneratedAttachment,
} from "../services/chat-assistant.js";
import {
  cancelAndReleaseActiveChatGeneration,
  claimChatGeneration,
  createChatRuntimeControlCoordinator,
  getActiveChatGeneration,
  hasActiveChatGeneration,
  interruptActiveChatGeneration,
  steerActiveChatGeneration
} from "../services/chat-generation-locks.js";
import { hashChatGenerationBody } from "../services/chat-generation-protocol.js";
import {
  buildChatTitlePromptFromMessages,
  chatTitleGenerationService,
} from "../services/chat-title-generation.js";
import { chatWorkManifestService } from "../services/chat-work-manifest.js";
import { validateCron } from "../services/cron.js";
import {
  accessService,
  agentService,
  automationService,
  chatService,
  goalService,
  heartbeatService,
  issueService,
  logActivity,
  operatorProfileService,
  organizationService,
  productIntelligenceService,
  projectService,
  sideChatService,
} from "../services/index.js";
import {
  runtimeResultText,
  sanitizeGeneratedTitle,
} from "../services/title-generation.js";
import type { StorageService } from "../storage/types.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import {
  createChatBackgroundRuntime,
  type ChatBackgroundRuntime,
  type ChatBackgroundTimer,
} from "./chat-background-runtime.js";
import { wakeIssueAssigneeAfterChatConversion } from "./chat-issue-assignment-wakeup.js";
import { registerChatStreamRoutes } from "./chats.stream-routes.js";

function chatVisibleOutputAdmissionClosed(error: unknown) {
  return error instanceof HttpError
    && error.status === 409
    && error.message === "Chat-visible output admission is closed for this generation";
}

export function chatRoutes(
  db: Db,
  storage: StorageService,
  backgroundRuntime: ChatBackgroundRuntime = createChatBackgroundRuntime(),
) {
  const router = Router();
  const svc = chatService(db);
  const organizationsSvc = organizationService(db);
  const issuesSvc = issueService(db);
  const projectsSvc = projectService(db);
  const agentsSvc = agentService(db);
  const automationsSvc = automationService(db);
  const goalsSvc = goalService(db);
  const access = accessService(db);
  const assistantSvc = chatAssistantService(db, storage);
  const chatRunsSvc = chatAgentRunService(db);
  const workManifestSvc = chatWorkManifestService(db);
  const operatorProfiles = operatorProfileService(db);
  const heartbeat = heartbeatService(db);
  const productIntelligence = productIntelligenceService(db);
  const chatTitles = chatTitleGenerationService({ chats: svc, productIntelligence });
  const sideChats = sideChatService(db);

  const CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE =
    "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
  });
  const messageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10 },
  });

  async function runSingleFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function runMessageFileUpload(req: Request, res: Response) {
    await new Promise<void>((resolve, reject) => {
      messageUpload.array("files", 10)(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function isMultipartRequest(req: Request) {
    return (req.headers["content-type"] ?? "").toLowerCase().startsWith("multipart/form-data");
  }

  function uploadedMessageFiles(req: Request) {
    const files = (req as Request & { files?: unknown }).files;
    const list: unknown[] = Array.isArray(files) ? files : [];
    return list.filter((file): file is { mimetype: string; buffer: Buffer; originalname: string } =>
        typeof file === "object" &&
        file !== null &&
        Buffer.isBuffer((file as { buffer?: unknown }).buffer),
    );
  }

  function validateUploadedMessageFiles(files: Array<{ mimetype: string; buffer: Buffer }>) {
    for (const file of files) {
      const contentType = (file.mimetype || "").toLowerCase();
      if (!isAllowedContentType(contentType)) {
        return `Unsupported attachment type: ${contentType || "unknown"}`;
      }
      if (file.buffer.length <= 0) {
        return "Attachment is empty";
      }
    }
    return null;
  }

  async function assertConversationAccess(req: Request, conversationId: string) {
    const conversation = await svc.getById(conversationId);
    if (!conversation) return null;
    assertCompanyAccess(req, conversation.orgId);
    await sideChats.assertAccessible(
      conversation as ChatConversation,
      req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null,
    );
    return conversation;
  }

  function boardUserId(req: Request) {
    assertBoard(req);
    return req.actor.userId ?? "local-board";
  }

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
  }

  function stringQuery(value: unknown) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  function assertChatLocalMutationAllowed(conversation: ChatConversation) {
    if (conversation.mutability === "external_bound_chat") {
      throw conflict("Fork this Feishu chat to continue in Rudder");
    }
  }

  async function assertSideChatMutationAllowed(req: Request, conversation: ChatConversation) {
    await sideChats.assertMutable(
      conversation,
      req.actor.type === "board" ? boardUserId(req) : null,
    );
  }

  async function touchSideChat(req: Request, conversation: ChatConversation) {
    await sideChats.touch(
      conversation,
      req.actor.type === "board" ? boardUserId(req) : null,
    );
  }

  function isTitleOnlyChatUpdate(body: Record<string, unknown>) {
    const keys = Object.keys(body);
    return keys.length === 1 && keys[0] === "title";
  }

  const startChatTitleGeneration = chatTitles.startAutomaticGeneration;

  async function generateChatTitle(orgId: string, prompt: string) {
    const result = await productIntelligence.execute({
      orgId,
      purpose: "lightweight",
      feature: "chat_title",
      prompt,
    });
    return sanitizeGeneratedTitle(runtimeResultText(result));
  }

  function positiveIntegerQuery(value: unknown, fallback: number, max: number) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.floor(parsed));
  }

  function paginateChatMessages<T extends { id: string }>(messages: T[], query: Request["query"]) {
    const order = query.order === "newest" ? "newest" : "oldest";
    const limit = positiveIntegerQuery(query.limit, 50, 500);
    const cursor = stringQuery(query.cursor);
    const ordered = order === "newest" ? [...messages].reverse() : messages;
    const startIndex = cursor
      ? Math.max(0, ordered.findIndex((message) => message.id === cursor) + 1)
      : 0;
    const pageMessages = ordered.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + pageMessages.length < ordered.length;

    return {
      messages: pageMessages,
      page: {
        cursor,
        nextCursor: hasMore && pageMessages.length > 0 ? pageMessages[pageMessages.length - 1].id : null,
        hasMore,
        limit,
        order,
        returnedMessages: pageMessages.length,
        totalMessages: messages.length,
      },
    };
  }

  async function assertCanAssignTasks(req: Request, orgId: string) {
    assertCompanyAccess(req, orgId);
    if (req.actor.type === "board") {
      if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
      const allowed = await access.canUser(orgId, req.actor.userId, "tasks:assign");
      if (!allowed) throw forbidden("Missing permission: tasks:assign");
      return;
    }
    if (req.actor.type === "agent") {
      if (!req.actor.agentId) throw forbidden("Agent authentication required");
      const allowedByGrant = await access.hasPermission(orgId, "agent", req.actor.agentId, "tasks:assign");
      if (allowedByGrant) return;
      const actorAgent = await agentsSvc.getById(req.actor.agentId);
      if (actorAgent && actorAgent.orgId === orgId && canCreateAgentsLegacy(actorAgent)) return;
      throw forbidden("Missing permission: tasks:assign");
    }
    throw unauthorized();
  }

  async function logChatMessagesAdded(
    conversation: ChatConversation,
    messages: ChatMessage[],
    actor: {
      actorType: "agent" | "user" | "system";
      actorId: string;
      agentId?: string | null;
      runId?: string | null;
    },
  ) {
    await Promise.all(
      messages.map((message) =>
        logActivity(db, {
          orgId: conversation.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId ?? null,
          runId: actor.runId ?? null,
          action: "chat.message_added",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            messageId: message.id,
            role: message.role,
            kind: message.kind,
            status: message.status,
            preview: message.body.slice(0, 280),
          },
        }),
      ),
    );
  }

  async function assertContextLinksBelongToCompany(
    orgId: string,
    contextLinks: Array<{ entityType: "issue" | "project" | "agent"; entityId: string }>,
  ) {
    for (const link of contextLinks) {
      if (link.entityType === "issue") {
        const issue = await issuesSvc.getById(link.entityId);
        if (!issue || issue.orgId !== orgId) {
          throw new HttpError(422, "Issue context must belong to the same organization");
        }
        continue;
      }
      if (link.entityType === "project") {
        const project = await projectsSvc.getById(link.entityId);
        if (!project || project.orgId !== orgId) {
          throw new HttpError(422, "Project context must belong to the same organization");
        }
        continue;
      }
      const agent = await agentsSvc.getById(link.entityId);
      if (!agent || agent.orgId !== orgId) {
        throw new HttpError(422, "Agent context must belong to the same organization");
      }
    }
  }

  type ActorInfo = ReturnType<typeof getActorInfo>;

  function queueRequestActor(req: Request): ChatQueueRequestActor {
    if (req.actor.type === "agent") {
      return {
        type: "agent",
        source: req.actor.source === "agent_jwt" ? "agent_jwt" : "agent_key",
        orgId: req.actor.orgId,
        agentId: req.actor.agentId,
        runId: req.actor.runId,
        adapterType: req.actor.adapterType,
      };
    }
    if (req.actor.type !== "board") throw unauthorized();
    return {
      type: "board",
      source: req.actor.source === "local_implicit"
        ? "local_implicit"
        : req.actor.source === "board_key"
          ? "board_key"
          : "session",
      userId: req.actor.userId,
      orgIds: req.actor.orgIds,
      isInstanceAdmin: req.actor.isInstanceAdmin,
      runId: req.actor.runId,
    };
  }

  function requestForQueuedActor(
    requestActor: ChatQueueRequestActor | null | undefined,
    orgId: string,
  ): Request {
    if (!requestActor) {
      throw new Error("Queued chat continuation is missing its authenticated request actor");
    }
    if (requestActor.type === "agent") {
      if (!requestActor.agentId || requestActor.orgId !== orgId) {
        throw new Error("Queued chat continuation has an invalid agent actor scope");
      }
      return {
        actor: {
          type: "agent",
          source: requestActor.source === "agent_jwt" ? "agent_jwt" : "agent_key",
          orgId,
          agentId: requestActor.agentId,
          runId: requestActor.runId,
          adapterType: requestActor.adapterType,
        },
      } as unknown as Request;
    }
    const source = requestActor.source === "local_implicit"
      ? "local_implicit"
      : requestActor.source === "board_key"
        ? "board_key"
        : "session";
    const orgIds = requestActor.orgIds ?? [];
    if (source !== "local_implicit" && !requestActor.isInstanceAdmin && !orgIds.includes(orgId)) {
      throw new Error("Queued chat continuation has an invalid board actor scope");
    }
    return {
      actor: {
        type: "board",
        source,
        userId: requestActor.userId,
        orgIds,
        isInstanceAdmin: requestActor.isInstanceAdmin,
        runId: requestActor.runId,
      },
    } as unknown as Request;
  }

  type ChatTurnContext = { chatTurnId: string; turnVariant: number };

  function turnContextFromUserMessage(userMessage: ChatMessage): ChatTurnContext {
    if (!userMessage.chatTurnId) {
      throw new Error("User message missing chat turn id");
    }
    return { chatTurnId: userMessage.chatTurnId, turnVariant: userMessage.turnVariant };
  }

  async function addUserMessage(
    conversation: ChatConversation,
    body: string,
    actor: ActorInfo,
    editUserMessageId?: string | null,
  ) {
    assertChatLocalMutationAllowed(conversation);
    const userMessage = await svc.addUserChatMessage(
      conversation.id,
      conversation.orgId,
      body,
      editUserMessageId ?? null,
    );

    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.message_added",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        messageId: userMessage.id,
        role: "user",
        kind: "message",
        editUserMessageId: editUserMessageId ?? null,
      },
    });

    return userMessage as ChatMessage;
  }

  async function addAgentAuthoredMessage(
    conversation: ChatConversation,
    body: string,
    actor: ActorInfo,
  ) {
    assertChatLocalMutationAllowed(conversation);
    if (!actor.agentId) {
      throw forbidden("Agent authentication required");
    }

    const message = await svc.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: "message",
      body,
      replyingAgentId: actor.agentId,
    }) as ChatMessage;

    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: "agent",
      actorId: actor.agentId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.message_added",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        messageId: message.id,
        role: "assistant",
        kind: "message",
        replyingAgentId: actor.agentId,
        source: "agent_direct_message",
      },
    });

    return message;
  }

  async function attachFilesToUserMessage(
    conversation: ChatConversation,
    messageId: string,
    files: Array<{ mimetype: string; buffer: Buffer; originalname: string }>,
    actor: ActorInfo,
  ): Promise<ChatAttachment[]> {
    assertChatLocalMutationAllowed(conversation);
    const attachments: ChatAttachment[] = [];
    for (const file of files) {
      const contentType = (file.mimetype || "").toLowerCase();
      if (!isAllowedContentType(contentType)) {
        throw new HttpError(422, `Unsupported attachment type: ${contentType || "unknown"}`);
      }
      if (file.buffer.length <= 0) {
        throw new HttpError(422, "Attachment is empty");
      }

      const stored = await storage.putFile({
        orgId: conversation.orgId,
        namespace: `chats/${conversation.id}`,
        originalFilename: file.originalname || null,
        contentType,
        body: file.buffer,
      });

      const attachment = await svc.createAttachment({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        messageId,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: actor.agentId,
        createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      });
      attachments.push(attachment as ChatAttachment);

      await logActivity(db, {
        orgId: conversation.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "chat.attachment_added",
        entityType: "chat",
        entityId: conversation.id,
        details: {
          attachmentId: attachment.id,
          messageId: attachment.messageId,
          originalFilename: attachment.originalFilename,
          contentType: attachment.contentType,
        },
      });
    }
    return attachments;
  }

  async function loadAssistantInput(conversation: ChatConversation, actor: ActorInfo) {
    const freshConversation = await svc.getById(conversation.id);
    const hydratedConversation = await assistantSvc.enrichConversation((freshConversation ?? conversation) as ChatConversation);
    const rawMessages = await svc.listMessages(conversation.id);
    const freshMessages = rawMessages.filter((m) => !m.supersededAt);
    const operatorProfile =
      actor.actorType === "user"
        ? await operatorProfiles.get(actor.actorId)
        : null;
    const issueLabels = await issuesSvc.listLabels(conversation.orgId);

    return {
      conversation: hydratedConversation,
      messages: freshMessages as ChatMessage[],
      contextLinks: (hydratedConversation.contextLinks ?? conversation.contextLinks) as ChatContextLink[],
      issueLabels,
      operatorProfile,
    };
  }

  function chatReplyingAgentId(conversation: ChatConversation | null | undefined) {
    return conversation?.chatRuntime?.runtimeAgentId ?? conversation?.preferredAgentId ?? null;
  }

  function proposedIssuePayload(structuredPayload: Record<string, unknown> | null | undefined) {
    if (!structuredPayload) return structuredPayload ?? null;
    return structuredPayload.issueProposal
      && typeof structuredPayload.issueProposal === "object"
      && !Array.isArray(structuredPayload.issueProposal)
      && structuredPayload.issueProposal !== null
        ? structuredPayload.issueProposal as Record<string, unknown>
        : structuredPayload;
  }

  function proposalAssignsOrReviewsIssue(proposal: Record<string, unknown> | null | undefined) {
    if (!proposal) return false;
    return Boolean(
      (typeof proposal.assigneeAgentId === "string" && proposal.assigneeAgentId.trim().length > 0)
      || (typeof proposal.assigneeUserId === "string" && proposal.assigneeUserId.trim().length > 0)
      || (typeof proposal.reviewerAgentId === "string" && proposal.reviewerAgentId.trim().length > 0)
      || (typeof proposal.reviewerUserId === "string" && proposal.reviewerUserId.trim().length > 0),
    );
  }

  async function proposedIssuePayloadForConversion(
    conversationId: string,
    input: {
      messageId?: string | null;
      proposal?: Record<string, unknown> | null;
    },
  ) {
    if (input.proposal) return proposedIssuePayload(input.proposal);
    if (input.messageId) {
      const message = await svc.getMessage(conversationId, input.messageId);
      return proposedIssuePayload(message?.structuredPayload ?? null);
    }
    const messages = await svc.listMessages(conversationId);
    const message = [...messages].reverse().find((entry) => entry.kind === "issue_proposal");
    return proposedIssuePayload(message?.structuredPayload ?? null);
  }

  async function assertCanConvertIssueProposal(
    req: Request,
    conversation: ChatConversation,
    input: {
      messageId?: string | null;
      proposal?: Record<string, unknown> | null;
    },
  ) {
    const proposal = await proposedIssuePayloadForConversion(conversation.id, input);
    if (proposalAssignsOrReviewsIssue(proposal)) {
      await assertCanAssignTasks(req, conversation.orgId);
    }
  }

  async function chatIssueProposalNeedsOperatorLabelSelection(
    orgId: string,
    proposedByAgentId: string | null | undefined,
    proposal: Record<string, unknown> | null | undefined,
  ) {
    if (!proposedByAgentId) return false;
    const labelIds = Array.isArray(proposal?.labelIds)
      ? proposal.labelIds.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      : [];
    if (labelIds.length > 0) return false;
    const labels = await issuesSvc.listLabels(orgId);
    return labels.length >= 5;
  }

  async function persistAssistantReply(
    req: Request,
    conversation: ChatConversation,
    actor: ActorInfo,
    assistantReply: ChatAssistantResult,
    turnContext: ChatTurnContext,
    transcript: TranscriptEntry[] = [],
    replyingAgentId = assistantReply.replyingAgentId ?? chatReplyingAgentId(conversation),
    existingMessageId?: string | null,
    runId?: string | null,
  ) {
    const createdMessages: ChatMessage[] = [];
    const { chatTurnId, turnVariant } = turnContext;
    const attachGeneratedFiles = async (message: ChatMessage, generatedAttachments: ChatGeneratedAttachment[] | undefined) => {
      const finalDirectives = parseCodexInlineVisualDirectives(assistantReply.body).directives;
      const inlineVisuals = (assistantReply.inlineVisuals ?? []).filter((visual) =>
        finalDirectives.some((directive) =>
          directive.index === visual.directiveIndex && directive.file === visual.file
        )
      );
      const generatedFiles = (generatedAttachments ?? []).filter((generated) =>
        generated.source !== "codex_inline_visual"
        || inlineVisuals.some((visual) =>
          visual.status === "captured"
          && visual.directiveIndex === generated.directiveIndex
          && visual.file === generated.directiveFile
        )
      );
      if (generatedFiles.length === 0 && inlineVisuals.length === 0) return message;
      const attachments: ChatAttachment[] = [];
      const attachmentByVisualIndex = new Map<number, ChatAttachment>();
      for (const generated of generatedFiles) {
        if (generated.body.length > MAX_ATTACHMENT_BYTES) {
          throw new ChatAssistantStreamError(
            `Generated attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
            assistantReply.body,
            generatedFiles,
            { partialBodyUserVisible: true },
          );
        }
        const stored = await storage.putFile({
          orgId: conversation.orgId,
          namespace: `chats/${conversation.id}/generated`,
          originalFilename: generated.originalFilename,
          contentType: generated.contentType,
          body: generated.body,
        });
        const attachment = await svc.createAttachment({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          messageId: message.id,
          provider: stored.provider,
          objectKey: stored.objectKey,
          contentType: stored.contentType,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
          originalFilename: stored.originalFilename,
          createdByAgentId: replyingAgentId,
          createdByUserId: null,
        });
        const typedAttachment = attachment as ChatAttachment;
        const publicAttachment = generated.source === "codex_inline_visual"
          ? (({ provider: _provider, objectKey: _objectKey, ...safe }) => safe)(typedAttachment)
          : typedAttachment;
        attachments.push(publicAttachment as ChatAttachment);
        if (generated.source === "codex_inline_visual") {
          attachmentByVisualIndex.set(generated.directiveIndex, publicAttachment as ChatAttachment);
        }
      }
      let structuredPayload = message.structuredPayload ?? null;
      if (inlineVisuals.length > 0) {
        const persistedMappings = inlineVisuals.map((visual) => {
          if (visual.status === "captured") {
            const attachment = attachmentByVisualIndex.get(visual.directiveIndex);
            if (attachment) {
              return {
                directiveIndex: visual.directiveIndex,
                file: visual.file,
                status: "ready" as const,
                attachmentId: attachment.id,
              };
            }
          }
          return {
            directiveIndex: visual.directiveIndex,
            file: visual.file,
            status: "unavailable" as const,
            reason: visual.status === "unavailable" ? visual.reason : "capture_failed",
          };
        });
        structuredPayload = {
          ...(structuredPayload ?? {}),
          inlineVisuals: persistedMappings,
        };
        await svc.updateMessage(conversation.id, message.id, { structuredPayload });
      }
      return {
        ...message,
        structuredPayload,
        attachments: [...(message.attachments ?? []), ...attachments],
      } as ChatMessage;
    };
    const saveAssistantMessage = async (input: {
      kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal";
      body: string;
      structuredPayload?: Record<string, unknown> | null;
      approvalId?: string | null;
    }) => {
      if (existingMessageId) {
        const updated = await svc.updateMessage(conversation.id, existingMessageId, {
          kind: input.kind,
          status: "completed",
          body: input.body,
          structuredPayload: input.structuredPayload ?? null,
          transcript,
          approvalId: input.approvalId ?? null,
          runId: runId ?? undefined,
          replyingAgentId,
        });
        if (updated) return updated as ChatMessage;
      }
      return svc.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "assistant",
        kind: input.kind,
        body: input.body,
        structuredPayload: input.structuredPayload ?? null,
        transcript,
        approvalId: input.approvalId ?? null,
        runId: runId ?? null,
        replyingAgentId,
        chatTurnId,
        turnVariant,
      }) as Promise<ChatMessage>;
    };

    if (assistantReply.kind === "automation_create") {
      if (conversation.planMode) {
        throw new Error("Plan mode cannot create automations");
      }
      const automationCreate = chatAutomationCreateFromStructuredPayload(assistantReply.structuredPayload);
      if (!automationCreate) {
        throw new Error("automation_create assistant response is missing a valid automationCreate payload");
      }
      if (!replyingAgentId) {
        throw new Error("automation_create requires a selected chat agent");
      }
      assertTimeZone(automationCreate.schedule.timezone);
      const scheduleError = validateCron(automationCreate.schedule.cronExpression);
      if (scheduleError) throw unprocessable(scheduleError);
      const scheduleTrigger = {
        kind: "schedule" as const,
        enabled: automationCreate.schedule.enabled,
        cronExpression: automationCreate.schedule.cronExpression,
        timezone: automationCreate.schedule.timezone,
      };
      const assigneeAgentId = replyingAgentId;
      const automation = await automationsSvc.create(conversation.orgId, {
        projectId: automationCreate.projectId ?? null,
        goalId: automationCreate.goalId ?? null,
        parentIssueId: automationCreate.parentIssueId ?? null,
        title: automationCreate.title,
        description: automationCreate.instructions ?? null,
        assigneeAgentId,
        priority: automationCreate.priority,
        status: automationCreate.status,
        concurrencyPolicy: automationCreate.concurrencyPolicy,
        catchUpPolicy: automationCreate.catchUpPolicy,
        outputMode: automationCreate.outputMode,
        chatConversationId: null,
        notifyOnIssueCreated: false,
      }, {
        agentId: replyingAgentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });
      const triggerResult = await automationsSvc.createTrigger(automation.id, scheduleTrigger, {
        agentId: replyingAgentId,
        userId: actor.actorType === "user" ? actor.actorId : null,
      });

      const assistantMessage = await saveAssistantMessage({
        kind: "message",
        body: assistantReply.body,
        structuredPayload: {
          ...(assistantReply.structuredPayload ?? {}),
          automationCreated: {
            automationId: automation.id,
            triggerId: triggerResult.trigger.id,
          },
        },
      });
      createdMessages.push(await attachGeneratedFiles(assistantMessage as ChatMessage, assistantReply.generatedAttachments));

      const systemMessage = await svc.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "system",
        kind: "system_event",
        body: `Created automation "${automation.title}" from this chat conversation.`,
        structuredPayload: {
          eventType: "automation_created",
          automationId: automation.id,
          automationTitle: automation.title,
          triggerId: triggerResult.trigger.id,
          triggerKind: triggerResult.trigger.kind,
          cronExpression: triggerResult.trigger.cronExpression,
          timezone: triggerResult.trigger.timezone,
        },
        chatTurnId,
        turnVariant,
      });
      createdMessages.push(systemMessage as ChatMessage);

      await Promise.all([
        logActivity(db, {
          orgId: conversation.orgId,
          actorType: "agent",
          actorId: replyingAgentId,
          agentId: replyingAgentId,
          runId: actor.runId,
          action: "automation.created",
          entityType: "automation",
          entityId: automation.id,
          details: {
            title: automation.title,
            assigneeAgentId: automation.assigneeAgentId,
            source: "chat_automation_create",
            chatConversationId: conversation.id,
          },
        }),
        logActivity(db, {
          orgId: conversation.orgId,
          actorType: "agent",
          actorId: replyingAgentId,
          agentId: replyingAgentId,
          runId: actor.runId,
          action: "automation.trigger_created",
          entityType: "automation_trigger",
          entityId: triggerResult.trigger.id,
          details: {
            automationId: automation.id,
            kind: triggerResult.trigger.kind,
            source: "chat_automation_create",
            chatConversationId: conversation.id,
          },
        }),
        logActivity(db, {
          orgId: conversation.orgId,
          actorType: "system",
          actorId: "chat-assistant",
          action: "chat.automation_created",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            automationId: automation.id,
            triggerId: triggerResult.trigger.id,
            source: "automation_create",
          },
        }),
      ]);

      return createdMessages;
    }

    if (assistantReply.kind === "issue_proposal") {
      const issueProposalStructuredPayload = assistantReply.structuredPayload ?? null;
      const proposalPayload = proposedIssuePayload(issueProposalStructuredPayload);
      const needsOperatorLabelSelection = await chatIssueProposalNeedsOperatorLabelSelection(
        conversation.orgId,
        replyingAgentId,
        proposalPayload,
      );
      const shouldAutoCreateIssue =
        !needsOperatorLabelSelection
        && !conversation.planMode
        && conversation.issueCreationMode === "auto_create";
      if (shouldAutoCreateIssue) {
        const proposalMessage = await saveAssistantMessage({
          kind: "issue_proposal",
          body: assistantReply.body,
          structuredPayload: issueProposalStructuredPayload,
        });
        createdMessages.push(await attachGeneratedFiles(proposalMessage as ChatMessage, assistantReply.generatedAttachments));

        await assertCanConvertIssueProposal(req, conversation, {
          proposal: issueProposalStructuredPayload,
        });
        const issue = await svc.convertToIssue(conversation.id, {
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          createdByAgentId: replyingAgentId,
          messageId: proposalMessage.id,
        });
        await wakeIssueAssigneeAfterChatConversion({
          db,
          heartbeat,
          issue,
          reason: "issue_assigned",
          mutation: "chat_auto_create",
          contextSource: "chat.auto_create",
          requestedByActorType: "system",
          requestedByActorId: "chat-assistant",
        });
        const systemMessage = await svc.addMessage(conversation.id, {
          orgId: conversation.orgId,
          role: "system",
          kind: "system_event",
          body: `Created issue ${issue.identifier ?? issue.id} from this chat conversation.`,
          structuredPayload: {
            eventType: "issue_created",
            issueId: issue.id,
            issueIdentifier: issue.identifier,
          },
          chatTurnId,
          turnVariant,
        });
        createdMessages.push(systemMessage as ChatMessage);
        await logActivity(db, {
          orgId: conversation.orgId,
          actorType: "system",
          actorId: "chat-assistant",
          action: "chat.issue_converted",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            source: "auto_create",
          },
        });
        return createdMessages;
      }

      const approval = await svc.createProposalApproval(conversation.orgId, {
        type: "chat_issue_creation",
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        payload: {
          chatConversationId: conversation.id,
          proposedByAgentId: replyingAgentId,
          proposedIssue: proposalPayload,
        },
      });

      const proposalMessage = await saveAssistantMessage({
        kind: "issue_proposal",
        body: assistantReply.body,
        structuredPayload: issueProposalStructuredPayload,
        approvalId: approval.id,
      });
      createdMessages.push(await attachGeneratedFiles(proposalMessage as ChatMessage, assistantReply.generatedAttachments));
      return createdMessages;
    }

    if (assistantReply.kind === "operation_proposal") {
      const approval = await svc.createProposalApproval(conversation.orgId, {
        type: "chat_operation",
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        payload: {
          chatConversationId: conversation.id,
          operationProposal:
            assistantReply.structuredPayload &&
            typeof assistantReply.structuredPayload.operationProposal === "object" &&
            assistantReply.structuredPayload.operationProposal !== null
              ? assistantReply.structuredPayload.operationProposal
              : assistantReply.structuredPayload,
        },
      });
      const proposalMessage = await saveAssistantMessage({
        kind: "operation_proposal",
        body: assistantReply.body,
        structuredPayload: {
          ...(assistantReply.structuredPayload ?? {}),
          operationProposalState: {
            status: "pending",
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
          },
        },
        approvalId: approval.id,
      });
      createdMessages.push(await attachGeneratedFiles(proposalMessage as ChatMessage, assistantReply.generatedAttachments));
      return createdMessages;
    }

    if (assistantReply.kind === "ask_user") {
      const assistantMessage = await saveAssistantMessage({
        kind: "ask_user",
        body: assistantReply.body,
        structuredPayload: assistantReply.structuredPayload,
      });
      createdMessages.push(await attachGeneratedFiles(assistantMessage as ChatMessage, assistantReply.generatedAttachments));
      return createdMessages;
    }

    const assistantMessage = await saveAssistantMessage({
      kind: "message",
      body: assistantReply.body,
      structuredPayload: assistantReply.structuredPayload,
    });
    createdMessages.push(await attachGeneratedFiles(assistantMessage as ChatMessage, assistantReply.generatedAttachments));
    return createdMessages;
  }

  async function attachGeneratedFilesToPartialMessage(
    conversation: ChatConversation,
    message: ChatMessage | null,
    generatedAttachments: ChatGeneratedAttachment[] | undefined,
    replyingAgentId: string | null,
  ) {
    if (!message || !generatedAttachments || generatedAttachments.length === 0) return message;
    const attachments: ChatAttachment[] = [];
    for (const generated of generatedAttachments) {
      if (generated.body.length > MAX_ATTACHMENT_BYTES) continue;
      const stored = await storage.putFile({
        orgId: conversation.orgId,
        namespace: `chats/${conversation.id}/generated`,
        originalFilename: generated.originalFilename,
        contentType: generated.contentType,
        body: generated.body,
      });
      const attachment = await svc.createAttachment({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        messageId: message.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: replyingAgentId,
        createdByUserId: null,
      });
      attachments.push(attachment as ChatAttachment);
    }
    return {
      ...message,
      attachments: [...(message.attachments ?? []), ...attachments],
    } as ChatMessage;
  }

  async function persistPartialAssistantMessage(
    conversation: ChatConversation,
    body: string,
    status: "stopped" | "failed",
    turnContext: ChatTurnContext | null,
    transcript: TranscriptEntry[] = [],
    replyingAgentId = chatReplyingAgentId(conversation),
    existingMessageId?: string | null,
    runId?: string | null,
    structuredPayload?: Record<string, unknown> | null,
  ) {
    const trimmed = body.trim();
    const fallbackBody = status === "stopped"
      ? "Chat run stopped before a final reply. Continue the conversation to resume from the preserved context."
      : CHAT_ASSISTANT_USER_ERROR_MESSAGE;
    const durableBody = trimmed || (transcript.length > 0 ? fallbackBody : "");
    if (!durableBody) return null;
    const chatTurnId = turnContext?.chatTurnId ?? randomUUID();
    const turnVariant = turnContext?.turnVariant ?? 0;
    if (existingMessageId) {
      const updated = await svc.updateMessage(conversation.id, existingMessageId, {
        kind: "message",
        status,
        body: durableBody,
        structuredPayload: structuredPayload ?? null,
        transcript,
        runId: runId ?? undefined,
        replyingAgentId,
      });
      if (updated) return updated as ChatMessage;
    }
    const message = await svc.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: "message",
      status,
      body: durableBody,
      structuredPayload: structuredPayload ?? null,
      transcript,
      runId: runId ?? null,
      replyingAgentId,
      chatTurnId,
      turnVariant,
    });
    return message as ChatMessage;
  }

  function recoverableFailurePayload(error: unknown, runId: string | null | undefined) {
    if (!(error instanceof ChatAssistantStreamError)) return null;
    const code = error.errorCode ?? "chat_runtime_exception";
    const message = error.userMessage ?? CHAT_ASSISTANT_RECOVERABLE_FAILURE_FALLBACK_MESSAGE;
    const retryable = error.retryable !== false;
    const failure: Record<string, unknown> = {
      recoverable: retryable,
      code,
      message,
      runId: runId ?? null,
    };
    if (!retryable) failure.retryable = false;
    if (error.failurePhase) failure.phase = error.failurePhase;
    if (error.action) failure.action = error.action;
    return {
      recoverableFailure: failure,
    };
  }

  function recoverableFailureBody(payload: Record<string, unknown> | null | undefined) {
    const failure = payload?.recoverableFailure;
    if (!failure || typeof failure !== "object" || Array.isArray(failure)) return null;
    const message = (failure as Record<string, unknown>).message;
    return typeof message === "string" && message.trim().length > 0 ? message.trim() : null;
  }

  function writeStreamEvent(
    res: Response,
    event: Record<string, unknown>,
  ) {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`${JSON.stringify(event)}\n`);
    return true;
  }

  async function linkChatRunMessages(
    conversation: ChatConversation,
    runId: string | null | undefined,
    messages: ChatMessage[],
  ) {
    if (!runId) return;
    const assistantMessages = messages.filter((message) => message.role === "assistant");
    for (const message of assistantMessages) {
      await chatRunsSvc.linkAssistantMessage(runId, conversation.id, message.id);
    }
  }

  const queueWorkerId = `chat-queue:${process.pid}:${randomUUID()}`;
  const queueLeaseMs = 30_000;
  const queueWorkerConcurrency = 4;
  const queueWorkerEnabled = process.env.NODE_ENV !== "test"
    || process.env.RUDDER_CHAT_QUEUE_WORKER_TEST === "true";
  const runningServerQueueTasks = new Set<Promise<void>>();
  const terminalProjectorId = `chat-terminal:${process.pid}:${randomUUID()}`;
  let terminalProjectionRetryTimer: ChatBackgroundTimer | null = null;
  let terminalProjectionRetryAt = Number.POSITIVE_INFINITY;

  function scheduleTerminalProjectorAt(wakeAt: Date) {
    if (!queueWorkerEnabled || !backgroundRuntime.acceptingWork) return;
    const wakeAtMs = Math.max(Date.now(), wakeAt.getTime());
    if (terminalProjectionRetryTimer && terminalProjectionRetryAt <= wakeAtMs) return;
    if (terminalProjectionRetryTimer) backgroundRuntime.clearTimer(terminalProjectionRetryTimer);
    terminalProjectionRetryAt = wakeAtMs;
    terminalProjectionRetryTimer = backgroundRuntime.setTimeout(() => {
      terminalProjectionRetryTimer = null;
      terminalProjectionRetryAt = Number.POSITIVE_INFINITY;
      wakeTerminalProjector();
    }, Math.max(0, wakeAtMs - Date.now()));
  }

  async function drainTerminalProjections() {
    while (backgroundRuntime.acceptingWork) {
      const claim = await svc.generationProtocol.claimTerminalProjection({
        workerId: terminalProjectorId,
        leaseMs: 30_000,
      });
      if (!claim) {
        const nextWakeAt = await svc.generationProtocol.getNextTerminalProjectionWakeAt();
        if (nextWakeAt) scheduleTerminalProjectorAt(nextWakeAt);
        return;
      }
      // A claim requested before close may resolve after admission shuts. The
      // terminal protocol has no release operation, so this tracked drain must
      // finish that claim while close waits instead of leaking its lease.
      try {
        const finalStatus = typeof claim.payload.finalStatus === "string"
          ? claim.payload.finalStatus
          : null;
        const controlActionKind = typeof claim.payload.controlActionKind === "string"
          ? claim.payload.controlActionKind
          : null;
        const controlDisposition: ChatControlDisposition | undefined = finalStatus === "stopped"
          && controlActionKind !== "steer"
          ? "stopped"
          : finalStatus === "interrupted_unverified"
            && controlActionKind !== "steer"
            ? "interrupted_unverified"
            : finalStatus === "control_lost"
              ? "control_lost"
              : undefined;
        const completed = await svc.generationProtocol.completeTerminalProjection({
          outboxId: claim.id,
          claimToken: claim.claimToken!,
          claimEpoch: claim.claimEpoch,
          controlDisposition,
        });
        if (completed) wakeServerQueue();
      } catch (error) {
        const retryAt = new Date(Date.now() + 1_000);
        const retry = await svc.generationProtocol.retryTerminalProjection({
          outboxId: claim.id,
          claimToken: claim.claimToken!,
          claimEpoch: claim.claimEpoch,
          error: error instanceof Error ? error.message : String(error),
          retryAt,
          maxAttempts: 5,
        }).catch(() => null);
        if (retry?.status === "retry_wait") {
          scheduleTerminalProjectorAt(retry.availableAt ?? retryAt);
        }
      }
    }
  }

  const terminalProjector = backgroundRuntime.createCoalescingTask(
    drainTerminalProjections,
    (error) => logger.warn({ err: error }, "chat terminal projection drain failed"),
  );

  function wakeTerminalProjector() {
    if (!queueWorkerEnabled || !backgroundRuntime.acceptingWork) return;
    if (terminalProjectionRetryTimer) {
      backgroundRuntime.clearTimer(terminalProjectionRetryTimer);
      terminalProjectionRetryTimer = null;
      terminalProjectionRetryAt = Number.POSITIVE_INFINITY;
    }
    terminalProjector.wake();
  }

  async function runServerQueuedMessage(
    claim: NonNullable<Awaited<ReturnType<typeof svc.claimNextServerQueuedMessage>>>,
  ) {
    const conversation = await svc.getById(claim.item.conversationId) as ChatConversation | null;
    if (!conversation) {
      await svc.releaseServerQueuedMessageClaim({
        itemId: claim.item.id,
        generationId: claim.generationId,
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        reason: "conversation_missing",
      });
      return;
    }

    let request: Request;
    try {
      request = requestForQueuedActor(claim.item.requestActor, conversation.orgId);
    } catch (error) {
      await svc.completeServerQueuedMessageDelivery({
        itemId: claim.item.id,
        generationId: claim.generationId,
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        status: "failed",
        reason: error instanceof Error ? error.message : "queued_request_actor_invalid",
      });
      return;
    }

    const actor = getActorInfo(request);
    const managedAbort = backgroundRuntime.manageAbortController();
    const abortController = managedAbort.controller;
    const releaseGeneration = claimChatGeneration(
      conversation.id,
      abortController,
      claim.generationId,
    );
    if (!releaseGeneration) {
      managedAbort.release();
      await svc.releaseServerQueuedMessageClaim({
        itemId: claim.item.id,
        generationId: claim.generationId,
        leaseToken: claim.leaseToken,
        leaseEpoch: claim.leaseEpoch,
        reason: "local_generation_owner_busy",
      });
      return;
    }

    let leaseRenewing = false;
    let leaseLost = false;
    const renewLease = async () => {
      if (leaseRenewing || leaseLost) return;
      leaseRenewing = true;
      try {
        const renewed = await svc.renewServerQueuedMessageClaim({
          itemId: claim.item.id,
          generationId: claim.generationId,
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
          leaseMs: queueLeaseMs,
        });
        if (!renewed) {
          leaseLost = true;
          abortController.abort(new Error("Queued chat continuation lost its delivery lease"));
        }
      } finally {
        leaseRenewing = false;
      }
    };
    const leaseTimer = backgroundRuntime.setInterval(() => {
      return renewLease().catch((error) => {
        leaseLost = true;
        abortController.abort(error);
      });
    }, Math.floor(queueLeaseMs / 3));

    let terminalStatus: "completed" | "failed" | "stopped" | "aborted" = "failed";
    let terminalReason: string | null = null;
    let completionRecorded = false;
    let assistantConversation = conversation;
    let activeChatRunId: string | null = null;
    const transcript: TranscriptEntry[] = [];
    let partialBody = "";
    try {
      const userMessage = await svc.getMessage(conversation.id, claim.userMessageId) as ChatMessage | null;
      if (!userMessage) throw new Error("Queued chat continuation user message is missing");
      const turnContext = turnContextFromUserMessage(userMessage);
      const assistantInput = await loadAssistantInput(conversation, actor);
      assistantConversation = assistantInput.conversation;
      const streamed = await assistantSvc.streamChatAssistantReply({
        ...assistantInput,
        userMessageId: userMessage.id,
        chatTurnId: turnContext.chatTurnId,
        turnVariant: turnContext.turnVariant,
        stream: false,
        abortSignal: abortController.signal,
        controlCoordinator: createChatRuntimeControlCoordinator(
          conversation.id,
          claim.generationId,
          {
            onAttemptStarted: async ({ generationId, attemptEpoch, ownerToken, attempt }) => {
              await svc.beginGenerationControlAttempt({
                orgId: conversation.orgId,
                conversationId: conversation.id,
                generationId,
                attemptEpoch,
                ownerToken,
                runtimeType: attempt.runtimeType,
              });
            },
            onHandleRegistered: async ({ generationId, attemptEpoch, ownerToken, handle }) => {
              await svc.markGenerationControlReady({
                generationId,
                attemptEpoch,
                ownerToken,
                runtimeType: handle.runtimeType,
                providerThreadId: handle.providerThreadId ?? null,
                providerTurnId: handle.providerTurnId ?? null,
              });
            },
            onAttemptLeaseRenewed: async ({ generationId, attemptEpoch, ownerToken }) => {
              await svc.renewGenerationControlLease({ generationId, attemptEpoch, ownerToken });
            },
            onAttemptCompleted: async ({ generationId, attemptEpoch, ownerToken }) => {
              await svc.markGenerationControlAttemptCompleted({
                generationId,
                attemptEpoch,
                ownerToken,
              });
            },
          },
        ),
        onRunCreated: (runId: string) => {
          activeChatRunId = runId;
        },
        onAssistantDelta: async (delta: string) => {
          if (!abortController.signal.aborted) partialBody = `${partialBody}${delta}`;
        },
        onTranscriptEntry: async (entry: TranscriptEntry) => {
          if (!abortController.signal.aborted) transcript.push(entry);
        },
      });
      partialBody = streamed.partialBody || partialBody;
      if (abortController.signal.aborted || streamed.outcome === "stopped") {
        terminalStatus = "stopped";
        terminalReason = "operator_stop";
        const stoppedMessage = await persistPartialAssistantMessage(
          assistantConversation,
          "",
          "stopped",
          turnContext,
          transcript,
          streamed.replyingAgentId,
          null,
          activeChatRunId,
        );
        const stoppedMessages = stoppedMessage ? [stoppedMessage] : [];
        await linkChatRunMessages(assistantConversation, activeChatRunId, stoppedMessages);
        if (stoppedMessages.length > 0) {
          await logChatMessagesAdded(assistantConversation, stoppedMessages, {
            actorType: "system",
            actorId: "chat-assistant",
            agentId: streamed.replyingAgentId,
          });
        }
      } else {
        let completionMessageId: string | null = null;
        try {
          const attemptEpoch = Math.max(
            1,
            getActiveChatGeneration(conversation.id)?.attemptEpoch ?? 1,
          );
          const completion = await svc.generationProtocol.appendVisibleEventAndProject({
            orgId: conversation.orgId,
            conversationId: conversation.id,
            generationId: claim.generationId,
            expectedAttemptEpoch: attemptEpoch,
            eventKind: "runtime_output",
            payload: {
              resultKind: streamed.reply.kind,
              body: streamed.reply.body,
            },
            bodyOffset: 0,
            bodyLength: streamed.reply.body.length,
            runId: activeChatRunId,
            bodyHash: hashChatGenerationBody(streamed.reply.body),
            body: streamed.reply.body,
            transcript,
            replyingAgentId: streamed.replyingAgentId,
            chatTurnId: turnContext.chatTurnId,
            turnVariant: turnContext.turnVariant,
          });
          completionMessageId = completion.message.id;
        } catch (error) {
          if (!chatVisibleOutputAdmissionClosed(error)) throw error;
          terminalStatus = "stopped";
          terminalReason = "operator_stop";
          const stoppedMessage = await persistPartialAssistantMessage(
            assistantConversation,
            "",
            "stopped",
            turnContext,
            transcript,
            streamed.replyingAgentId,
            null,
            activeChatRunId,
          );
          const stoppedMessages = stoppedMessage ? [stoppedMessage] : [];
          await linkChatRunMessages(assistantConversation, activeChatRunId, stoppedMessages);
          if (stoppedMessages.length > 0) {
            await logChatMessagesAdded(assistantConversation, stoppedMessages, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
          }
          return;
        }
        const createdMessages = await persistAssistantReply(
          request,
          assistantConversation,
          actor,
          streamed.reply,
          turnContext,
          transcript,
          streamed.replyingAgentId,
          completionMessageId,
          activeChatRunId,
        );
        await linkChatRunMessages(assistantConversation, activeChatRunId, createdMessages);
        await logChatMessagesAdded(assistantConversation, createdMessages, {
          actorType: "system",
          actorId: "chat-assistant",
          agentId: streamed.replyingAgentId,
        });
        terminalStatus = "completed";
      }
    } catch (error) {
      terminalStatus = abortController.signal.aborted ? "aborted" : "failed";
      terminalReason = leaseLost
        ? "delivery_lease_lost"
        : error instanceof Error
          ? error.message
          : "queued_continuation_failed";
      logger.warn(
        { err: error, conversationId: conversation.id, queuedMessageId: claim.item.id },
        "server-owned queued chat continuation failed",
      );
      if (!leaseLost) {
        const failurePayload = recoverableFailurePayload(error, activeChatRunId);
        const failureBody = userVisiblePartialBodyFromError(error)
          || recoverableFailureBody(failurePayload)
          || CHAT_ASSISTANT_USER_ERROR_MESSAGE;
        const failedMessage = await persistPartialAssistantMessage(
          assistantConversation,
          failureBody,
          "failed",
          null,
          transcript,
          chatReplyingAgentId(assistantConversation),
          null,
          activeChatRunId,
          failurePayload,
        ).catch(() => null);
        const failedMessages = failedMessage ? [failedMessage] : [];
        await linkChatRunMessages(assistantConversation, activeChatRunId, failedMessages).catch(() => undefined);
        if (failedMessages.length > 0) {
          await logChatMessagesAdded(assistantConversation, failedMessages, {
            actorType: "system",
            actorId: "chat-assistant",
            agentId: chatReplyingAgentId(assistantConversation),
          }).catch(() => undefined);
        }
      }
    } finally {
      backgroundRuntime.clearTimer(leaseTimer);
      if (!leaseLost) {
        const latestGeneration = await svc.getLatestGeneration(conversation.id).catch(() => null);
        const terminalEvidence = latestGeneration?.id === claim.generationId
          ? await svc.generationProtocol.recordRuntimeTerminal({
              orgId: conversation.orgId,
              conversationId: conversation.id,
              generationId: claim.generationId,
              expectedAttemptEpoch: latestGeneration.attemptEpoch,
              expectedOwnerToken: latestGeneration.controlOwnerToken,
              finalStatus: terminalStatus,
              terminalReason: terminalReason ?? terminalStatus,
            }).catch((error: unknown) => {
              logger.warn({ err: error, generationId: claim.generationId }, "failed to record queued chat terminal evidence");
              return null;
            })
          : null;
        if (terminalEvidence) {
          wakeTerminalProjector();
          const completed = await svc.completeServerQueuedMessageDelivery({
            itemId: claim.item.id,
            generationId: claim.generationId,
            leaseToken: claim.leaseToken,
            leaseEpoch: claim.leaseEpoch,
            status: terminalStatus,
            reason: terminalReason,
          }).catch((error: unknown) => {
            logger.warn({ err: error, queuedMessageId: claim.item.id }, "failed to complete queued chat continuation");
            return null;
          });
          completionRecorded = Boolean(completed);
        }
      }
      if (!completionRecorded && !leaseLost) {
        await svc.releaseServerQueuedMessageClaim({
          itemId: claim.item.id,
          generationId: claim.generationId,
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
          reason: "queued_continuation_completion_unconfirmed",
        }).catch(() => null);
      }
      releaseGeneration();
      managedAbort.release();
    }
  }

  async function drainServerQueue() {
    await svc.recoverExpiredServerQueueClaims();
    while (
      backgroundRuntime.acceptingWork
      && runningServerQueueTasks.size < queueWorkerConcurrency
    ) {
      const claim = await svc.claimNextServerQueuedMessage({
        workerId: queueWorkerId,
        leaseMs: queueLeaseMs,
      });
      if (!claim) return;
      if (!backgroundRuntime.acceptingWork) {
        await svc.releaseServerQueuedMessageClaim({
          itemId: claim.item.id,
          generationId: claim.generationId,
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
          reason: "chat_background_runtime_closing",
        });
        return;
      }
      let task!: Promise<void>;
      task = backgroundRuntime.track(runServerQueuedMessage(claim)
        .catch((error) => {
          logger.warn({ err: error, queuedMessageId: claim.item.id }, "server-owned chat continuation crashed");
        })
        .finally(() => {
          runningServerQueueTasks.delete(task);
          wakeServerQueue();
        }));
      runningServerQueueTasks.add(task);
    }
  }

  const serverQueueDrain = backgroundRuntime.createCoalescingTask(
    drainServerQueue,
    (error) => logger.warn({ err: error }, "server-owned chat queue drain failed"),
  );

  function wakeServerQueue() {
    if (!queueWorkerEnabled || !backgroundRuntime.acceptingWork) return;
    serverQueueDrain.wake();
  }

  if (queueWorkerEnabled) {
    const recoverChatControlOwners = () => {
      if (!backgroundRuntime.acceptingWork) return;
      return svc.generationProtocol.recoverStaleControlOwners({})
        .then(() => {
          wakeTerminalProjector();
          wakeServerQueue();
        })
        .catch((error) => logger.warn({ err: error }, "chat control recovery failed"));
    };
    backgroundRuntime.setTimeout(recoverChatControlOwners, 0);
    backgroundRuntime.setInterval(recoverChatControlOwners, 10_000);
  }

  router.get("/orgs/:orgId/chats", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const statusParam = typeof req.query.status === "string" ? req.query.status : "active";
    const status =
      statusParam === "resolved" || statusParam === "archived" || statusParam === "all"
        ? statusParam
        : "active";
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const projectId = typeof req.query.projectId === "string"
      ? req.query.projectId.trim() || undefined
      : undefined;
    const limit = typeof req.query.limit === "string"
      ? positiveIntegerQuery(req.query.limit, 50, 500)
      : undefined;
    const userId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const conversations = await svc.list(orgId, {
      status,
      q,
      limit,
      ...(projectId ? { projectId } : {}),
    }, userId);
    const visibleConversations = (conversations as ChatConversation[]).filter((conversation) => conversation.messengerVisible !== false);
    res.json(await assistantSvc.enrichConversations(visibleConversations));
  });

  router.post("/orgs/:orgId/chats", validate(createChatConversationSchema), async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const organization = await organizationsSvc.getById(orgId);
    if (!organization) {
      res.status(404).json({ error: "Organization not found" });
      return;
    }

    const contextLinks = req.body.contextLinks ?? [];
    await assertContextLinksBelongToCompany(orgId, contextLinks);
    if (req.body.preferredAgentId) {
      const agent = await agentsSvc.getById(req.body.preferredAgentId);
      if (!agent || agent.orgId !== orgId) {
        res.status(422).json({ error: "Preferred agent must belong to the same organization" });
        return;
      }
    }

    const actor = getActorInfo(req);
    const conversation = await svc.create(orgId, {
      title: req.body.title,
      summary: req.body.summary ?? null,
      preferredAgentId: req.body.preferredAgentId ?? null,
      issueCreationMode: req.body.issueCreationMode ?? organization.defaultChatIssueCreationMode,
      planMode: req.body.planMode ?? false,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
      contextLinks,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.created",
      entityType: "chat",
      entityId: conversation?.id ?? "unknown",
      details: {
        title: conversation?.title ?? "New chat",
        contextLinkCount: contextLinks.length,
        contextLinks: contextLinks.map((link: { entityType: "issue" | "project" | "agent"; entityId: string }) => ({
          entityType: link.entityType,
          entityId: link.entityId,
        })),
      },
    });

    res.status(201).json(await assistantSvc.enrichConversation(conversation as ChatConversation));
  });

  router.get("/chats/:id", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const refreshed = await svc.getById(conversation.id, userId);
    res.json(await assistantSvc.enrichConversation(refreshed as ChatConversation));
  });

  router.get("/chats/:id/work-manifest", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    await workManifestSvc.reconcileConversation(conversation.id);
    res.json(await workManifestSvc.getConversationManifest(conversation.id));
  });

  router.patch("/chats/:id", validate(updateChatConversationSchema), async (req, res) => {
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if ((existing as ChatConversation).mutability === "external_bound_chat" && !isTitleOnlyChatUpdate(req.body)) {
      assertChatLocalMutationAllowed(existing as ChatConversation);
    }
    await assertSideChatMutationAllowed(req, existing as ChatConversation);
    if (req.body.primaryIssueId) {
      const issue = await issuesSvc.getById(req.body.primaryIssueId);
      if (!issue || issue.orgId !== existing.orgId) {
        res.status(422).json({ error: "Primary issue must belong to the same organization" });
        return;
      }
    }
    if (req.body.preferredAgentId) {
      const agent = await agentsSvc.getById(req.body.preferredAgentId);
      if (!agent || agent.orgId !== existing.orgId) {
        res.status(422).json({ error: "Preferred agent must belong to the same organization" });
        return;
      }
    }
    if (req.body.routedAgentId) {
      const agent = await agentsSvc.getById(req.body.routedAgentId);
      if (!agent || agent.orgId !== existing.orgId) {
        res.status(422).json({ error: "Routed agent must belong to the same organization" });
        return;
      }
    }
    const updated = await svc.update(existing.id, {
      ...req.body,
      resolvedAt: req.body.resolvedAt ? new Date(req.body.resolvedAt) : req.body.resolvedAt,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.updated",
      entityType: "chat",
      entityId: existing.id,
      details: req.body,
    });
    res.json(updated ? await assistantSvc.enrichConversation(updated as ChatConversation) : null);
  });

  router.post("/chats/:id/title/regenerate", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    await assertSideChatMutationAllowed(req, existing as ChatConversation);
    const messages = await svc.listMessages(existing.id, { includeTranscript: false });
    const prompt = buildChatTitlePromptFromMessages(messages as ChatMessage[]);
    if (!prompt) {
      throw unprocessable("No chat messages available to generate a title");
    }

    const title = await generateChatTitle(existing.orgId, prompt);
    if (!title) {
      throw unprocessable("Fast Intelligence did not return a usable chat title");
    }

    const updated = await svc.update(existing.id, { title });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.title_regenerated",
      entityType: "chat",
      entityId: existing.id,
      details: {
        previousTitle: existing.title,
        title,
      },
    });

    res.json(updated ? await assistantSvc.enrichConversation(updated as ChatConversation) : null);
  });

  router.post("/chats/:id/fork", validate(forkChatConversationSchema), async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const sourceMessageId = req.body.sourceMessageId ?? null;
    if (!sourceMessageId && hasActiveChatGeneration(existing.id)) {
      throw conflict("Cannot fork a chat while a reply is in progress");
    }

    const actor = getActorInfo(req);
    const userId = boardUserId(req);
    const forked = await svc.forkConversation({
      sourceConversationId: existing.id,
      orgId: existing.orgId,
      userId,
      sourceMessageId,
      title: req.body.title,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.forked",
      entityType: "chat",
      entityId: forked?.id ?? "unknown",
      details: {
        sourceConversationId: existing.id,
        sourceMessageId,
        forkRootConversationId: forked?.forkRootConversationId ?? existing.id,
      },
    });

    res.status(201).json(await assistantSvc.enrichConversation(forked as ChatConversation));
  });

  router.post("/chats/:id/side-chats", validate(createSideChatSchema), async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    const sideChat = await sideChats.create({
      sourceConversationId: existing.id,
      sourceMessageId: req.body.sourceMessageId,
      clientMutationId: req.body.clientMutationId,
      orgId: existing.orgId,
      userId,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_created",
      entityType: "chat",
      entityId: sideChat.id,
      details: {
        sourceConversationId: existing.id,
        sourceMessageId: req.body.sourceMessageId,
      },
    });
    res.status(201).json(await assistantSvc.enrichConversation(sideChat));
  });

  router.post("/chats/:id/side-chat/complete", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing || existing.conversationKind !== "side_chat") {
      res.status(404).json({ error: "Side Chat not found" });
      return;
    }
    const userId = boardUserId(req);
    const sideChat = await sideChats.complete({
      conversationId: req.params.id as string,
      userId,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: sideChat.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_completed",
      entityType: "chat",
      entityId: sideChat.id,
      details: {
        sourceConversationId: sideChat.forkedFromConversationId,
        sourceMessageId: sideChat.forkedFromMessageId,
      },
    });
    res.json(await assistantSvc.enrichConversation(sideChat));
  });

  router.post("/chats/:id/side-chat/keep", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing || existing.conversationKind !== "side_chat") {
      res.status(404).json({ error: "Side Chat not found" });
      return;
    }
    const userId = boardUserId(req);
    const sideChat = await sideChats.keepInMessenger({
      conversationId: req.params.id as string,
      userId,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: sideChat.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.side_chat_kept",
      entityType: "chat",
      entityId: sideChat.id,
      details: {
        sourceConversationId: sideChat.forkedFromConversationId,
        sourceMessageId: sideChat.forkedFromMessageId,
      },
    });
    res.json(await assistantSvc.enrichConversation(sideChat));
  });

  router.delete("/chats/:id", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(existing as ChatConversation);
    if ((existing as ChatConversation).conversationKind === "side_chat") {
      throw conflict("Side Chat audit records cannot be deleted");
    }
    if (hasActiveChatGeneration(existing.id)) {
      if (req.query.cancelActive === "true") {
        cancelAndReleaseActiveChatGeneration(existing.id);
      } else {
        throw conflict("Cannot delete a chat while a reply is in progress");
      }
    }
    const attachments = await svc.listAttachmentsForConversation(existing.id);
    const deleted = await svc.remove(existing.id);
    if (!deleted) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        if (!await svc.assetHasAttachments(attachment.assetId)) {
          await storage.deleteObject(attachment.orgId, attachment.objectKey);
        }
      } catch (err) {
        logger.warn({ err, conversationId: existing.id, attachmentId: attachment.id }, "failed to delete chat attachment object during chat delete");
      }
    }

    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: existing.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.deleted",
      entityType: "chat",
      entityId: existing.id,
      details: {
        title: existing.title,
      },
    });

    res.json(deleted);
  });

  router.get("/chats/:id/queue", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const active = getActiveChatGeneration(conversation.id);
    res.json(await svc.getQueueSnapshot(conversation.id, active?.generationId ?? null));
  });

  router.post("/chats/:id/queue", validate(createChatQueuedMessageSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const requestActor = queueRequestActor(req);
    const item = await svc.createQueuedMessage({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      clientMutationId: req.body.clientMutationId,
      expectedGenerationId: req.body.expectedGenerationId ?? getActiveChatGeneration(conversation.id)?.generationId ?? null,
      payload: req.body.payload,
      requestActor,
    });
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.queue.created",
      entityType: "chat",
      entityId: conversation.id,
      details: {
        queuedMessageId: item.id,
        position: item.position,
      },
    });
    wakeServerQueue();
    res.status(201).json(item);
  });

  router.post("/chats/:id/queue/next/claim", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    if (hasActiveChatGeneration(conversation.id)) {
      throw conflict("Cannot dequeue the next message while a reply is in progress");
    }
    const latestGeneration = await svc.getLatestGeneration(conversation.id);
    if (latestGeneration && latestGeneration.status !== "completed") {
      throw conflict("Queued follow-ups remain parked after a stopped or failed reply");
    }
    const item = await svc.claimNextQueuedMessage(conversation.id);
    if (item) {
      const actor = getActorInfo(req);
      await logActivity(db, {
        orgId: conversation.orgId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "chat.queue.claimed",
        entityType: "chat",
        entityId: conversation.id,
        details: {
          queuedMessageId: item.id,
          position: item.position,
        },
      });
    }
    res.json({ item });
  });

  router.post("/chats/:id/queue/:itemId/release-claim", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const item = await svc.releaseQueuedMessageClaim({
      conversationId: conversation.id,
      itemId: req.params.itemId as string,
      reason: "delivery_failed",
    });
    res.json({ item });
  });

  router.patch("/chats/:id/queue/:itemId", validate(updateChatQueuedMessageSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const item = await svc.updateQueuedMessage({
      conversationId: conversation.id,
      itemId: req.params.itemId as string,
      version: req.body.version,
      payload: req.body.payload,
    });
    res.json(item);
  });

  router.delete("/chats/:id/queue/:itemId", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const parsed = cancelChatQueuedMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid queued message cancel request", details: parsed.error.issues });
      return;
    }
    const item = await svc.cancelQueuedMessage({
      conversationId: conversation.id,
      itemId: req.params.itemId as string,
      version: parsed.data.version ?? null,
    });
    res.json(item);
  });

  router.post("/chats/:id/queue/:itemId/steer", validate(steerChatQueuedMessageSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    const active = getActiveChatGeneration(conversation.id);
    const requestActor = queueRequestActor(req);
    const controlActionId = req.body.controlActionId ?? randomUUID();
    const expectedGenerationId = req.body.expectedActiveGenerationId
      ?? active?.generationId
      ?? null;
    if (!expectedGenerationId) {
      const scheduled = await svc.scheduleSteerContinuation({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: req.params.itemId as string,
        controlActionId,
        requestActor,
      });
      wakeServerQueue();
      res.json({
        item: scheduled.item,
        result: "scheduled_next" as const,
        disposition: "continuation_pending" as const,
        controlActionId,
        activeGenerationId: scheduled.action.expectedGenerationId ?? null,
        queueVersion: scheduled.item.version,
        transcriptEventId: null,
      });
      return;
    }
    const queueSnapshot = await svc.getQueueSnapshot(conversation.id, expectedGenerationId);
    const expectedAttemptEpoch = req.body.expectedAttemptEpoch
      ?? queueSnapshot.activeAttemptEpoch
      ?? active?.attemptEpoch
      ?? 0;
    const expectedControlVersion = req.body.expectedControlVersion
      ?? queueSnapshot.activeControlVersion
      ?? 0;
    const started = await svc.beginSteerControlAction({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      itemId: req.params.itemId as string,
      controlActionId,
      expectedGenerationId,
      expectedAttemptEpoch,
      expectedControlVersion,
      requestActor,
    });
    const durableControlActionId = started.action.id;
    const durableGenerationId = started.action.expectedGenerationId ?? expectedGenerationId;
    const durableAttemptEpoch = started.action.expectedAttemptEpoch ?? expectedAttemptEpoch;

    const responseForDurableDisposition = (
      item: typeof started.item,
      disposition: typeof started.action.localDisposition,
    ) => ({
      item,
      result: disposition === "accepted_current"
        ? "delivered_current" as const
        : disposition === "acceptance_unknown"
          ? "acceptance_unknown" as const
          : disposition === "continuation_pending"
            ? "scheduled_next" as const
            : disposition === "failed_actionable"
              ? "failed_actionable" as const
              : "pending" as const,
      disposition,
      controlActionId: durableControlActionId,
      activeGenerationId: durableGenerationId,
      queueVersion: item.version,
      transcriptEventId: null,
    });

    if (started.idempotent && started.action.localDisposition !== "pending") {
      if (started.action.localDisposition === "continuation_pending") wakeServerQueue();
      res.json(responseForDurableDisposition(started.item, started.action.localDisposition));
      return;
    }
    if (started.action.localDisposition === "continuation_pending") {
      wakeServerQueue();
      res.json(responseForDurableDisposition(started.item, started.action.localDisposition));
      return;
    }
    type DeniedProviderSend = Extract<
      NonNullable<Awaited<ReturnType<typeof svc.claimSteerProviderSend>>>,
      { sendDenied: true }
    >;
    const providerSendState: { denied: DeniedProviderSend | null } = { denied: null };
    const runtimeResult = await steerActiveChatGeneration({
      conversationId: conversation.id,
      expectedGenerationId: durableGenerationId,
      expectedAttemptEpoch: durableAttemptEpoch,
      feedback: {
        text: started.item.payload.body,
        clientMessageId: started.action.providerClientMessageId ?? durableControlActionId,
      },
      claimProviderSend: async () => {
        const sendClaim = await svc.claimSteerProviderSend({
          orgId: conversation.orgId,
          controlActionId: durableControlActionId,
        });
        if (!sendClaim) return null;
        if ("sendDenied" in sendClaim) {
          providerSendState.denied = sendClaim;
          return {
            sendDenied: true as const,
            reason: "generation_fence_changed" as const,
          };
        }
        try {
          await svc.appendGenerationEvent({
            orgId: conversation.orgId,
            generationId: durableGenerationId,
            attemptEpoch: durableAttemptEpoch,
            eventKind: "steer_requested",
            payload: { controlActionId: durableControlActionId, queueItemId: started.item.id },
            controlActionId: durableControlActionId,
            queueItemId: started.item.id,
          });
        } catch (error) {
          await svc.releaseSteerProviderSendClaim({
            orgId: conversation.orgId,
            controlActionId: durableControlActionId,
            reason: "steer_requested_event_failed",
          }).catch(() => null);
          throw error;
        }
        return {
          clientMessageId: sendClaim.providerClientMessageId ?? durableControlActionId,
          release: async () => {
            const released = await svc.releaseSteerProviderSendClaim({
              orgId: conversation.orgId,
              controlActionId: durableControlActionId,
              reason: "runtime_owner_changed_before_provider_send",
            });
            if (!released) {
              throw new Error("Steer provider send claim could not be safely released before send");
            }
          },
        };
      },
    });

    if (runtimeResult.status === "provider_send_in_flight") {
      res.json(responseForDurableDisposition(started.item, started.action.localDisposition));
      return;
    }

    const deniedProviderSend = providerSendState.denied;
    if (deniedProviderSend) {
      if (deniedProviderSend.reason === "stop_cutoff_won_before_provider_send") {
        await interruptActiveChatGeneration(conversation.id, "steer_fallback");
      }
      wakeServerQueue();
      res.json(responseForDurableDisposition(
        deniedProviderSend.item,
        deniedProviderSend.action.localDisposition,
      ));
      return;
    }

    let resolution: Awaited<ReturnType<typeof svc.resolveSteerControlAction>>;
    if (runtimeResult.status === "delivered_current") {
      resolution = await svc.resolveSteerControlAction({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: started.item.id,
        controlActionId: durableControlActionId,
        status: "accepted_current",
        disposition: "accepted_current",
        providerDisposition: "acknowledged",
        providerThreadId: runtimeResult.providerThreadId,
        providerTurnId: runtimeResult.providerTurnId,
        providerEvidence: {
          receipt: "same_turn",
          attemptEpoch: runtimeResult.attemptEpoch,
          ownerChangedAfterSend: runtimeResult.ownerChangedAfterSend === true,
        },
      });
      await svc.appendGenerationEvent({
        orgId: conversation.orgId,
        generationId: durableGenerationId,
        attemptEpoch: runtimeResult.attemptEpoch,
        eventKind: "steer_acknowledged",
        payload: {
          controlActionId: durableControlActionId,
          providerThreadId: runtimeResult.providerThreadId,
          providerTurnId: runtimeResult.providerTurnId,
        },
        controlActionId: durableControlActionId,
        queueItemId: started.item.id,
      });
    } else if (runtimeResult.status === "acceptance_unknown") {
      resolution = await svc.resolveSteerControlAction({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: started.item.id,
        controlActionId: durableControlActionId,
        status: "acceptance_unknown",
        disposition: "acceptance_unknown",
        providerDisposition: "connection_lost",
        reason: runtimeResult.reason,
        providerEvidence: {
          attemptEpoch: runtimeResult.attemptEpoch,
          ownerChangedAfterSend: runtimeResult.ownerChangedAfterSend === true,
        },
      });
    } else if (runtimeResult.status === "continuation_required") {
      const cutoff = await svc.generationProtocol.beginSteerFallbackCutoff({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        generationId: durableGenerationId,
        expectedAttemptEpoch: durableAttemptEpoch,
        controlActionId: durableControlActionId,
        queueItemId: started.item.id,
        requestedRenderSeq: req.body.lastCommittedRenderSeq,
        requestedBodyHash: req.body.renderedBodyHash,
      });
      const completionCommitted = cutoff.outcome === "completion_committed";
      const interrupt = completionCommitted
        ? null
        : interruptActiveChatGeneration(conversation.id, "steer_fallback");
      const interruptDisposition = interrupt ? await interrupt : "unverified" as const;
      resolution = await svc.resolveSteerControlAction({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: started.item.id,
        controlActionId: durableControlActionId,
        status: "continuation_pending",
        disposition: "continuation_pending",
        providerDisposition: "not_sent",
        providerEvidence: {
          ...(cutoff.action.providerEvidence ?? {}),
          ...(completionCommitted
            ? { completionDisposition: "committed" }
            : {
              interruptDisposition,
              acceptedThroughSeq: cutoff.action.acceptedThroughSeq,
              frozenBodyHash: cutoff.action.frozenBodyHash,
            }),
        },
        reason: completionCommitted
          ? "target_generation_completion_committed"
          : interrupt
            ? "runtime_requires_continuation"
            : "runtime_owner_missing_during_steer_fallback",
      });
      if (!completionCommitted && !interrupt) {
        await svc.generationProtocol.recordRuntimeTerminal({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          generationId: durableGenerationId,
          expectedAttemptEpoch: durableAttemptEpoch,
          finalStatus: "interrupted_unverified",
          terminalReason: "steer_fallback_runtime_owner_missing",
          controlActionId: durableControlActionId,
          payload: { interruptDisposition },
        });
        wakeTerminalProjector();
      }
      wakeServerQueue();
    } else {
      resolution = await svc.resolveSteerControlAction({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: started.item.id,
        controlActionId: durableControlActionId,
        status: "continuation_pending",
        disposition: "continuation_pending",
        providerDisposition: "not_sent",
        reason: "stale_generation",
      });
      await svc.appendGenerationEvent({
        orgId: conversation.orgId,
        generationId: durableGenerationId,
        attemptEpoch: durableAttemptEpoch,
        eventKind: "continuation_scheduled",
        payload: { controlActionId: durableControlActionId, reason: "stale_generation" },
        controlActionId: durableControlActionId,
        queueItemId: started.item.id,
      });
      wakeServerQueue();
    }
    res.json({
      ...responseForDurableDisposition(resolution.item, resolution.action.localDisposition),
      activeGenerationId: durableGenerationId,
      queueVersion: resolution.item.version,
      transcriptEventId: null,
    });
  });


  router.get("/chats/:id/messages", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.mutability !== "external_bound_chat" && !hasActiveChatGeneration(conversation.id)) {
      await svc.markInterruptedStreamingMessages(conversation.id);
    }
    const includeTranscript = req.query.includeTranscript === "true";
    const messages = await svc.listMessages(conversation.id, { includeTranscript });
    if (req.query.envelope === "true") {
      res.json(paginateChatMessages(messages, req.query));
      return;
    }
    res.json(messages);
  });

  router.get("/chats/:id/messages/:messageId/transcript", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const transcript = await svc.getMessageTranscript(conversation.id, req.params.messageId as string);
    if (!transcript) {
      res.status(404).json({ error: "Chat message not found" });
      return;
    }
    res.json(transcript);
  });

  router.post("/chats/:id/messages", validate(addChatMessageSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    const actor = getActorInfo(req);
    assertChatLocalMutationAllowed(conversation as ChatConversation);
    await assertSideChatMutationAllowed(req, conversation as ChatConversation);
    if (actor.actorType === "agent") {
      if (req.body.editUserMessageId) {
        res.status(422).json({ error: "Agent-authored chat messages cannot edit operator messages" });
        return;
      }
      const message = await addAgentAuthoredMessage(conversation as ChatConversation, req.body.body, actor);
      res.status(201).json({ messages: [message] });
      return;
    }

    const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
    if (!assistantAvailability.available) {
      res.status(503).json({ error: assistantAvailability.error });
      return;
    }

    const releaseGeneration = claimChatGeneration(conversation.id, null, null);
    if (!releaseGeneration) {
      const item = await svc.createQueuedMessage({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        clientMutationId: `message:${randomUUID()}`,
        expectedGenerationId: getActiveChatGeneration(conversation.id)?.generationId ?? null,
        requestActor: queueRequestActor(req),
        payload: {
          body: req.body.body,
          attachmentIds: [],
          skillRefs: [],
          projectId: null,
          accessMode: null,
          model: null,
          effort: null,
          metadata: {
            source: "messages_endpoint_during_active_generation",
          },
        },
      });
      wakeServerQueue();
      res.status(202).json({ queued: item });
      return;
    }

    try {
      const userMessage = await addUserMessage(
        conversation as ChatConversation,
        req.body.body,
        actor,
        req.body.editUserMessageId ?? null,
      );
      await touchSideChat(req, conversation as ChatConversation);
      if (!req.body.editUserMessageId) {
        startChatTitleGeneration(conversation as ChatConversation, userMessage);
      }
      const turnContext = turnContextFromUserMessage(userMessage);
      let activeChatRunId: string | null = null;
      const persistedAssistantMessages = await (async () => {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          const transcript: TranscriptEntry[] = [];
          let fallbackOutput: string | null = null;
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              userMessageId: userMessage.id,
              chatTurnId: turnContext.chatTurnId,
              turnVariant: turnContext.turnVariant,
              stream: false,
              onRunCreated: (runId) => {
                activeChatRunId = runId;
              },
              onTranscriptEntry: async (entry) => {
                transcript.push(entry);
              },
            });
            fallbackOutput = streamed.partialBody;
            if (streamed.outcome !== "completed") {
              throw new Error("Chat assistant reply was stopped before completion");
            }
            const created = await persistAssistantReply(
              req,
              assistantInput.conversation,
              actor,
              streamed.reply,
              turnContext,
              transcript,
              streamed.replyingAgentId,
              null,
              activeChatRunId,
            );
            await linkChatRunMessages(assistantInput.conversation, activeChatRunId, created);
            await logChatMessagesAdded(assistantInput.conversation, created, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            return created;
          } catch (error) {
            if (error instanceof ChatAssistantStreamError) {
              fallbackOutput = userVisiblePartialBodyFromError(error);
              const failurePayload = recoverableFailurePayload(error, activeChatRunId);
              const failureBody = fallbackOutput || recoverableFailureBody(failurePayload) || CHAT_ASSISTANT_USER_ERROR_MESSAGE;
              const failedMessage = await persistPartialAssistantMessage(
                assistantInput.conversation,
                failureBody,
                "failed",
                turnContext,
                transcript,
                chatReplyingAgentId(assistantInput.conversation),
                null,
                activeChatRunId,
                failurePayload,
              );
              const failedMessages = failedMessage ? [failedMessage as ChatMessage] : [];
              await linkChatRunMessages(assistantInput.conversation, activeChatRunId, failedMessages);
              if (failedMessages.length > 0) {
                await logChatMessagesAdded(assistantInput.conversation, failedMessages, {
                  actorType: "system",
                  actorId: "chat-assistant",
                  agentId: chatReplyingAgentId(assistantInput.conversation),
                });
              }
              fallbackOutput = failureBody;
              return failedMessages;
            }
            throw error;
          }
      })();
      const createdMessages: ChatMessage[] = [userMessage, ...persistedAssistantMessages];
      res.status(201).json({ messages: createdMessages });
    } catch (err) {
      logger.warn({ err, conversationId: conversation.id }, "chat assistant reply failed");
      if (err instanceof HttpError) {
        throw err;
      }
      res.status(502).json({
        error: CHAT_ASSISTANT_USER_ERROR_MESSAGE,
      });
    } finally {
      releaseGeneration();
    }
  });

  registerChatStreamRoutes({
    router,
    db,
    storage,
    svc,
    assistantSvc,
    agentsSvc,
    issuesSvc,
    projectsSvc,
    goalsSvc,
    access,
    operatorProfiles,
    heartbeat,
    assertConversationAccess,
    assertChatLocalMutationAllowed,
    assertSideChatMutationAllowed,
    touchSideChat,
    boardUserId,
    assertCanAssignTasks,
    runSingleFileUpload,
    runMessageFileUpload,
    isMultipartRequest,
    uploadedMessageFiles,
    validateUploadedMessageFiles,
    logChatMessagesAdded,
    assertContextLinksBelongToCompany,
    turnContextFromUserMessage,
    addUserMessage,
    startChatTitleGeneration,
    attachFilesToUserMessage,
    loadAssistantInput,
    chatReplyingAgentId,
    assertCanConvertIssueProposal,
    persistAssistantReply,
    linkChatRunMessages,
    attachGeneratedFilesToPartialMessage,
    persistPartialAssistantMessage,
    recoverableFailurePayload,
    recoverableFailureBody,
    writeStreamEvent,
    queueRequestActor,
    wakeServerQueue,
    wakeTerminalProjector,
  });
  return router;
}
