import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  addChatMessageSchema,
  updateChatConversationUserStateSchema,
  type ChatContextLink,
  type ChatConversation,
  type ChatAttachment,
  type ChatMessage,
  type ExecutionObservabilityContext,
  type ExecutionObservabilitySurface,
  convertChatToIssueSchema,
  createChatAttachmentMetadataSchema,
  createChatContextLinkSchema,
  createChatConversationSchema,
  resolveChatOperationProposalSchema,
  setChatProjectContextSchema,
  updateChatConversationSchema,
} from "@rudderhq/shared";
import type { StorageService } from "../storage/types.js";
import type { AgentRuntimeInvocationMeta } from "../agent-runtimes/index.js";
import { isAllowedContentType, MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { HttpError } from "../errors.js";
import {
  observeExecutionEvent,
  updateExecutionObservation,
  updateExecutionTraceIO,
  withExecutionObservation,
} from "../langfuse.js";
import { emitExecutionTranscriptTree } from "../langfuse-transcript.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";
import {
  ChatAssistantStreamError,
  chatAssistantService,
  type ChatAssistantResult,
} from "../services/chat-assistant.js";
import { cancelActiveChatGeneration, claimChatGeneration } from "../services/chat-generation-locks.js";
import {
  agentService,
  chatService,
  operatorProfileService,
  organizationService,
  goalService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import { summarizeRuntimeSkillsForTrace } from "../services/runtime-trace-metadata.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function chatRoutes(db: Db, storage: StorageService) {
  const router = Router();
  const svc = chatService(db);
  const organizationsSvc = organizationService(db);
  const issuesSvc = issueService(db);
  const projectsSvc = projectService(db);
  const agentsSvc = agentService(db);
  const goalsSvc = goalService(db);
  const assistantSvc = chatAssistantService(db);
  const operatorProfiles = operatorProfileService(db);

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
    return conversation;
  }

  function boardUserId(req: Request) {
    assertBoard(req);
    return req.actor.userId ?? "local-board";
  }

  function buildChatObservabilityContext(
    conversation: ChatConversation,
    input: {
      surface?: ExecutionObservabilitySurface;
      rootExecutionId: string;
      trigger: string;
      runtime?: string | null;
      status?: string | null;
      issueId?: string | null;
      metadata?: Record<string, unknown> | null;
    },
  ): ExecutionObservabilityContext {
    return {
      surface: input.surface ?? "chat_action",
      rootExecutionId: input.rootExecutionId,
      orgId: conversation.orgId,
      agentId: conversation.preferredAgentId ?? null,
      issueId: input.issueId ?? conversation.primaryIssueId ?? null,
      sessionKey: conversation.id,
      runtime: input.runtime ?? null,
      trigger: input.trigger,
      status: input.status ?? null,
      metadata: {
        conversationId: conversation.id,
        ...(input.metadata ?? {}),
      },
    };
  }

  async function withChatObservation<T>(
    context: ExecutionObservabilityContext,
    input: {
      name: string;
      asType?: "span" | "agent" | "generation" | "tool" | "chain" | "retriever" | "evaluator" | "guardrail" | "embedding";
      input?: unknown;
      metadata?: Record<string, unknown>;
    },
    fn: (observation: LangfuseObservation | null) => Promise<T>,
  ) {
    let executionError: unknown = null;
    try {
      return await withExecutionObservation(context, input, async (observation) => {
        try {
          return await fn(observation);
        } catch (error) {
          executionError = error;
          throw error;
        }
      });
    } catch (error) {
      if (executionError && error === executionError) {
        throw error;
      }
      logger.warn(
        {
          rootExecutionId: context.rootExecutionId,
          trigger: context.trigger,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to emit Langfuse chat observation",
      );
      return fn(null);
    }
  }

  async function emitChatObservationEvent(
    context: ExecutionObservabilityContext,
    input: Parameters<typeof observeExecutionEvent>[1],
  ) {
    try {
      await observeExecutionEvent(context, input);
    } catch (error) {
      logger.warn(
        {
          rootExecutionId: context.rootExecutionId,
          eventName: input.name,
          err: error instanceof Error ? error.message : String(error),
        },
        "Failed to emit Langfuse chat event",
      );
    }
  }

  function summarizeChatObservationMessages(messages: ChatMessage[]) {
    const proposalMessage = messages.find(
      (message) => message.kind === "issue_proposal" || message.kind === "operation_proposal",
    );
    const systemEventMessage = messages.find((message) => message.kind === "system_event");
    const systemPayload =
      systemEventMessage?.structuredPayload && typeof systemEventMessage.structuredPayload === "object"
        ? (systemEventMessage.structuredPayload as Record<string, unknown>)
        : null;

    return {
      createdMessageIds: messages.map((message) => message.id),
      assistantKind: proposalMessage?.kind ?? messages.find((message) => message.role === "assistant")?.kind ?? null,
      approvalId: proposalMessage?.approvalId ?? null,
      issueId: typeof systemPayload?.issueId === "string" ? systemPayload.issueId : null,
      issueIdentifier: typeof systemPayload?.issueIdentifier === "string" ? systemPayload.issueIdentifier : null,
      eventType: typeof systemPayload?.eventType === "string" ? systemPayload.eventType : null,
    };
  }

  function buildChatTraceInput(
    input: {
      conversationId: string;
      body: string;
      userMessageId: string;
    },
    invocationMeta?: AgentRuntimeInvocationMeta | null,
  ) {
    return {
      conversationId: input.conversationId,
      body: input.body,
      userMessageId: input.userMessageId,
      instruction:
        typeof invocationMeta?.prompt === "string" && invocationMeta.prompt.trim().length > 0
          ? invocationMeta.prompt
          : null,
      promptMetrics: invocationMeta?.promptMetrics ?? null,
    };
  }

  function mergeChatInvocationTraceMetadata(
    context: ExecutionObservabilityContext,
    invocationMeta: AgentRuntimeInvocationMeta,
  ) {
    context.metadata = {
      ...(context.metadata ?? {}),
      runtimeAgentType: invocationMeta.agentRuntimeType,
      runtimeCommand: invocationMeta.command,
      runtimeCwd: invocationMeta.cwd ?? null,
      runtimeCommandNotes: invocationMeta.commandNotes ?? [],
      runtimePromptMetrics: invocationMeta.promptMetrics ?? null,
      runtimePromptCaptured: typeof invocationMeta.prompt === "string" && invocationMeta.prompt.length > 0,
      ...(Array.isArray(invocationMeta.loadedSkills)
        ? summarizeRuntimeSkillsForTrace(invocationMeta.loadedSkills)
        : {}),
    };
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

  async function attachFilesToUserMessage(
    conversation: ChatConversation,
    messageId: string,
    files: Array<{ mimetype: string; buffer: Buffer; originalname: string }>,
    actor: ActorInfo,
  ): Promise<ChatAttachment[]> {
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

    return {
      conversation: hydratedConversation,
      messages: freshMessages as ChatMessage[],
      contextLinks: (hydratedConversation.contextLinks ?? conversation.contextLinks) as ChatContextLink[],
      operatorProfile,
    };
  }

  function chatReplyingAgentId(conversation: ChatConversation | null | undefined) {
    return conversation?.chatRuntime?.runtimeAgentId ?? conversation?.preferredAgentId ?? null;
  }

  async function persistAssistantReply(
    conversation: ChatConversation,
    actor: ActorInfo,
    assistantReply: ChatAssistantResult,
    turnContext: ChatTurnContext,
    transcript: TranscriptEntry[] = [],
    replyingAgentId = assistantReply.replyingAgentId ?? chatReplyingAgentId(conversation),
  ) {
    const createdMessages: ChatMessage[] = [];
    const { chatTurnId, turnVariant } = turnContext;

    if (assistantReply.kind === "issue_proposal") {
      const shouldAutoCreateIssue = conversation.planMode || conversation.issueCreationMode === "auto_create";
      if (shouldAutoCreateIssue) {
        const proposalMessage = await svc.addMessage(conversation.id, {
          orgId: conversation.orgId,
          role: "assistant",
          kind: "issue_proposal",
          body: assistantReply.body,
          structuredPayload: assistantReply.structuredPayload,
          transcript,
          replyingAgentId,
          chatTurnId,
          turnVariant,
        });
        createdMessages.push(proposalMessage as ChatMessage);

        const issue = await svc.convertToIssue(conversation.id, {
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          messageId: proposalMessage.id,
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
            source: conversation.planMode ? "plan_mode" : "auto_create",
          },
        });
        return createdMessages;
      }

      const approval = await svc.createProposalApproval(conversation.orgId, {
        type: "chat_issue_creation",
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        payload: {
          chatConversationId: conversation.id,
          proposedIssue:
            assistantReply.structuredPayload &&
            typeof assistantReply.structuredPayload.issueProposal === "object" &&
            assistantReply.structuredPayload.issueProposal !== null
              ? assistantReply.structuredPayload.issueProposal
              : assistantReply.structuredPayload,
        },
      });

      const proposalMessage = await svc.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "assistant",
        kind: "issue_proposal",
        body: assistantReply.body,
        structuredPayload: assistantReply.structuredPayload,
        transcript,
        approvalId: approval.id,
        replyingAgentId,
        chatTurnId,
        turnVariant,
      });
      createdMessages.push(proposalMessage as ChatMessage);
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
      const proposalMessage = await svc.addMessage(conversation.id, {
        orgId: conversation.orgId,
        role: "assistant",
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
        transcript,
        approvalId: approval.id,
        replyingAgentId,
        chatTurnId,
        turnVariant,
      });
      createdMessages.push(proposalMessage as ChatMessage);
      return createdMessages;
    }

    const assistantMessage = await svc.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: assistantReply.kind === "routing_suggestion" ? "routing_suggestion" : "message",
      body: assistantReply.body,
      structuredPayload: assistantReply.structuredPayload,
      transcript,
      replyingAgentId,
      chatTurnId,
      turnVariant,
    });
    createdMessages.push(assistantMessage as ChatMessage);
    return createdMessages;
  }

  async function persistPartialAssistantMessage(
    conversation: ChatConversation,
    body: string,
    status: "stopped" | "failed",
    turnContext: ChatTurnContext | null,
    transcript: TranscriptEntry[] = [],
    replyingAgentId = chatReplyingAgentId(conversation),
  ) {
    const trimmed = body.trim();
    if (!trimmed) return null;
    const chatTurnId = turnContext?.chatTurnId ?? randomUUID();
    const turnVariant = turnContext?.turnVariant ?? 0;
    const message = await svc.addMessage(conversation.id, {
      orgId: conversation.orgId,
      role: "assistant",
      kind: "message",
      status,
      body: trimmed,
      transcript,
      replyingAgentId,
      chatTurnId,
      turnVariant,
    });
    return message as ChatMessage;
  }

  function writeStreamEvent(
    res: Response,
    event: Record<string, unknown>,
  ) {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`${JSON.stringify(event)}\n`);
    return true;
  }

  router.get("/orgs/:orgId/chats", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const statusParam = typeof req.query.status === "string" ? req.query.status : "active";
    const status =
      statusParam === "resolved" || statusParam === "archived" || statusParam === "all"
        ? statusParam
        : "active";
    const userId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const conversations = await svc.list(orgId, { status }, userId);
    res.json(await assistantSvc.enrichConversations(conversations as ChatConversation[]));
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

  router.patch("/chats/:id", validate(updateChatConversationSchema), async (req, res) => {
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
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

  router.get("/chats/:id/messages", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const messages = await svc.listMessages(conversation.id);
    res.json(messages);
  });

  router.post("/chats/:id/messages", validate(addChatMessageSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
    if (!assistantAvailability.available) {
      res.status(503).json({ error: assistantAvailability.error });
      return;
    }

    const releaseGeneration = claimChatGeneration(conversation.id);
    if (!releaseGeneration) {
      res.status(409).json({ error: "A chat reply is already being generated for this conversation" });
      return;
    }

    const actor = getActorInfo(req);
    let chatObservation: ExecutionObservabilityContext | null = null;
    try {
      const userMessage = await addUserMessage(
        conversation as ChatConversation,
        req.body.body,
        actor,
        req.body.editUserMessageId ?? null,
      );
      const turnContext = turnContextFromUserMessage(userMessage);
      chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
        surface: "chat_turn",
        rootExecutionId: turnContext.chatTurnId,
        trigger: "assistant_reply",
        runtime: assistantAvailability.agentRuntimeType ?? null,
        metadata: {
          stream: false,
          userMessageId: userMessage.id,
          editUserMessageId: req.body.editUserMessageId ?? null,
        },
      });
      const traceInputBase = {
        conversationId: conversation.id,
        body: req.body.body,
        userMessageId: userMessage.id,
      };
      let currentChatTraceInput = buildChatTraceInput(traceInputBase);
      const persistedAssistantMessages = await withChatObservation(
        chatObservation,
        {
          name: "chat_turn",
          asType: "agent",
          input: currentChatTraceInput,
        },
        async (observation) => {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          const transcript: TranscriptEntry[] = [];
          const observedTranscript: TranscriptEntry[] = [];
          let fallbackOutput: string | null = null;
          let finalChatOutput: string | null = null;
          let finalChatStatus: "completed" | "failed" = "completed";
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              onInvocationMeta: async (meta) => {
                currentChatTraceInput = buildChatTraceInput(traceInputBase, meta);
                mergeChatInvocationTraceMetadata(chatObservation!, meta);
                updateExecutionObservation(observation, chatObservation!, {
                  input: currentChatTraceInput,
                });
                updateExecutionTraceIO(observation, { input: currentChatTraceInput });
              },
              onTranscriptEntry: async (entry) => {
                transcript.push(entry);
              },
              onObservedTranscriptEntry: async (entry) => {
                observedTranscript.push(entry);
              },
            });
            fallbackOutput = streamed.partialBody;
            if (streamed.outcome !== "completed") {
              finalChatStatus = "failed";
              throw new Error("Chat assistant reply was stopped before completion");
            }
            const created = await persistAssistantReply(
              assistantInput.conversation,
              actor,
              streamed.reply,
              turnContext,
              transcript,
              streamed.replyingAgentId,
            );
            finalChatOutput = streamed.reply.body;
            await logChatMessagesAdded(assistantInput.conversation, created, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            const summary = summarizeChatObservationMessages(created);
            await emitChatObservationEvent(chatObservation!, {
              name: "chat.reply.persisted",
              metadata: {
                transcriptEntries: transcript.length,
                observedTranscriptEntries: observedTranscript.length,
                ...summary,
              },
            });
            return created;
          } catch (error) {
            if (error instanceof ChatAssistantStreamError) {
              fallbackOutput = error.partialBody;
            }
            finalChatStatus = "failed";
            throw error;
          } finally {
            try {
              const transcriptStats = emitExecutionTranscriptTree({
                context: chatObservation!,
                parentObservation: observation,
                transcript: observedTranscript,
                fallbackResult: fallbackOutput
                  ? {
                    output: fallbackOutput,
                  }
                  : null,
              });
              finalChatOutput = finalChatOutput ?? transcriptStats.finalOutput ?? fallbackOutput ?? null;
            } catch (error) {
              logger.warn(
                {
                  rootExecutionId: chatObservation!.rootExecutionId,
                  err: error instanceof Error ? error.message : String(error),
                },
                "Failed to export chat transcript tree to Langfuse",
              );
            }
            updateExecutionObservation(observation, {
              ...chatObservation!,
              status: finalChatStatus,
            }, {
              input: currentChatTraceInput,
              output: finalChatOutput,
              level: finalChatStatus === "failed" ? "ERROR" : "DEFAULT",
              statusMessage: finalChatStatus,
            });
            updateExecutionTraceIO(observation, {
              input: currentChatTraceInput,
              output: finalChatOutput,
            });
          }
        },
      );
      const createdMessages: ChatMessage[] = [userMessage, ...persistedAssistantMessages];
      res.status(201).json({ messages: createdMessages });
    } catch (err) {
      if (chatObservation) {
        await emitChatObservationEvent(chatObservation, {
          name: "chat.reply.failed",
          level: "ERROR",
          metadata: {
            error: err instanceof Error ? err.message : String(err),
          },
          statusMessage: err instanceof Error ? err.message : "chat_reply_failed",
        });
      }
      logger.warn({ err, conversationId: conversation.id }, "chat assistant reply failed");
      res.status(502).json({
        error: err instanceof Error ? err.message : "Chat assistant failed to respond",
      });
    } finally {
      releaseGeneration();
    }
  });

  router.post("/chats/:id/messages/stream", async (req, res) => {
    if (isMultipartRequest(req)) {
      try {
        await runMessageFileUpload(req, res);
      } catch (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
            return;
          }
          res.status(400).json({ error: err.message });
          return;
        }
        throw err;
      }
    }

    const parsedBody = addChatMessageSchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      res.status(400).json({ error: "Invalid chat message", details: parsedBody.error.issues });
      return;
    }
    const messageFiles = uploadedMessageFiles(req);
    const attachmentValidationError = validateUploadedMessageFiles(messageFiles);
    if (attachmentValidationError) {
      res.status(422).json({ error: attachmentValidationError });
      return;
    }

    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    const assistantAvailability = await assistantSvc.getChatAssistantAvailability(conversation as ChatConversation);
    if (!assistantAvailability.available) {
      res.status(503).json({ error: assistantAvailability.error });
      return;
    }

    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration(conversation.id, abortController);
    if (!releaseGeneration) {
      res.status(409).json({ error: "A chat reply is already being generated for this conversation" });
      return;
    }

    const actor = getActorInfo(req);
    let assistantConversationForPartial: ChatConversation | null = null;
    let turnContextForPartial: ChatTurnContext | null = null;
    let chatObservation: ExecutionObservabilityContext | null = null;
    const transcript: TranscriptEntry[] = [];
    const observedTranscript: TranscriptEntry[] = [];
    let clientClosed = false;
    const handleClosed = () => {
      if (clientClosed || res.writableEnded) return;
      clientClosed = true;
    };
    req.on("aborted", handleClosed);
    res.on("close", handleClosed);

    res.status(201);
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    try {
      const userMessage = await addUserMessage(
        conversation as ChatConversation,
        parsedBody.data.body,
        actor,
        parsedBody.data.editUserMessageId ?? null,
      );
      const userAttachments = await attachFilesToUserMessage(
        conversation as ChatConversation,
        userMessage.id,
        messageFiles,
        actor,
      );
      const hydratedUserMessage = {
        ...userMessage,
        attachments: userAttachments,
      } as ChatMessage;
      turnContextForPartial = turnContextFromUserMessage(userMessage);
      chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
        surface: "chat_turn",
        rootExecutionId: turnContextForPartial.chatTurnId,
        trigger: "assistant_reply_stream",
        runtime: assistantAvailability.agentRuntimeType ?? null,
        metadata: {
          stream: true,
          userMessageId: userMessage.id,
          editUserMessageId: parsedBody.data.editUserMessageId ?? null,
          attachmentCount: userAttachments.length,
        },
      });
      const traceInputBase = {
        conversationId: conversation.id,
        body: parsedBody.data.body,
        userMessageId: userMessage.id,
      };
      let currentChatTraceInput = buildChatTraceInput(traceInputBase);
      writeStreamEvent(res, {
        type: "ack",
        userMessage: hydratedUserMessage,
      });

      await withChatObservation(
        chatObservation,
        {
          name: "chat_turn",
          asType: "agent",
          input: currentChatTraceInput,
        },
        async (observation) => {
          const assistantInput = await loadAssistantInput(conversation as ChatConversation, actor);
          assistantConversationForPartial = assistantInput.conversation;
          let finalChatOutput: string | null = null;
          let finalChatStatus: "completed" | "stopped" | "failed" = "completed";
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              abortSignal: abortController.signal,
              onInvocationMeta: async (meta) => {
                currentChatTraceInput = buildChatTraceInput(traceInputBase, meta);
                mergeChatInvocationTraceMetadata(chatObservation!, meta);
                updateExecutionObservation(observation, chatObservation!, {
                  input: currentChatTraceInput,
                });
                updateExecutionTraceIO(observation, { input: currentChatTraceInput });
              },
              onAssistantDelta: async (delta) => {
                writeStreamEvent(res, {
                  type: "assistant_delta",
                  delta,
                });
              },
              onAssistantState: async (state) => {
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "assistant_state",
                  state,
                });
              },
              onTranscriptEntry: async (entry) => {
                transcript.push(entry);
                if (clientClosed) return;
                writeStreamEvent(res, {
                  type: "transcript_entry",
                  entry,
                });
              },
              onObservedTranscriptEntry: async (entry) => {
                observedTranscript.push(entry);
              },
            });

            if (streamed.outcome === "stopped") {
              finalChatStatus = "stopped";
              finalChatOutput = streamed.partialBody;
              const stoppedMessage = await persistPartialAssistantMessage(
                assistantInput.conversation,
                streamed.partialBody,
                "stopped",
                turnContextForPartial!,
                transcript,
                streamed.replyingAgentId,
              );
              if (stoppedMessage) {
                await logChatMessagesAdded(assistantInput.conversation, [stoppedMessage], {
                  actorType: "system",
                  actorId: "chat-assistant",
                  agentId: streamed.replyingAgentId,
                });
              }
              await emitChatObservationEvent(chatObservation!, {
                name: "chat.reply.stopped",
                level: "WARNING",
                metadata: {
                  stoppedMessageId: stoppedMessage?.id ?? null,
                  transcriptEntries: transcript.length,
                  observedTranscriptEntries: observedTranscript.length,
                },
              });
              if (!clientClosed) {
                writeStreamEvent(res, {
                  type: "final",
                  messages: stoppedMessage ? [stoppedMessage] : [],
                });
                res.end();
              }
              return;
            }

            const createdMessages = await persistAssistantReply(
              assistantInput.conversation,
              actor,
              streamed.reply,
              turnContextForPartial!,
              transcript,
              streamed.replyingAgentId,
            );
            finalChatOutput = streamed.reply.body;
            await logChatMessagesAdded(assistantInput.conversation, createdMessages, {
              actorType: "system",
              actorId: "chat-assistant",
              agentId: streamed.replyingAgentId,
            });
            await emitChatObservationEvent(chatObservation!, {
              name: "chat.reply.persisted",
              metadata: {
                transcriptEntries: transcript.length,
                observedTranscriptEntries: observedTranscript.length,
                ...summarizeChatObservationMessages(createdMessages),
              },
            });
            if (!clientClosed) {
              writeStreamEvent(res, {
                type: "final",
                messages: createdMessages,
              });
              res.end();
            }
          } catch (error) {
            finalChatStatus = "failed";
            if (error instanceof ChatAssistantStreamError) {
              finalChatOutput = error.partialBody;
            }
            throw error;
          } finally {
            try {
              const transcriptStats = emitExecutionTranscriptTree({
                context: chatObservation!,
                parentObservation: observation,
                transcript: observedTranscript,
              });
              finalChatOutput = finalChatOutput ?? transcriptStats.finalOutput ?? null;
            } catch (error) {
              logger.warn(
                {
                  rootExecutionId: chatObservation!.rootExecutionId,
                  err: error instanceof Error ? error.message : String(error),
                },
                "Failed to export chat transcript tree to Langfuse",
              );
            }
            updateExecutionObservation(observation, {
              ...chatObservation!,
              status: finalChatStatus,
            }, {
              input: currentChatTraceInput,
              output: finalChatOutput,
              level: finalChatStatus === "failed" ? "ERROR" : "DEFAULT",
              statusMessage: finalChatStatus,
            });
            updateExecutionTraceIO(observation, {
              input: currentChatTraceInput,
              output: finalChatOutput,
            });
          }
        },
      );
    } catch (err) {
      const partialBody = err instanceof ChatAssistantStreamError ? err.partialBody : "";
      const failedReplyingAgentId = chatReplyingAgentId(assistantConversationForPartial);
      const failedMessage = await persistPartialAssistantMessage(
        assistantConversationForPartial ?? (conversation as ChatConversation),
        partialBody,
        "failed",
        turnContextForPartial!,
        transcript,
        failedReplyingAgentId,
      ).catch(() => null);
      if (failedMessage && assistantConversationForPartial) {
        await logChatMessagesAdded(assistantConversationForPartial, [failedMessage], {
          actorType: "system",
          actorId: "chat-assistant",
          agentId: failedReplyingAgentId,
        }).catch(() => {});
      }

      if (chatObservation) {
        await emitChatObservationEvent(chatObservation, {
          name: "chat.reply.failed",
          level: "ERROR",
          metadata: {
            failedMessageId: failedMessage?.id ?? null,
            transcriptEntries: transcript.length,
            observedTranscriptEntries: observedTranscript.length,
            error: err instanceof Error ? err.message : String(err),
          },
          statusMessage: err instanceof Error ? err.message : "chat_reply_failed",
        });
      }

      logger.warn({ err, conversationId: conversation.id }, "chat assistant stream failed");
      if (!clientClosed) {
        writeStreamEvent(res, {
          type: "error",
          error: err instanceof Error ? err.message : "Chat assistant failed to respond",
          messageId: failedMessage?.id ?? null,
        });
        res.end();
      }
    } finally {
      req.off("aborted", handleClosed);
      res.off("close", handleClosed);
      releaseGeneration();
    }
  });

  router.post("/chats/:id/messages/stream/stop", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    res.json({ stopped: cancelActiveChatGeneration(conversation.id) });
  });

  router.post("/orgs/:orgId/chats/:chatId/attachments", async (req, res) => {
    const orgId = req.params.orgId as string;
    const chatId = req.params.chatId as string;
    assertCompanyAccess(req, orgId);

    const conversation = await svc.getById(chatId);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (conversation.orgId !== orgId) {
      res.status(422).json({ error: "Chat conversation does not belong to organization" });
      return;
    }

    try {
      await runSingleFileUpload(req, res);
    } catch (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          res.status(422).json({ error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes` });
          return;
        }
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }

    const file = (req as Request & { file?: { mimetype: string; buffer: Buffer; originalname: string } }).file;
    if (!file) {
      res.status(400).json({ error: "Missing file field 'file'" });
      return;
    }
    const contentType = (file.mimetype || "").toLowerCase();
    if (!isAllowedContentType(contentType)) {
      res.status(422).json({ error: `Unsupported attachment type: ${contentType || "unknown"}` });
      return;
    }
    if (file.buffer.length <= 0) {
      res.status(422).json({ error: "Attachment is empty" });
      return;
    }

    const parsedMeta = createChatAttachmentMetadataSchema.safeParse(req.body ?? {});
    if (!parsedMeta.success) {
      res.status(400).json({ error: "Invalid attachment metadata", details: parsedMeta.error.issues });
      return;
    }

    const actor = getActorInfo(req);
    const stored = await storage.putFile({
      orgId,
      namespace: `chats/${chatId}`,
      originalFilename: file.originalname || null,
      contentType,
      body: file.buffer,
    });

    const attachment = await svc.createAttachment({
      orgId,
      conversationId: chatId,
      messageId: parsedMeta.data.messageId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: stored.originalFilename,
      createdByAgentId: actor.agentId,
      createdByUserId: actor.actorType === "user" ? actor.actorId : null,
    });

    await logActivity(db, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.attachment_added",
      entityType: "chat",
      entityId: chatId,
      details: {
        attachmentId: attachment.id,
        messageId: attachment.messageId,
        originalFilename: attachment.originalFilename,
        contentType: attachment.contentType,
      },
    });

    res.status(201).json(attachment);
  });

  router.post("/chats/:id/context-links", validate(createChatContextLinkSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    await assertContextLinksBelongToCompany(conversation.orgId, [req.body]);
    const linked = await svc.addContextLink(conversation.id, conversation.orgId, req.body);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.context_linked",
      entityType: "chat",
      entityId: conversation.id,
      details: req.body,
    });
    res.status(201).json(linked);
  });

  router.post("/chats/:id/project-context", validate(setChatProjectContextSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const projectId = req.body.projectId ?? null;
    if (projectId) {
      await assertContextLinksBelongToCompany(conversation.orgId, [{
        entityType: "project",
        entityId: projectId,
      }]);
    }

    const updated = await svc.setProjectContextLink(conversation.id, conversation.orgId, projectId);
    if (!updated) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.project_context_updated",
      entityType: "chat",
      entityId: conversation.id,
      details: { projectId },
    });
    res.json(updated);
  });

  router.post("/chats/:id/convert-to-issue", validate(convertChatToIssueSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const actor = getActorInfo(req);
    if (req.body.proposal?.goalId) {
      const goal = await goalsSvc.getById(req.body.proposal.goalId);
      if (!goal || goal.orgId !== conversation.orgId) {
        res.status(422).json({ error: "Goal must belong to the same organization" });
        return;
      }
    }
    const chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
      rootExecutionId: req.body.messageId ?? `chat-convert:${conversation.id}`,
      trigger: "convert_to_issue",
      metadata: {
        source: "chat_route",
        messageId: req.body.messageId ?? null,
      },
    });
    const result = await withChatObservation(
      chatObservation,
      {
        name: "chat:convert_to_issue",
        asType: "tool",
        input: {
          conversationId: conversation.id,
          messageId: req.body.messageId ?? null,
          proposal: req.body.proposal ?? null,
        },
      },
      async () => {
        const issue = await svc.convertToIssue(conversation.id, {
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          messageId: req.body.messageId ?? null,
          proposal: req.body.proposal ?? null,
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
        });
        await logActivity(db, {
          orgId: conversation.orgId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "chat.issue_converted",
          entityType: "chat",
          entityId: conversation.id,
          details: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            messageId: req.body.messageId ?? null,
            systemMessageId: systemMessage.id,
          },
        });
        await emitChatObservationEvent(chatObservation, {
          name: "chat.issue.created",
          metadata: {
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            systemMessageId: systemMessage.id,
          },
        });
        return { issue, systemMessage };
      },
    );
    res.status(201).json(result);
  });

  router.post(
    "/chats/:id/messages/:messageId/operation-proposal/resolve",
    validate(resolveChatOperationProposalSchema),
    async (req, res) => {
      const conversation = await assertConversationAccess(req, req.params.id as string);
      if (!conversation) {
        res.status(404).json({ error: "Chat conversation not found" });
        return;
      }

      const actor = getActorInfo(req);
      const messageId = req.params.messageId as string;
      const chatObservation = buildChatObservabilityContext(conversation as ChatConversation, {
        rootExecutionId: messageId,
        trigger: "resolve_operation_proposal",
        metadata: {
          action: req.body.action,
          decisionNote: req.body.decisionNote ?? null,
        },
      });
      const result = await withChatObservation(
        chatObservation,
        {
          name: "chat:resolve_operation_proposal",
          asType: "tool",
          input: {
            conversationId: conversation.id,
            messageId,
            action: req.body.action,
          },
        },
        async () => {
          const resolved = await svc.resolveOperationProposal(conversation.id, messageId, {
            action: req.body.action,
            actorUserId: actor.actorType === "user" ? actor.actorId : null,
            decisionNote: req.body.decisionNote ?? null,
          });
          await emitChatObservationEvent(chatObservation, {
            name: "chat.operation_proposal.resolved",
            metadata: {
              action: req.body.action,
              messageId: resolved.message.id,
              systemMessageId: resolved.systemMessage.id,
            },
          });
          return resolved;
        },
      );
      res.status(201).json(result);
    },
  );

  router.post("/chats/:id/resolve", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const resolved = await svc.resolve(conversation.id);
    const actor = getActorInfo(req);
    await logActivity(db, {
      orgId: conversation.orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "chat.resolved",
      entityType: "chat",
      entityId: conversation.id,
    });
    res.json(resolved ? await assistantSvc.enrichConversation(resolved as ChatConversation) : null);
  });

  router.post("/chats/:id/read", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    const state = await svc.markRead(conversation.id, conversation.orgId, userId);
    res.status(201).json({
      conversationId: conversation.id,
      lastReadAt: state.lastReadAt,
    });
  });

  router.post("/chats/:id/user-state", validate(updateChatConversationUserStateSchema), async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    const userId = boardUserId(req);
    if (typeof req.body.pinned === "boolean") {
      await svc.setPinned(conversation.id, conversation.orgId, userId, req.body.pinned);
    }
    const refreshed = await svc.getById(conversation.id, userId);
    res.json(await assistantSvc.enrichConversation(refreshed as ChatConversation));
  });

  return router;
}
