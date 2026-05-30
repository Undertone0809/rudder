import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import multer from "multer";
import type { LangfuseObservation } from "@langfuse/tracing";
import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  addChatMessageSchema,
  chatAutomationCreateFromStructuredPayload,
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
import { conflict, forbidden, HttpError, unauthorized, unprocessable } from "../errors.js";
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
  type ChatGeneratedAttachment,
} from "../services/chat-assistant.js";
import { cancelActiveChatGeneration, claimChatGeneration, hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import {
  accessService,
  agentService,
  automationService,
  chatService,
  operatorProfileService,
  organizationService,
  goalService,
  issueService,
  logActivity,
  projectService,
} from "../services/index.js";
import { assertTimeZone } from "../services/automations.scheduler.js";
import { validateCron } from "../services/cron.js";
import { summarizeRuntimeSkillsForTrace } from "../services/runtime-trace-metadata.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { registerChatStreamRoutes } from "./chats.stream-routes.js";

export function chatRoutes(db: Db, storage: StorageService) {
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

  function canCreateAgentsLegacy(agent: { permissions: Record<string, unknown> | null | undefined; role: string }) {
    if (agent.role === "ceo") return true;
    if (!agent.permissions || typeof agent.permissions !== "object") return false;
    return Boolean((agent.permissions as Record<string, unknown>).canCreateAgents);
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

  function modelTurnInputFromInvocationMeta(invocationMeta: AgentRuntimeInvocationMeta) {
    return typeof invocationMeta.prompt === "string" && invocationMeta.prompt.trim().length > 0
      ? invocationMeta.prompt
      : undefined;
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

  function proposedPlanDocumentPayload(structuredPayload: Record<string, unknown> | null | undefined) {
    if (!structuredPayload) return null;
    const rawDocument =
      structuredPayload.planDocument
      && typeof structuredPayload.planDocument === "object"
      && !Array.isArray(structuredPayload.planDocument)
        ? structuredPayload.planDocument
        : structuredPayload.plan && typeof structuredPayload.plan === "object" && !Array.isArray(structuredPayload.plan)
          ? structuredPayload.plan
          : null;
    return rawDocument ? rawDocument as Record<string, unknown> : null;
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
  ) {
    const createdMessages: ChatMessage[] = [];
    const { chatTurnId, turnVariant } = turnContext;
    const attachGeneratedFiles = async (message: ChatMessage, generatedAttachments: ChatGeneratedAttachment[] | undefined) => {
      if (!generatedAttachments || generatedAttachments.length === 0) return message;
      const attachments: ChatAttachment[] = [];
      for (const generated of generatedAttachments) {
        if (generated.body.length > MAX_ATTACHMENT_BYTES) {
          throw new ChatAssistantStreamError(
            `Generated attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
            assistantReply.body,
            generatedAttachments,
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
        attachments.push(attachment as ChatAttachment);
      }
      return {
        ...message,
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
        description: automationCreate.description ?? null,
        assigneeAgentId,
        priority: automationCreate.priority,
        status: automationCreate.status,
        concurrencyPolicy: automationCreate.concurrencyPolicy,
        catchUpPolicy: automationCreate.catchUpPolicy,
        outputMode: automationCreate.outputMode,
        chatConversationId: null,
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

      const planDocument = proposedPlanDocumentPayload(issueProposalStructuredPayload);
      const approval = await svc.createProposalApproval(conversation.orgId, {
        type: "chat_issue_creation",
        requestedByUserId: actor.actorType === "user" ? actor.actorId : null,
        payload: {
          chatConversationId: conversation.id,
          proposedByAgentId: replyingAgentId,
          proposedIssue: proposalPayload,
          ...(planDocument ? { planDocument } : {}),
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
  ) {
    const trimmed = body.trim();
    const fallbackBody = status === "stopped"
      ? "Chat run stopped before a final reply. Continue the conversation to resume from the preserved context."
      : "Chat run failed before a final reply. Continue the conversation to resume from the preserved context.";
    const durableBody = trimmed || (transcript.length > 0 ? fallbackBody : "");
    if (!durableBody) return null;
    const chatTurnId = turnContext?.chatTurnId ?? randomUUID();
    const turnVariant = turnContext?.turnVariant ?? 0;
    if (existingMessageId) {
      const updated = await svc.updateMessage(conversation.id, existingMessageId, {
        kind: "message",
        status,
        body: durableBody,
        transcript,
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
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const userId = req.actor.type === "board" ? (req.actor.userId ?? "local-board") : null;
    const conversations = await svc.list(orgId, { status, q }, userId);
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

  router.delete("/chats/:id", async (req, res) => {
    assertBoard(req);
    const existing = await assertConversationAccess(req, req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (hasActiveChatGeneration(existing.id)) {
      throw conflict("Cannot delete a chat while a reply is in progress");
    }

    const attachments = await svc.listAttachmentsForConversation(existing.id);
    const deleted = await svc.remove(existing.id);
    if (!deleted) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }

    for (const attachment of attachments) {
      try {
        await storage.deleteObject(attachment.orgId, attachment.objectKey);
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

  router.get("/chats/:id/messages", async (req, res) => {
    const conversation = await assertConversationAccess(req, req.params.id as string);
    if (!conversation) {
      res.status(404).json({ error: "Chat conversation not found" });
      return;
    }
    if (!hasActiveChatGeneration(conversation.id)) {
      await svc.markInterruptedStreamingMessages(conversation.id);
    }
    const includeTranscript = req.query.includeTranscript === "true";
    const messages = await svc.listMessages(conversation.id, { includeTranscript });
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
          let modelTurnInput: unknown;
          let fallbackOutput: string | null = null;
          let finalChatOutput: string | null = null;
          let finalChatStatus: "completed" | "failed" = "completed";
          try {
            const streamed = await assistantSvc.streamChatAssistantReply({
              ...assistantInput,
              onInvocationMeta: async (meta) => {
                modelTurnInput = modelTurnInputFromInvocationMeta(meta);
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
              req,
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
                initialTurnInput: modelTurnInput,
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
      if (err instanceof HttpError) {
        throw err;
      }
      res.status(502).json({
        error: err instanceof Error ? err.message : "Chat assistant failed to respond",
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
    assertConversationAccess,
    boardUserId,
    assertCanAssignTasks,
    runSingleFileUpload,
    runMessageFileUpload,
    isMultipartRequest,
    uploadedMessageFiles,
    validateUploadedMessageFiles,
    buildChatObservabilityContext,
    withChatObservation,
    emitChatObservationEvent,
    summarizeChatObservationMessages,
    modelTurnInputFromInvocationMeta,
    buildChatTraceInput,
    mergeChatInvocationTraceMetadata,
    logChatMessagesAdded,
    assertContextLinksBelongToCompany,
    turnContextFromUserMessage,
    addUserMessage,
    attachFilesToUserMessage,
    loadAssistantInput,
    chatReplyingAgentId,
    assertCanConvertIssueProposal,
    persistAssistantReply,
    attachGeneratedFilesToPartialMessage,
    persistPartialAssistantMessage,
    writeStreamEvent,
  });
  return router;
}
