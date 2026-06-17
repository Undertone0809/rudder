import type { TranscriptEntry } from "@rudderhq/agent-runtime-utils";
import type { Db } from "@rudderhq/db";
import {
  agents,
  automationRuns,
  automations,
  automationTriggers,
  chatContextLinks,
  chatConversations,
  chatMessages,
  goals,
  heartbeatRuns,
  issueFollows,
  issues,
  organizationSecrets,
  projects,
} from "@rudderhq/db";
import type {
  Automation,
  AutomationDetail,
  AutomationListItem,
  AutomationRunSummary,
  AutomationTrigger,
  AutomationTriggerSecretMaterial,
  ChatAttachment,
  ChatConversation,
  ChatMessage,
  CreateAutomation,
  CreateAutomationTrigger,
  RunAutomation,
  UpdateAutomation,
  UpdateAutomationTrigger,
} from "@rudderhq/shared";
import { chatIssueProposalFromStructuredPayload } from "@rudderhq/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import crypto from "node:crypto";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import { getStorageService } from "../storage/index.js";
import type { StorageService } from "../storage/types.js";
import { logActivity } from "./activity-log.js";
import {
  assertTimeZone,
  LIVE_HEARTBEAT_RUN_STATUSES,
  MAX_CATCH_UP_RUNS,
  nextCronTickInTimeZone,
  nextResultText,
  normalizeWebhookTimestampMs,
  OPEN_ISSUE_STATUSES
} from "./automations.scheduler.js";
import { chatAssistantService, ChatAssistantStreamError, userVisiblePartialBodyFromError, type ChatAssistantResult, type ChatGeneratedAttachment } from "./chat-assistant.js";
import { claimChatGeneration, hasActiveChatGeneration } from "./chat-generation-locks.js";
import { chatService } from "./chats.js";
import { validateCron } from "./cron.js";
import { heartbeatService } from "./heartbeat.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { issueService } from "./issues.js";
import { publishLiveEvent } from "./live-events.js";
import { secretService } from "./secrets.js";

type Actor = { agentId?: string | null; userId?: string | null };
type AutomationRow = typeof automations.$inferSelect;
type ChatAssistantService = ReturnType<typeof chatAssistantService>;
type AutomationServiceDeps = {
  heartbeat?: IssueAssignmentWakeupDeps;
  chatAssistant?: Pick<ChatAssistantService, "enrichConversation" | "streamChatAssistantReply">;
  storage?: StorageService;
  autoStartChatOutputRuns?: boolean;
};

const CHAT_OUTPUT_STALE_RUN_MS = 30 * 60 * 1000;

function toAutomation(row: AutomationRow): Automation {
  return {
    ...row,
    outputMode: row.outputMode as Automation["outputMode"],
  };
}

export function automationService(db: Db, deps: AutomationServiceDeps = {}) {
  const issueSvc = issueService(db);
  const chatSvc = chatService(db);
  const storageSvc = deps.storage ?? (deps.chatAssistant ? null : getStorageService());
  const assistantSvc = deps.chatAssistant ?? chatAssistantService(db, storageSvc ?? undefined);
  const secretsSvc = secretService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);
  const autoStartChatOutputRuns = deps.autoStartChatOutputRuns ?? true;

  async function getAutomationById(id: string) {
    return db
      .select()
      .from(automations)
      .where(eq(automations.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function getTriggerById(id: string) {
    return db
      .select()
      .from(automationTriggers)
      .where(eq(automationTriggers.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function assertAutomationAccess(orgId: string, automationId: string) {
    const automation = await getAutomationById(automationId);
    if (!automation) throw notFound("Automation not found");
    if (automation.orgId !== orgId) throw forbidden("Automation must belong to same organization");
    return automation;
  }

  async function assertAssignableAgent(orgId: string, agentId: string) {
    const agent = await db
      .select({ id: agents.id, orgId: agents.orgId, status: agents.status })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    if (!agent) throw notFound("Assignee agent not found");
    if (agent.orgId !== orgId) throw unprocessable("Assignee must belong to same organization");
    if (agent.status === "pending_approval") throw conflict("Cannot assign automations to pending approval agents");
    if (agent.status === "terminated") throw conflict("Cannot assign automations to terminated agents");
  }

  async function assertProject(orgId: string, projectId: string) {
    const project = await db
      .select({ id: projects.id, orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .then((rows) => rows[0] ?? null);
    if (!project) throw notFound("Project not found");
    if (project.orgId !== orgId) throw unprocessable("Project must belong to same organization");
  }

  async function assertGoal(orgId: string, goalId: string) {
    const goal = await db
      .select({ id: goals.id, orgId: goals.orgId })
      .from(goals)
      .where(eq(goals.id, goalId))
      .then((rows) => rows[0] ?? null);
    if (!goal) throw notFound("Goal not found");
    if (goal.orgId !== orgId) throw unprocessable("Goal must belong to same organization");
  }

  async function assertParentIssue(orgId: string, issueId: string) {
    const parentIssue = await db
      .select({ id: issues.id, orgId: issues.orgId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    if (!parentIssue) throw notFound("Parent issue not found");
    if (parentIssue.orgId !== orgId) throw unprocessable("Parent issue must belong to same organization");
  }

  async function followAutomationIssueForNotification(input: {
    automation: AutomationRow;
    issueId: string;
    executor: Db;
  }) {
    if (input.automation.outputMode !== "track_issue" || !input.automation.notifyOnIssueCreated) return;
    const userId = input.automation.notifyOnIssueCreatedUserId;
    if (!userId) return;
    await input.executor
      .insert(issueFollows)
      .values({
        orgId: input.automation.orgId,
        issueId: input.issueId,
        userId,
      })
      .onConflictDoUpdate({
        target: [issueFollows.orgId, issueFollows.issueId, issueFollows.userId],
        set: { createdAt: new Date() },
      });
  }

  function assertChatOutputDestination(input: {
    outputMode: string;
    chatConversationId: string | null | undefined;
    existingChatConversationId?: string | null;
    isCreate?: boolean;
  }) {
    if (input.outputMode !== "chat_output" || !input.chatConversationId) return;
    if (!input.isCreate && input.chatConversationId === input.existingChatConversationId) {
      return;
    }
    throw unprocessable("Chat output creates an automation-owned conversation; existing chats cannot be selected");
  }

  function normalizeCreateNotification(input: CreateAutomation, actor: Actor) {
    const enabled = input.outputMode === "track_issue" && input.notifyOnIssueCreated && Boolean(actor.userId);
    return {
      enabled,
      userId: enabled ? actor.userId! : null,
    };
  }

  function normalizeUpdateNotification(input: {
    existing: AutomationRow;
    patch: UpdateAutomation;
    actor: Actor;
    nextOutputMode: string;
  }) {
    if (input.nextOutputMode !== "track_issue") {
      return { enabled: false, userId: null };
    }
    const enabled = input.patch.notifyOnIssueCreated ?? input.existing.notifyOnIssueCreated;
    if (!enabled) {
      return { enabled: false, userId: null };
    }
    if (input.patch.notifyOnIssueCreated === true) {
      const userId = input.actor.userId ?? input.existing.notifyOnIssueCreatedUserId;
      return { enabled: Boolean(userId), userId: userId ?? null };
    }
    const userId = input.existing.notifyOnIssueCreatedUserId;
    return { enabled: Boolean(userId), userId: userId ?? null };
  }

  async function resolveAutomationRunChatConversationId(input: {
    automation: typeof automations.$inferSelect;
    runId: string;
    executor: Db;
  }) {
    if (input.automation.outputMode !== "chat_output") return null;
    const existingRun = await input.executor
      .select({ linkedChatConversationId: automationRuns.linkedChatConversationId })
      .from(automationRuns)
      .where(eq(automationRuns.id, input.runId))
      .then((rows) => rows[0] ?? null);
    if (existingRun?.linkedChatConversationId) return existingRun.linkedChatConversationId;

    const [conversation] = await input.executor
      .insert(chatConversations)
      .values({
        orgId: input.automation.orgId,
        title: input.automation.title || "New chat",
        preferredAgentId: input.automation.assigneeAgentId,
        status: "active",
        issueCreationMode: "manual_approval",
        planMode: false,
      })
      .returning({ id: chatConversations.id });
    if (!conversation) return null;
    if (input.automation.projectId) {
      await input.executor
        .insert(chatContextLinks)
        .values({
          orgId: input.automation.orgId,
          conversationId: conversation.id,
          entityType: "project",
          entityId: input.automation.projectId,
          metadata: null,
        })
        .onConflictDoNothing();
    }

    await input.executor
      .update(automationRuns)
      .set({
        linkedChatConversationId: conversation.id,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, input.runId));
    return conversation.id;
  }

  function automationChatPrompt(input: {
    automation: typeof automations.$inferSelect;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
  }) {
    const base = input.automation.description?.trim() || input.automation.title.trim();
    const context: string[] = [
      `Automation: ${input.automation.title}`,
      `Trigger source: ${input.source}`,
    ];
    if (input.payload && Object.keys(input.payload).length > 0) {
      context.push(`Trigger payload: ${JSON.stringify(input.payload)}`);
    }
    return `${base}\n\n${context.join("\n")}`.trim();
  }

  function notifyChatChanged(orgId: string, conversationId: string, details?: Record<string, unknown>) {
    publishLiveEvent({
      orgId,
      type: "activity.logged",
      payload: {
        actorType: "system",
        actorId: "automation-chat-output",
        action: "chat.message_updated",
        entityType: "chat",
        entityId: conversationId,
        agentId: null,
        runId: null,
        details: details ?? null,
      },
    });
  }

  async function logChatMessageAdded(input: {
    orgId: string;
    conversationId: string;
    message: ChatMessage;
    agentId?: string | null;
  }) {
    await logActivity(db, {
      orgId: input.orgId,
      actorType: "system",
      actorId: "automation-chat-output",
      agentId: input.agentId ?? null,
      action: "chat.message_added",
      entityType: "chat",
      entityId: input.conversationId,
      details: {
        messageId: input.message.id,
        role: input.message.role,
        kind: input.message.kind,
        status: input.message.status,
        source: "automation_chat_output",
      },
    });
  }

  function automationChatRunMetadata(automation: typeof automations.$inferSelect, run: typeof automationRuns.$inferSelect, conversationId: string) {
    return {
      automationId: automation.id,
      automationTitle: automation.title,
      runId: run.id,
      links: {
        automation: `/automations/${automation.id}`,
        chat: `/messenger/chat/${conversationId}`,
      },
    };
  }

  function automationChatRunInputPayload(
    automation: typeof automations.$inferSelect,
    run: typeof automationRuns.$inferSelect,
    source: "schedule" | "manual" | "api" | "webhook",
  ) {
    return {
      eventType: "automation_run_input",
      automationChatRun: {
        ...automationChatRunMetadata(automation, run, run.linkedChatConversationId ?? ""),
        status: "running",
        source,
        triggerId: run.triggerId,
      },
      guidance: {
        intent: "execute_existing_automation",
        mayCreateAutomation: false,
      },
    };
  }

  async function attachGeneratedFiles(input: {
    conversation: ChatConversation;
    message: ChatMessage | null;
    generatedAttachments?: ChatGeneratedAttachment[];
    replyingAgentId?: string | null;
  }) {
    if (!input.message || !input.generatedAttachments || input.generatedAttachments.length === 0) {
      return input.message;
    }
    const attachments: ChatAttachment[] = [];
    for (const generated of input.generatedAttachments) {
      if (generated.body.length > MAX_ATTACHMENT_BYTES) {
        throw new ChatAssistantStreamError(
          `Generated attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
          input.message.body,
          input.generatedAttachments,
          { partialBodyUserVisible: true },
        );
      }
      const stored = await (storageSvc ?? getStorageService()).putFile({
        orgId: input.conversation.orgId,
        namespace: `chats/${input.conversation.id}/generated`,
        originalFilename: generated.originalFilename,
        contentType: generated.contentType,
        body: generated.body,
      });
      const attachment = await chatSvc.createAttachment({
        orgId: input.conversation.orgId,
        conversationId: input.conversation.id,
        messageId: input.message.id,
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: input.replyingAgentId ?? null,
        createdByUserId: null,
      });
      attachments.push(attachment as ChatAttachment);
    }
    return {
      ...input.message,
      attachments: [...(input.message.attachments ?? []), ...attachments],
    } as ChatMessage;
  }

  async function automationAssistantReplyPersistence(input: {
    conversation: ChatConversation;
    automation: typeof automations.$inferSelect;
    run: typeof automationRuns.$inferSelect;
    reply: ChatAssistantResult;
  }) {
    if (input.reply.kind === "issue_proposal") {
      const proposal = chatIssueProposalFromStructuredPayload(input.reply.structuredPayload);
      const approval = await chatSvc.createProposalApproval(input.conversation.orgId, {
        type: "chat_issue_creation",
        requestedByUserId: null,
        payload: {
          chatConversationId: input.conversation.id,
          proposedByAgentId: input.reply.replyingAgentId ?? input.conversation.preferredAgentId ?? null,
          proposedIssue: proposal,
        },
      });
      return {
        kind: "issue_proposal" as const,
        approvalId: approval.id,
        structuredPayload: input.reply.structuredPayload,
      };
    }

    if (input.reply.kind === "operation_proposal") {
      const approval = await chatSvc.createProposalApproval(input.conversation.orgId, {
        type: "chat_operation",
        requestedByUserId: null,
        payload: {
          chatConversationId: input.conversation.id,
          operationProposal:
            input.reply.structuredPayload &&
            typeof input.reply.structuredPayload.operationProposal === "object" &&
            input.reply.structuredPayload.operationProposal !== null
              ? input.reply.structuredPayload.operationProposal as Record<string, unknown>
              : input.reply.structuredPayload ?? {},
        },
      });
      return {
        kind: "operation_proposal" as const,
        approvalId: approval.id,
        structuredPayload: {
          ...(input.reply.structuredPayload ?? {}),
          operationProposalState: {
            status: "pending",
            decisionNote: null,
            decidedByUserId: null,
            decidedAt: null,
          },
        },
      };
    }

    if (input.reply.kind === "ask_user") {
      return {
        kind: "ask_user" as const,
        approvalId: null,
        structuredPayload: input.reply.structuredPayload,
      };
    }

    return {
      kind: "message" as const,
      approvalId: null,
      structuredPayload: input.reply.structuredPayload,
    };
  }

  async function expireStaleChatOutputRuns(
    automation: typeof automations.$inferSelect,
    runId: string,
    executor: Db = db,
  ) {
    const staleBefore = new Date(Date.now() - CHAT_OUTPUT_STALE_RUN_MS);
    const staleRuns = await executor
      .select({
        id: automationRuns.id,
        linkedChatConversationId: automationRuns.linkedChatConversationId,
      })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.orgId, automation.orgId),
          eq(automationRuns.automationId, automation.id),
          ne(automationRuns.id, runId),
          inArray(automationRuns.status, ["received", "running"]),
          lte(automationRuns.updatedAt, staleBefore),
        ),
      );

    for (const staleRun of staleRuns) {
      if (staleRun.linkedChatConversationId && hasActiveChatGeneration(staleRun.linkedChatConversationId)) {
        continue;
      }
      await executor
        .update(automationRuns)
        .set({
          status: "failed",
          failureReason: "Automation chat run was interrupted before completion",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(automationRuns.id, staleRun.id));
    }
  }

  async function findLiveChatOutputRun(
    automation: typeof automations.$inferSelect,
    runId: string,
    executor: Db = db,
  ) {
    await expireStaleChatOutputRuns(automation, runId, executor);
    return executor
      .select()
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.orgId, automation.orgId),
          eq(automationRuns.automationId, automation.id),
          ne(automationRuns.id, runId),
          inArray(automationRuns.status, ["received", "running"]),
        ),
      )
      .orderBy(desc(automationRuns.updatedAt), desc(automationRuns.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function loadAutomationChatAssistantInput(conversationId: string) {
    const conversation = await chatSvc.getById(conversationId);
    if (!conversation) throw notFound("Automation chat conversation not found");
    const enriched = await assistantSvc.enrichConversation(conversation as ChatConversation);
    const messages = (await chatSvc.listMessages(conversationId)).filter((message) => !message.supersededAt) as ChatMessage[];
    const issueLabels = await issueSvc.listLabels(conversation.orgId);
    return {
      conversation: enriched as ChatConversation,
      messages,
      contextLinks: (enriched.contextLinks ?? []) as ChatConversation["contextLinks"],
      issueLabels,
      operatorProfile: null,
    };
  }

  async function executeChatOutputAutomationRun(runId: string) {
    const run = await getAutomationRunById(runId);
    if (!run || run.status !== "running" || !run.linkedChatConversationId) return;
    const automation = await getAutomationById(run.automationId);
    if (!automation || automation.outputMode !== "chat_output") return;

    const conversation = await chatSvc.getById(run.linkedChatConversationId);
    if (!conversation) {
      await finalizeRun(run.id, {
        status: "failed",
        failureReason: "Automation chat conversation not found",
        completedAt: new Date(),
      });
      return;
    }

    const abortController = new AbortController();
    const releaseGeneration = claimChatGeneration(conversation.id, abortController);
    if (!releaseGeneration) {
      await finalizeRun(run.id, {
        status: "failed",
        failureReason: "A chat reply is already being generated for this conversation",
        completedAt: new Date(),
      });
      return;
    }

    const transcript: TranscriptEntry[] = [];
    let assistantDraftBody = "";
    let assistantProgressMessage: ChatMessage | null = null;
    let assistantProgressMessageId: string | null = null;
    let userMessage: ChatMessage | null = null;
    let lastRunProgressTouchMs = 0;

    const touchRunChatProgress = async (messageId: string | null) => {
      const nowMs = Date.now();
      if (nowMs - lastRunProgressTouchMs < 15_000) return;
      lastRunProgressTouchMs = nowMs;
      await db
        .update(automationRuns)
        .set({
          lastChatMessageId: messageId,
          updatedAt: new Date(nowMs),
        })
        .where(eq(automationRuns.id, run.id));
    };

    const persistProgress = async (
      progressConversation: ChatConversation,
      status: "streaming" | "completed" | "failed" | "stopped" = "streaming",
      body = assistantDraftBody,
      replyingAgentId = progressConversation.chatRuntime?.runtimeAgentId ?? progressConversation.preferredAgentId ?? null,
      structuredPayload: Record<string, unknown> | null = null,
      kind: "message" | "ask_user" | "issue_proposal" | "operation_proposal" = "message",
      approvalId: string | null = null,
    ) => {
      if (!userMessage?.chatTurnId) return null;
      const input = {
        kind,
        status,
        body,
        transcript,
        structuredPayload,
        approvalId,
        replyingAgentId,
      };
      if (assistantProgressMessage) {
        const updated = await chatSvc.updateMessage(progressConversation.id, assistantProgressMessage.id, input);
        if (updated) {
          assistantProgressMessage = updated as ChatMessage;
          assistantProgressMessageId = assistantProgressMessage.id;
          notifyChatChanged(progressConversation.orgId, progressConversation.id, {
            messageId: assistantProgressMessage.id,
            status,
          });
          await touchRunChatProgress(assistantProgressMessage.id);
          return assistantProgressMessage;
        }
      }
      assistantProgressMessage = await chatSvc.addMessage(progressConversation.id, {
        orgId: progressConversation.orgId,
        role: "assistant",
        kind,
        status,
        body,
        transcript,
        structuredPayload,
        approvalId,
        replyingAgentId,
        chatTurnId: userMessage.chatTurnId,
        turnVariant: userMessage.turnVariant,
      }) as ChatMessage;
      assistantProgressMessageId = assistantProgressMessage.id;
      await logChatMessageAdded({
        orgId: progressConversation.orgId,
        conversationId: progressConversation.id,
        message: assistantProgressMessage,
        agentId: replyingAgentId,
      });
      await touchRunChatProgress(assistantProgressMessage.id);
      return assistantProgressMessage;
    };

    try {
      const prompt = automationChatPrompt({
        automation,
        source: run.source as "schedule" | "manual" | "api" | "webhook",
        payload: run.triggerPayload,
      });
      const source = run.source as "schedule" | "manual" | "api" | "webhook";
      userMessage = await chatSvc.addUserChatMessage(
        conversation.id,
        conversation.orgId,
        prompt,
        null,
        { structuredPayload: automationChatRunInputPayload(automation, run, source) },
      ) as ChatMessage;
      await logChatMessageAdded({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        message: userMessage,
      });
      await finalizeRun(run.id, {
        startedChatMessageId: userMessage.id,
        lastChatMessageId: userMessage.id,
      });

      const assistantInput = await loadAutomationChatAssistantInput(conversation.id);
      const streamed = await assistantSvc.streamChatAssistantReply({
        ...assistantInput,
        abortSignal: abortController.signal,
        onAssistantDelta: async (delta: string) => {
          assistantDraftBody = `${assistantDraftBody}${delta}`;
          await persistProgress(assistantInput.conversation);
        },
        onAssistantState: async () => {
          await persistProgress(assistantInput.conversation);
        },
        onTranscriptEntry: async (entry: TranscriptEntry) => {
          transcript.push(entry);
          await persistProgress(assistantInput.conversation);
        },
      });

      const finalStatus = streamed.outcome === "stopped" ? "stopped" : "completed";
      const finalBody = streamed.outcome === "stopped" ? streamed.partialBody : streamed.reply.body;
      const finalReplyPersistence = streamed.outcome === "completed"
        ? await automationAssistantReplyPersistence({
          conversation: assistantInput.conversation,
          automation,
          run,
          reply: streamed.reply,
        })
        : {
          kind: "message" as const,
          approvalId: null,
          structuredPayload: null,
        };
      const finalMessage = await persistProgress(
        assistantInput.conversation,
        finalStatus,
        finalBody,
        streamed.replyingAgentId,
        {
          ...(finalReplyPersistence.structuredPayload ?? {}),
          automationChatRun: {
            ...automationChatRunMetadata(automation, run, conversation.id),
            status: streamed.outcome,
          },
        },
        finalReplyPersistence.kind,
        finalReplyPersistence.approvalId,
      );
      const finalMessageWithAttachments = streamed.outcome === "completed"
        ? await attachGeneratedFiles({
          conversation: assistantInput.conversation,
          message: finalMessage,
          generatedAttachments: streamed.reply.generatedAttachments,
          replyingAgentId: streamed.replyingAgentId,
        })
        : finalMessage;
      await finalizeRun(run.id, {
        status: finalStatus === "completed" ? "completed" : "failed",
        terminalChatMessageId: finalMessageWithAttachments?.id ?? assistantProgressMessageId,
        lastChatMessageId: finalMessageWithAttachments?.id ?? assistantProgressMessageId ?? userMessage.id,
        completedAt: new Date(),
      });
    } catch (error) {
      const partialBody = userVisiblePartialBodyFromError(error);
      const failureReason = error instanceof Error ? error.message : String(error);
      const fallbackBody = partialBody.trim() || "Automation chat run failed before it produced a final response.";
      const latestConversation = await chatSvc.getById(conversation.id);
      const failedMessage = await persistProgress(
        (latestConversation ?? conversation) as ChatConversation,
        "failed",
        fallbackBody,
        automation.assigneeAgentId,
        {
          eventType: "automation_chat_run_result",
          automationId: automation.id,
          automationTitle: automation.title,
          runId: run.id,
          status: "failed",
          failureReason,
          links: {
            automation: `/automations/${automation.id}`,
            chat: `/messenger/chat/${conversation.id}`,
          },
        },
      );
      await finalizeRun(run.id, {
        status: "failed",
        failureReason,
        terminalChatMessageId: failedMessage?.id ?? assistantProgressMessageId,
        lastChatMessageId: failedMessage?.id ?? assistantProgressMessageId ?? userMessage?.id ?? null,
        completedAt: new Date(),
      });
      logger.warn({ err: error, automationId: automation.id, runId: run.id }, "automation chat output run failed");
    } finally {
      releaseGeneration();
      notifyChatChanged(conversation.orgId, conversation.id, {
        automationId: automation.id,
        runId: run.id,
      });
    }
  }

  async function listTriggersForAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationTrigger[]>();
    const rows = await db
      .select()
      .from(automationTriggers)
      .where(and(eq(automationTriggers.orgId, orgId), inArray(automationTriggers.automationId, automationIds)))
      .orderBy(asc(automationTriggers.createdAt), asc(automationTriggers.id));
    const map = new Map<string, AutomationTrigger[]>();
    for (const row of rows) {
      const list = map.get(row.automationId) ?? [];
      list.push(row);
      map.set(row.automationId, list);
    }
    return map;
  }

  function linkedChatConversationFromRow(row: {
    linkedChatConversationId: string | null;
    chatTitle: string | null;
    chatStatus: string | null;
    chatPreferredAgentId: string | null;
    chatLastMessageAt: Date | null;
  }) {
    return row.linkedChatConversationId
      ? {
        id: row.linkedChatConversationId,
        title: row.chatTitle ?? "Chat",
        status: row.chatStatus ?? "active",
        preferredAgentId: row.chatPreferredAgentId,
        lastMessageAt: row.chatLastMessageAt,
      }
      : null;
  }

  async function listLatestRunByAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationRunSummary>();
    const rows = await db
      .selectDistinctOn([automationRuns.automationId], {
        id: automationRuns.id,
        orgId: automationRuns.orgId,
        automationId: automationRuns.automationId,
        triggerId: automationRuns.triggerId,
        source: automationRuns.source,
        status: automationRuns.status,
        triggeredAt: automationRuns.triggeredAt,
        idempotencyKey: automationRuns.idempotencyKey,
        triggerPayload: automationRuns.triggerPayload,
        linkedIssueId: automationRuns.linkedIssueId,
        linkedChatConversationId: automationRuns.linkedChatConversationId,
        startedChatMessageId: automationRuns.startedChatMessageId,
        terminalChatMessageId: automationRuns.terminalChatMessageId,
        lastChatMessageId: automationRuns.lastChatMessageId,
        coalescedIntoRunId: automationRuns.coalescedIntoRunId,
        failureReason: automationRuns.failureReason,
        completedAt: automationRuns.completedAt,
        createdAt: automationRuns.createdAt,
        updatedAt: automationRuns.updatedAt,
        triggerKind: automationTriggers.kind,
        triggerLabel: automationTriggers.label,
        issueIdentifier: issues.identifier,
        issueTitle: issues.title,
        issueStatus: issues.status,
        issuePriority: issues.priority,
        issueUpdatedAt: issues.updatedAt,
        chatTitle: chatConversations.title,
        chatStatus: chatConversations.status,
        chatPreferredAgentId: chatConversations.preferredAgentId,
        chatLastMessageAt: chatConversations.lastMessageAt,
      })
      .from(automationRuns)
      .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
      .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
      .leftJoin(chatConversations, eq(automationRuns.linkedChatConversationId, chatConversations.id))
      .where(and(eq(automationRuns.orgId, orgId), inArray(automationRuns.automationId, automationIds)))
      .orderBy(automationRuns.automationId, desc(automationRuns.createdAt), desc(automationRuns.id));

    const map = new Map<string, AutomationRunSummary>();
    for (const row of rows) {
      map.set(row.automationId, {
        id: row.id,
        orgId: row.orgId,
        automationId: row.automationId,
        triggerId: row.triggerId,
        source: row.source as AutomationRunSummary["source"],
        status: row.status as AutomationRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        linkedChatConversationId: row.linkedChatConversationId,
        startedChatMessageId: row.startedChatMessageId,
        terminalChatMessageId: row.terminalChatMessageId,
        lastChatMessageId: row.lastChatMessageId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Automation execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        linkedChatConversation: linkedChatConversationFromRow(row),
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      });
    }
    return map;
  }

  async function listLiveIssueByAutomationIds(orgId: string, automationIds: string[]) {
    if (automationIds.length === 0) return new Map<string, AutomationListItem["activeIssue"]>();
    const executionBoundRows = await db
      .selectDistinctOn([issues.originId], {
        originId: issues.originId,
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        updatedAt: issues.updatedAt,
      })
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.orgId, orgId),
          eq(issues.originKind, "automation_execution"),
          inArray(issues.originId, automationIds),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

    const rowsByOriginId = new Map<string, (typeof executionBoundRows)[number]>();
    for (const row of executionBoundRows) {
      if (!row.originId) continue;
      rowsByOriginId.set(row.originId, row);
    }

    const missingAutomationIds = automationIds.filter((automationId) => !rowsByOriginId.has(automationId));
    if (missingAutomationIds.length > 0) {
      const legacyRows = await db
        .selectDistinctOn([issues.originId], {
          originId: issues.originId,
          id: issues.id,
          identifier: issues.identifier,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .innerJoin(
          heartbeatRuns,
          and(
            eq(heartbeatRuns.orgId, issues.orgId),
            inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
          ),
        )
        .where(
          and(
            eq(issues.orgId, orgId),
            eq(issues.originKind, "automation_execution"),
            inArray(issues.originId, missingAutomationIds),
            inArray(issues.status, OPEN_ISSUE_STATUSES),
            isNull(issues.hiddenAt),
          ),
        )
        .orderBy(issues.originId, desc(issues.updatedAt), desc(issues.createdAt));

      for (const row of legacyRows) {
        if (!row.originId) continue;
        rowsByOriginId.set(row.originId, row);
      }
    }

    const map = new Map<string, AutomationListItem["activeIssue"]>();
    for (const row of rowsByOriginId.values()) {
      if (!row.originId) continue;
      map.set(row.originId, {
        id: row.id,
        identifier: row.identifier,
        title: row.title,
        status: row.status,
        priority: row.priority,
        updatedAt: row.updatedAt,
      });
    }
    return map;
  }

  async function updateAutomationTouchedState(input: {
    automationId: string;
    triggerId?: string | null;
    triggeredAt: Date;
    status: string;
    issueId?: string | null;
    nextRunAt?: Date | null;
  }, executor: Db = db) {
    await executor
      .update(automations)
      .set({
        lastTriggeredAt: input.triggeredAt,
        lastEnqueuedAt: input.issueId ? input.triggeredAt : undefined,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, input.automationId));

    if (input.triggerId) {
      await executor
        .update(automationTriggers)
        .set({
          lastFiredAt: input.triggeredAt,
          lastResult: nextResultText(input.status, input.issueId),
          nextRunAt: input.nextRunAt === undefined ? undefined : input.nextRunAt,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, input.triggerId));
    }
  }

  async function findLiveExecutionIssue(automation: typeof automations.$inferSelect, executor: Db = db) {
    const executionBoundIssue = await executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.id, issues.executionRunId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
        ),
      )
      .where(
        and(
          eq(issues.orgId, automation.orgId),
          eq(issues.originKind, "automation_execution"),
          eq(issues.originId, automation.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
    if (executionBoundIssue) return executionBoundIssue;

    return executor
      .select()
      .from(issues)
      .innerJoin(
        heartbeatRuns,
        and(
          eq(heartbeatRuns.orgId, issues.orgId),
          inArray(heartbeatRuns.status, LIVE_HEARTBEAT_RUN_STATUSES),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = cast(${issues.id} as text)`,
        ),
      )
      .where(
        and(
          eq(issues.orgId, automation.orgId),
          eq(issues.originKind, "automation_execution"),
          eq(issues.originId, automation.id),
          inArray(issues.status, OPEN_ISSUE_STATUSES),
          isNull(issues.hiddenAt),
        ),
      )
      .orderBy(desc(issues.updatedAt), desc(issues.createdAt))
      .limit(1)
      .then((rows) => rows[0]?.issues ?? null);
  }

  async function finalizeRun(runId: string, patch: Partial<typeof automationRuns.$inferInsert>, executor: Db = db) {
    return executor
      .update(automationRuns)
      .set({
        ...patch,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, runId))
      .returning()
      .then((rows) => rows[0] ?? null);
  }

  async function getAutomationRunById(runId: string, executor: Db = db) {
    return executor
      .select()
      .from(automationRuns)
      .where(eq(automationRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  function automationRunEventBody(input: {
    title: string;
    status: string;
    issueId?: string | null;
    failureReason?: string | null;
  }) {
    if (input.status === "issue_created") return `From automation ${input.title}.`;
    if (input.status === "completed") return `${input.title} completed.`;
    if (input.status === "coalesced") return `${input.title} coalesced into an active automation run.`;
    if (input.status === "skipped") return `${input.title} skipped because an active automation run already exists.`;
    if (input.status === "failed") {
      return input.failureReason ? `${input.title} failed: ${input.failureReason}` : `${input.title} failed.`;
    }
    return `${input.title} updated: ${input.status}.`;
  }

  async function postAutomationRunChatEvent(input: {
    automation: typeof automations.$inferSelect;
    runId: string;
    status: string;
    source: string;
    triggerId?: string | null;
    issueId?: string | null;
    failureReason?: string | null;
    terminal?: boolean;
    executor?: Db;
  }) {
    if (input.automation.outputMode !== "chat_output") return null;
    const executor = input.executor ?? db;
    if (input.status === "coalesced" || input.status === "skipped") {
      const existingRun = await executor
        .select({ linkedChatConversationId: automationRuns.linkedChatConversationId })
        .from(automationRuns)
        .where(eq(automationRuns.id, input.runId))
        .then((rows) => rows[0] ?? null);
      if (!existingRun?.linkedChatConversationId) return null;
    }
    if (input.status === "completed") return null;
    const conversationId = await resolveAutomationRunChatConversationId({
      automation: input.automation,
      runId: input.runId,
      executor,
    });
    if (!conversationId) return null;
    const now = new Date();
    const eventType =
      input.status === "issue_created" ? "automation_source"
      : input.status === "completed" ? "automation_run_completed"
      : input.status === "failed" ? "automation_run_failed"
      : input.status === "skipped" ? "automation_run_skipped"
      : input.status === "coalesced" ? "automation_run_coalesced"
      : "automation_run_updated";
    const [message] = await executor
      .insert(chatMessages)
      .values({
        orgId: input.automation.orgId,
        conversationId,
        role: "system",
        kind: "system_event",
        status: "completed",
        body: automationRunEventBody({
          title: input.automation.title,
          status: input.status,
          issueId: input.issueId,
          failureReason: input.failureReason,
        }),
        structuredPayload: {
          eventType,
          automationId: input.automation.id,
          automationTitle: input.automation.title,
          runId: input.runId,
          issueId: input.issueId ?? null,
          triggerId: input.triggerId ?? null,
          source: input.source,
          status: input.status,
          failureReason: input.failureReason ?? null,
          occurredAt: now.toISOString(),
          links: {
            automation: `/automations/${input.automation.id}`,
            issue: input.issueId ? `/issues/${input.issueId}` : null,
          },
        },
      })
      .returning();
    if (!message) return null;
    await executor
      .update(chatConversations)
      .set({ lastMessageAt: message.createdAt, updatedAt: message.createdAt })
      .where(eq(chatConversations.id, conversationId));
    await executor
      .update(automationRuns)
      .set({
        linkedChatConversationId: conversationId,
        startedChatMessageId: input.status === "issue_created" ? message.id : undefined,
        terminalChatMessageId: input.terminal ? message.id : undefined,
        lastChatMessageId: message.id,
        updatedAt: new Date(),
      })
      .where(eq(automationRuns.id, input.runId));
    return message;
  }

  async function createWebhookSecret(
    orgId: string,
    automationId: string,
    actor: Actor,
  ) {
    const secretValue = crypto.randomBytes(24).toString("hex");
    const secret = await secretsSvc.create(
      orgId,
      {
        name: `automation-${automationId}-${crypto.randomBytes(6).toString("hex")}`,
        provider: "local_encrypted",
        value: secretValue,
        description: `Webhook auth for automation ${automationId}`,
      },
      actor,
    );
    return { secret, secretValue };
  }

  async function resolveTriggerSecret(trigger: typeof automationTriggers.$inferSelect, orgId: string) {
    if (!trigger.secretId) throw notFound("Automation trigger secret not found");
    const secret = await db
      .select()
      .from(organizationSecrets)
      .where(eq(organizationSecrets.id, trigger.secretId))
      .then((rows) => rows[0] ?? null);
    if (!secret || secret.orgId !== orgId) throw notFound("Automation trigger secret not found");
    const value = await secretsSvc.resolveSecretValue(orgId, trigger.secretId, "latest");
    return value;
  }

  async function dispatchAutomationRun(input: {
    automation: typeof automations.$inferSelect;
    trigger: typeof automationTriggers.$inferSelect | null;
    source: "schedule" | "manual" | "api" | "webhook";
    payload?: Record<string, unknown> | null;
    idempotencyKey?: string | null;
  }) {
    const run = await db.transaction(async (tx) => {
      const txDb = tx as unknown as Db;
      await tx.execute(
        sql`select id from ${automations} where ${automations.id} = ${input.automation.id} and ${automations.orgId} = ${input.automation.orgId} for update`,
      );

      if (input.idempotencyKey) {
        const existing = await txDb
          .select()
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.orgId, input.automation.orgId),
              eq(automationRuns.automationId, input.automation.id),
              eq(automationRuns.source, input.source),
              eq(automationRuns.idempotencyKey, input.idempotencyKey),
              input.trigger ? eq(automationRuns.triggerId, input.trigger.id) : isNull(automationRuns.triggerId),
            ),
          )
          .orderBy(desc(automationRuns.createdAt))
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (existing) return existing;
      }

      const triggeredAt = new Date();
      const [createdRun] = await txDb
        .insert(automationRuns)
        .values({
          orgId: input.automation.orgId,
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          source: input.source,
          status: "received",
          triggeredAt,
          idempotencyKey: input.idempotencyKey ?? null,
          triggerPayload: input.payload ?? null,
          linkedChatConversationId: null,
        })
        .returning();

      const nextRunAt = input.trigger?.kind === "schedule" && input.trigger.cronExpression && input.trigger.timezone
        ? nextCronTickInTimeZone(input.trigger.cronExpression, input.trigger.timezone, triggeredAt)
        : undefined;

      let createdIssue: Awaited<ReturnType<typeof issueSvc.create>> | null = null;
      try {
        if (input.automation.outputMode === "chat_output") {
          const activeRun = await findLiveChatOutputRun(input.automation, createdRun.id, txDb);
          if (activeRun && input.automation.concurrencyPolicy !== "always_enqueue") {
            const status = input.automation.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
            const updated = await finalizeRun(createdRun.id, {
              status,
              linkedChatConversationId: activeRun.linkedChatConversationId,
              coalescedIntoRunId: activeRun.id,
              completedAt: triggeredAt,
            }, txDb);
            await updateAutomationTouchedState({
              automationId: input.automation.id,
              triggerId: input.trigger?.id ?? null,
              triggeredAt,
              status,
              nextRunAt,
            }, txDb);
            return await getAutomationRunById(createdRun.id, txDb) ?? updated ?? createdRun;
          }

          const conversationId = await resolveAutomationRunChatConversationId({
            automation: input.automation,
            runId: createdRun.id,
            executor: txDb,
          });
          if (!conversationId) {
            throw new Error("Failed to create automation chat conversation");
          }
          const updated = await finalizeRun(createdRun.id, {
            status: "running",
            linkedChatConversationId: conversationId,
          }, txDb);
          await updateAutomationTouchedState({
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status: "running",
            nextRunAt,
          }, txDb);
          return await getAutomationRunById(createdRun.id, txDb) ?? updated ?? createdRun;
        }

        const activeIssue = await findLiveExecutionIssue(input.automation, txDb);
        if (activeIssue && input.automation.concurrencyPolicy !== "always_enqueue") {
          const status = input.automation.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: activeIssue.id,
            coalescedIntoRunId: activeIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateAutomationTouchedState({
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: activeIssue.id,
            nextRunAt,
          }, txDb);
          await postAutomationRunChatEvent({
            automation: input.automation,
            runId: createdRun.id,
            status,
            source: input.source,
            triggerId: input.trigger?.id ?? null,
            issueId: activeIssue.id,
            terminal: true,
            executor: txDb,
          });
          return await getAutomationRunById(createdRun.id, txDb) ?? updated ?? createdRun;
        }

        try {
          createdIssue = await issueSvc.create(input.automation.orgId, {
            projectId: input.automation.projectId ?? null,
            goalId: input.automation.goalId,
            parentId: input.automation.parentIssueId,
            title: input.automation.title,
            description: input.automation.description,
            status: "todo",
            priority: input.automation.priority,
            assigneeAgentId: input.automation.assigneeAgentId,
            originKind: "automation_execution",
            originId: input.automation.id,
            originRunId: createdRun.id,
          });
        } catch (error) {
          const isOpenExecutionConflict =
            !!error &&
            typeof error === "object" &&
            "code" in error &&
            (error as { code?: string }).code === "23505" &&
            "constraint" in error &&
            (error as { constraint?: string }).constraint === "issues_open_automation_execution_uq";
          if (!isOpenExecutionConflict || input.automation.concurrencyPolicy === "always_enqueue") {
            throw error;
          }

          const existingIssue = await findLiveExecutionIssue(input.automation, txDb);
          if (!existingIssue) throw error;
          const status = input.automation.concurrencyPolicy === "skip_if_active" ? "skipped" : "coalesced";
          const updated = await finalizeRun(createdRun.id, {
            status,
            linkedIssueId: existingIssue.id,
            coalescedIntoRunId: existingIssue.originRunId,
            completedAt: triggeredAt,
          }, txDb);
          await updateAutomationTouchedState({
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            triggeredAt,
            status,
            issueId: existingIssue.id,
            nextRunAt,
          }, txDb);
          await postAutomationRunChatEvent({
            automation: input.automation,
            runId: createdRun.id,
            status,
            source: input.source,
            triggerId: input.trigger?.id ?? null,
            issueId: existingIssue.id,
            terminal: true,
            executor: txDb,
          });
          return await getAutomationRunById(createdRun.id, txDb) ?? updated ?? createdRun;
        }

        // Keep the dispatch lock until the issue is linked to a queued heartbeat run.
        await queueIssueAssignmentWakeup({
          heartbeat,
          issue: createdIssue,
          reason: "issue_assigned",
          mutation: "create",
          contextSource: "automation.dispatch",
          requestedByActorType: input.source === "schedule" ? "system" : undefined,
          rethrowOnError: true,
        });
        await followAutomationIssueForNotification({
          automation: input.automation,
          issueId: createdIssue.id,
          executor: txDb,
        });
        const updated = await finalizeRun(createdRun.id, {
          status: "issue_created",
          linkedIssueId: createdIssue.id,
        }, txDb);
        await updateAutomationTouchedState({
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "issue_created",
          issueId: createdIssue.id,
          nextRunAt,
        }, txDb);
        await postAutomationRunChatEvent({
          automation: input.automation,
          runId: createdRun.id,
          status: "issue_created",
          source: input.source,
          triggerId: input.trigger?.id ?? null,
          issueId: createdIssue.id,
          executor: txDb,
        });
        return await getAutomationRunById(createdRun.id, txDb) ?? updated ?? createdRun;
      } catch (error) {
        if (createdIssue) {
          await txDb.delete(issues).where(eq(issues.id, createdIssue.id));
        }
        const failureReason = error instanceof Error ? error.message : String(error);
        const failed = await finalizeRun(createdRun.id, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        }, txDb);
        await updateAutomationTouchedState({
          automationId: input.automation.id,
          triggerId: input.trigger?.id ?? null,
          triggeredAt,
          status: "failed",
          nextRunAt,
        }, txDb);
        await postAutomationRunChatEvent({
          automation: input.automation,
          runId: createdRun.id,
          status: "failed",
          source: input.source,
          triggerId: input.trigger?.id ?? null,
          failureReason,
          terminal: true,
          executor: txDb,
        });
        return await getAutomationRunById(createdRun.id, txDb) ?? failed ?? createdRun;
      }
    });

    if (input.source === "schedule" || input.source === "webhook") {
      const actorId = input.source === "schedule" ? "automation-scheduler" : "automation-webhook";
      try {
        await logActivity(db, {
          orgId: input.automation.orgId,
          actorType: "system",
          actorId,
          action: "automation.run_triggered",
          entityType: "automation_run",
          entityId: run.id,
          details: {
            automationId: input.automation.id,
            triggerId: input.trigger?.id ?? null,
            source: run.source,
            status: run.status,
            outputMode: input.automation.outputMode,
          },
        });
      } catch (err) {
        logger.warn({ err, automationId: input.automation.id, runId: run.id }, "failed to log automated run");
      }
    }

    if (autoStartChatOutputRuns && input.automation.outputMode === "chat_output" && run.status === "running") {
      void executeChatOutputAutomationRun(run.id).catch((err) => {
        logger.warn({ err, automationId: input.automation.id, runId: run.id }, "automation chat output worker failed");
      });
    }

    return run;
  }

  return {
    get: getAutomationById,
    getTrigger: getTriggerById,
    executeChatOutputAutomationRun,

    list: async (orgId: string): Promise<AutomationListItem[]> => {
      const rows = await db
        .select()
        .from(automations)
        .where(and(eq(automations.orgId, orgId), ne(automations.status, "archived")))
        .orderBy(desc(automations.updatedAt), asc(automations.title));
      const automationIds = rows.map((row) => row.id);
      const [triggersByAutomation, latestRunByAutomation, activeIssueByAutomation] = await Promise.all([
        listTriggersForAutomationIds(orgId, automationIds),
        listLatestRunByAutomationIds(orgId, automationIds),
        listLiveIssueByAutomationIds(orgId, automationIds),
      ]);
      return rows.map((row) => ({
        ...toAutomation(row),
        triggers: (triggersByAutomation.get(row.id) ?? []).map((trigger) => ({
          id: trigger.id,
          kind: trigger.kind as AutomationListItem["triggers"][number]["kind"],
          label: trigger.label,
          enabled: trigger.enabled,
          nextRunAt: trigger.nextRunAt,
          lastFiredAt: trigger.lastFiredAt,
          lastResult: trigger.lastResult,
        })),
        lastRun: latestRunByAutomation.get(row.id) ?? null,
        activeIssue: activeIssueByAutomation.get(row.id) ?? null,
      }));
    },

    getDetail: async (id: string): Promise<AutomationDetail | null> => {
      const row = await getAutomationById(id);
      if (!row) return null;
      if (row.status === "archived") return null;
      const [project, assignee, parentIssue, triggers, recentRuns, activeIssue] = await Promise.all([
        row.projectId ? db.select().from(projects).where(eq(projects.id, row.projectId)).then((rows) => rows[0] ?? null) : null,
        db.select().from(agents).where(eq(agents.id, row.assigneeAgentId)).then((rows) => rows[0] ?? null),
        row.parentIssueId ? issueSvc.getById(row.parentIssueId) : null,
        db.select().from(automationTriggers).where(eq(automationTriggers.automationId, row.id)).orderBy(asc(automationTriggers.createdAt)),
        db
          .select({
            id: automationRuns.id,
            orgId: automationRuns.orgId,
            automationId: automationRuns.automationId,
            triggerId: automationRuns.triggerId,
            source: automationRuns.source,
            status: automationRuns.status,
            triggeredAt: automationRuns.triggeredAt,
            idempotencyKey: automationRuns.idempotencyKey,
            triggerPayload: automationRuns.triggerPayload,
            linkedIssueId: automationRuns.linkedIssueId,
            linkedChatConversationId: automationRuns.linkedChatConversationId,
            startedChatMessageId: automationRuns.startedChatMessageId,
            terminalChatMessageId: automationRuns.terminalChatMessageId,
            lastChatMessageId: automationRuns.lastChatMessageId,
            coalescedIntoRunId: automationRuns.coalescedIntoRunId,
            failureReason: automationRuns.failureReason,
            completedAt: automationRuns.completedAt,
            createdAt: automationRuns.createdAt,
            updatedAt: automationRuns.updatedAt,
            triggerKind: automationTriggers.kind,
            triggerLabel: automationTriggers.label,
            issueIdentifier: issues.identifier,
            issueTitle: issues.title,
            issueStatus: issues.status,
            issuePriority: issues.priority,
            issueUpdatedAt: issues.updatedAt,
            chatTitle: chatConversations.title,
            chatStatus: chatConversations.status,
            chatPreferredAgentId: chatConversations.preferredAgentId,
            chatLastMessageAt: chatConversations.lastMessageAt,
          })
          .from(automationRuns)
          .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
          .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
          .leftJoin(chatConversations, eq(automationRuns.linkedChatConversationId, chatConversations.id))
          .where(eq(automationRuns.automationId, row.id))
          .orderBy(desc(automationRuns.createdAt))
          .limit(25)
          .then((runs) =>
            runs.map((run) => ({
              id: run.id,
              orgId: run.orgId,
              automationId: run.automationId,
              triggerId: run.triggerId,
              source: run.source as AutomationRunSummary["source"],
              status: run.status as AutomationRunSummary["status"],
              triggeredAt: run.triggeredAt,
              idempotencyKey: run.idempotencyKey,
              triggerPayload: run.triggerPayload as Record<string, unknown> | null,
              linkedIssueId: run.linkedIssueId,
              linkedChatConversationId: run.linkedChatConversationId,
              startedChatMessageId: run.startedChatMessageId,
              terminalChatMessageId: run.terminalChatMessageId,
              lastChatMessageId: run.lastChatMessageId,
              coalescedIntoRunId: run.coalescedIntoRunId,
              failureReason: run.failureReason,
              completedAt: run.completedAt,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              linkedIssue: run.linkedIssueId
                ? {
                  id: run.linkedIssueId,
                  identifier: run.issueIdentifier,
                  title: run.issueTitle ?? "Automation execution",
                  status: run.issueStatus ?? "todo",
                  priority: run.issuePriority ?? "medium",
                  updatedAt: run.issueUpdatedAt ?? run.updatedAt,
                }
                : null,
              linkedChatConversation: linkedChatConversationFromRow(run),
              trigger: run.triggerId
                ? {
                  id: run.triggerId,
                  kind: run.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
                  label: run.triggerLabel,
                }
                : null,
            })),
          ),
        findLiveExecutionIssue(row),
      ]);

      return {
        ...toAutomation(row),
        project,
        assignee,
        parentIssue,
        chatConversation: null,
        triggers: triggers as AutomationTrigger[],
        recentRuns,
        activeIssue,
      };
    },

    create: async (orgId: string, input: CreateAutomation, actor: Actor): Promise<Automation> => {
      if (input.projectId) await assertProject(orgId, input.projectId);
      await assertAssignableAgent(orgId, input.assigneeAgentId);
      if (input.goalId) await assertGoal(orgId, input.goalId);
      if (input.parentIssueId) await assertParentIssue(orgId, input.parentIssueId);
      assertChatOutputDestination({
        outputMode: input.outputMode,
        chatConversationId: input.chatConversationId,
        isCreate: true,
      });
      const notification = normalizeCreateNotification(input, actor);
      const [created] = await db
        .insert(automations)
        .values({
          orgId,
          projectId: input.projectId ?? null,
          goalId: input.goalId ?? null,
          parentIssueId: input.parentIssueId ?? null,
          title: input.title,
          description: input.description ?? null,
          assigneeAgentId: input.assigneeAgentId,
          outputMode: input.outputMode,
          chatConversationId: null,
          notifyOnIssueCreated: notification.enabled,
          notifyOnIssueCreatedUserId: notification.userId,
          priority: input.priority,
          status: input.status,
          concurrencyPolicy: input.concurrencyPolicy,
          catchUpPolicy: input.catchUpPolicy,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();
      return toAutomation(created);
    },

    update: async (id: string, patch: UpdateAutomation, actor: Actor): Promise<Automation | null> => {
      const existing = await getAutomationById(id);
      if (!existing) return null;
      const nextProjectId = patch.projectId === undefined ? existing.projectId : patch.projectId;
      const nextAssigneeAgentId = patch.assigneeAgentId ?? existing.assigneeAgentId;
      const nextOutputMode = patch.outputMode ?? existing.outputMode;
      const requestedChatConversationId = patch.chatConversationId === undefined ? existing.chatConversationId : patch.chatConversationId;
      if (nextProjectId) await assertProject(existing.orgId, nextProjectId);
      if (patch.assigneeAgentId) await assertAssignableAgent(existing.orgId, nextAssigneeAgentId);
      if (patch.goalId) await assertGoal(existing.orgId, patch.goalId);
      if (patch.parentIssueId) await assertParentIssue(existing.orgId, patch.parentIssueId);
      assertChatOutputDestination({
        outputMode: nextOutputMode,
        chatConversationId: requestedChatConversationId,
        existingChatConversationId: existing.chatConversationId,
      });
      const nextChatConversationId = null;
      const notification = normalizeUpdateNotification({
        existing,
        patch,
        actor,
        nextOutputMode,
      });
      const [updated] = await db
        .update(automations)
        .set({
          projectId: nextProjectId,
          goalId: patch.goalId === undefined ? existing.goalId : patch.goalId,
          parentIssueId: patch.parentIssueId === undefined ? existing.parentIssueId : patch.parentIssueId,
          title: patch.title ?? existing.title,
          description: patch.description === undefined ? existing.description : patch.description,
          assigneeAgentId: nextAssigneeAgentId,
          outputMode: nextOutputMode,
          chatConversationId: nextChatConversationId,
          notifyOnIssueCreated: notification.enabled,
          notifyOnIssueCreatedUserId: notification.userId,
          priority: patch.priority ?? existing.priority,
          status: patch.status ?? existing.status,
          concurrencyPolicy: patch.concurrencyPolicy ?? existing.concurrencyPolicy,
          catchUpPolicy: patch.catchUpPolicy ?? existing.catchUpPolicy,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, id))
        .returning();
      return updated ? toAutomation(updated) : null;
    },

    delete: async (id: string): Promise<Automation | null> => {
      const existing = await getAutomationById(id);
      if (!existing) return null;

      const secretRows = await db
        .select({ secretId: automationTriggers.secretId })
        .from(automationTriggers)
        .where(and(eq(automationTriggers.automationId, id), isNotNull(automationTriggers.secretId)));
      const secretIds = [...new Set(secretRows.map((row) => row.secretId).filter((secretId): secretId is string => Boolean(secretId)))];

      await db.transaction(async (tx) => {
        if (secretIds.length > 0) {
          await tx.delete(organizationSecrets).where(inArray(organizationSecrets.id, secretIds));
        }
        await tx.delete(automations).where(eq(automations.id, id));
      });

      return toAutomation(existing);
    },

    createTrigger: async (
      automationId: string,
      input: CreateAutomationTrigger,
      actor: Actor,
    ): Promise<{ trigger: AutomationTrigger; secretMaterial: AutomationTriggerSecretMaterial | null }> => {
      const automation = await getAutomationById(automationId);
      if (!automation) throw notFound("Automation not found");

      let secretMaterial: AutomationTriggerSecretMaterial | null = null;
      let secretId: string | null = null;
      let publicId: string | null = null;
      let nextRunAt: Date | null = null;

      if (input.kind === "schedule") {
        const timeZone = input.timezone || "UTC";
        assertTimeZone(timeZone);
        const error = validateCron(input.cronExpression);
        if (error) throw unprocessable(error);
        nextRunAt = nextCronTickInTimeZone(input.cronExpression, timeZone, new Date());
      }

      if (input.kind === "webhook") {
        publicId = crypto.randomBytes(12).toString("hex");
        const created = await createWebhookSecret(automation.orgId, automation.id, actor);
        secretId = created.secret.id;
        secretMaterial = {
          webhookUrl: `${process.env.RUDDER_API_URL}/api/automation-triggers/public/${publicId}/fire`,
          webhookSecret: created.secretValue,
        };
      }

      const [trigger] = await db
        .insert(automationTriggers)
        .values({
          orgId: automation.orgId,
          automationId: automation.id,
          kind: input.kind,
          label: input.label ?? null,
          enabled: input.enabled ?? true,
          cronExpression: input.kind === "schedule" ? input.cronExpression : null,
          timezone: input.kind === "schedule" ? (input.timezone || "UTC") : null,
          nextRunAt,
          publicId,
          secretId,
          signingMode: input.kind === "webhook" ? input.signingMode : null,
          replayWindowSec: input.kind === "webhook" ? input.replayWindowSec : null,
          lastRotatedAt: input.kind === "webhook" ? new Date() : null,
          createdByAgentId: actor.agentId ?? null,
          createdByUserId: actor.userId ?? null,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
        })
        .returning();

      return {
        trigger: trigger as AutomationTrigger,
        secretMaterial,
      };
    },

    updateTrigger: async (id: string, patch: UpdateAutomationTrigger, actor: Actor): Promise<AutomationTrigger | null> => {
      const existing = await getTriggerById(id);
      if (!existing) return null;

      let nextRunAt = existing.nextRunAt;
      let cronExpression = existing.cronExpression;
      let timezone = existing.timezone;

      if (existing.kind === "schedule") {
        if (patch.cronExpression !== undefined) {
          if (patch.cronExpression == null) throw unprocessable("Scheduled triggers require cronExpression");
          const error = validateCron(patch.cronExpression);
          if (error) throw unprocessable(error);
          cronExpression = patch.cronExpression;
        }
        if (patch.timezone !== undefined) {
          if (patch.timezone == null) throw unprocessable("Scheduled triggers require timezone");
          assertTimeZone(patch.timezone);
          timezone = patch.timezone;
        }
        if (cronExpression && timezone) {
          nextRunAt = nextCronTickInTimeZone(cronExpression, timezone, new Date());
        }
      }

      const [updated] = await db
        .update(automationTriggers)
        .set({
          label: patch.label === undefined ? existing.label : patch.label,
          enabled: patch.enabled ?? existing.enabled,
          cronExpression,
          timezone,
          nextRunAt,
          signingMode: patch.signingMode === undefined ? existing.signingMode : patch.signingMode,
          replayWindowSec: patch.replayWindowSec === undefined ? existing.replayWindowSec : patch.replayWindowSec,
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, id))
        .returning();

      return (updated as AutomationTrigger | undefined) ?? null;
    },

    deleteTrigger: async (id: string): Promise<boolean> => {
      const existing = await getTriggerById(id);
      if (!existing) return false;
      await db.delete(automationTriggers).where(eq(automationTriggers.id, id));
      return true;
    },

    rotateTriggerSecret: async (
      id: string,
      actor: Actor,
    ): Promise<{ trigger: AutomationTrigger; secretMaterial: AutomationTriggerSecretMaterial }> => {
      const existing = await getTriggerById(id);
      if (!existing) throw notFound("Automation trigger not found");
      if (existing.kind !== "webhook" || !existing.publicId || !existing.secretId) {
        throw unprocessable("Only webhook triggers can rotate secrets");
      }

      const secretValue = crypto.randomBytes(24).toString("hex");
      await secretsSvc.rotate(existing.secretId, { value: secretValue }, actor);
      const [updated] = await db
        .update(automationTriggers)
        .set({
          lastRotatedAt: new Date(),
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(automationTriggers.id, id))
        .returning();

      return {
        trigger: updated as AutomationTrigger,
        secretMaterial: {
          webhookUrl: `${process.env.RUDDER_API_URL}/api/automation-triggers/public/${existing.publicId}/fire`,
          webhookSecret: secretValue,
        },
      };
    },

    runAutomation: async (id: string, input: RunAutomation) => {
      const automation = await getAutomationById(id);
      if (!automation) throw notFound("Automation not found");
      if (automation.status !== "active") throw conflict("Automation is not active");
      const trigger = input.triggerId ? await getTriggerById(input.triggerId) : null;
      if (trigger && trigger.automationId !== automation.id) throw forbidden("Trigger does not belong to automation");
      if (trigger && !trigger.enabled) throw conflict("Automation trigger is not active");
      return dispatchAutomationRun({
        automation,
        trigger,
        source: input.source,
        payload: input.payload as Record<string, unknown> | null | undefined,
        idempotencyKey: input.idempotencyKey,
      });
    },

    firePublicTrigger: async (publicId: string, input: {
      authorizationHeader?: string | null;
      signatureHeader?: string | null;
      timestampHeader?: string | null;
      idempotencyKey?: string | null;
      rawBody?: Buffer | null;
      payload?: Record<string, unknown> | null;
    }) => {
      const trigger = await db
        .select()
        .from(automationTriggers)
        .where(and(eq(automationTriggers.publicId, publicId), eq(automationTriggers.kind, "webhook")))
        .then((rows) => rows[0] ?? null);
      if (!trigger) throw notFound("Automation trigger not found");
      const automation = await getAutomationById(trigger.automationId);
      if (!automation) throw notFound("Automation not found");
      if (!trigger.enabled || automation.status !== "active") throw conflict("Automation trigger is not active");

      const secretValue = await resolveTriggerSecret(trigger, automation.orgId);
      if (trigger.signingMode === "bearer") {
        const expected = `Bearer ${secretValue}`;
        const provided = input.authorizationHeader?.trim() ?? "";
        const expectedBuf = Buffer.from(expected);
        const providedBuf = Buffer.alloc(expectedBuf.length);
        providedBuf.write(provided.slice(0, expectedBuf.length));
        const valid =
          provided.length === expected.length &&
          crypto.timingSafeEqual(providedBuf, expectedBuf);
        if (!valid) {
          throw unauthorized();
        }
      } else {
        const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.payload ?? {}));
        const providedSignature = input.signatureHeader?.trim() ?? "";
        const providedTimestamp = input.timestampHeader?.trim() ?? "";
        if (!providedSignature || !providedTimestamp) throw unauthorized();
        const tsMillis = normalizeWebhookTimestampMs(providedTimestamp);
        if (tsMillis == null) throw unauthorized();
        const replayWindowSec = trigger.replayWindowSec ?? 300;
        if (Math.abs(Date.now() - tsMillis) > replayWindowSec * 1000) {
          throw unauthorized();
        }
        const expectedHmac = crypto
          .createHmac("sha256", secretValue)
          .update(`${providedTimestamp}.`)
          .update(rawBody)
          .digest("hex");
        const normalizedSignature = providedSignature.replace(/^sha256=/, "");
        const valid =
          normalizedSignature.length === expectedHmac.length &&
          crypto.timingSafeEqual(Buffer.from(normalizedSignature), Buffer.from(expectedHmac));
        if (!valid) throw unauthorized();
      }

      return dispatchAutomationRun({
        automation,
        trigger,
        source: "webhook",
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
      });
    },

    listRuns: async (automationId: string, limit = 50): Promise<AutomationRunSummary[]> => {
      const cappedLimit = Math.max(1, Math.min(limit, 200));
      const rows = await db
        .select({
          id: automationRuns.id,
          orgId: automationRuns.orgId,
          automationId: automationRuns.automationId,
          triggerId: automationRuns.triggerId,
          source: automationRuns.source,
          status: automationRuns.status,
          triggeredAt: automationRuns.triggeredAt,
          idempotencyKey: automationRuns.idempotencyKey,
          triggerPayload: automationRuns.triggerPayload,
          linkedIssueId: automationRuns.linkedIssueId,
          linkedChatConversationId: automationRuns.linkedChatConversationId,
          startedChatMessageId: automationRuns.startedChatMessageId,
          terminalChatMessageId: automationRuns.terminalChatMessageId,
          lastChatMessageId: automationRuns.lastChatMessageId,
          coalescedIntoRunId: automationRuns.coalescedIntoRunId,
          failureReason: automationRuns.failureReason,
          completedAt: automationRuns.completedAt,
          createdAt: automationRuns.createdAt,
          updatedAt: automationRuns.updatedAt,
          triggerKind: automationTriggers.kind,
          triggerLabel: automationTriggers.label,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
          issueStatus: issues.status,
          issuePriority: issues.priority,
          issueUpdatedAt: issues.updatedAt,
          chatTitle: chatConversations.title,
          chatStatus: chatConversations.status,
          chatPreferredAgentId: chatConversations.preferredAgentId,
          chatLastMessageAt: chatConversations.lastMessageAt,
        })
        .from(automationRuns)
        .leftJoin(automationTriggers, eq(automationRuns.triggerId, automationTriggers.id))
        .leftJoin(issues, eq(automationRuns.linkedIssueId, issues.id))
        .leftJoin(chatConversations, eq(automationRuns.linkedChatConversationId, chatConversations.id))
        .where(eq(automationRuns.automationId, automationId))
        .orderBy(desc(automationRuns.createdAt))
        .limit(cappedLimit);

      return rows.map((row) => ({
        id: row.id,
        orgId: row.orgId,
        automationId: row.automationId,
        triggerId: row.triggerId,
        source: row.source as AutomationRunSummary["source"],
        status: row.status as AutomationRunSummary["status"],
        triggeredAt: row.triggeredAt,
        idempotencyKey: row.idempotencyKey,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
        linkedIssueId: row.linkedIssueId,
        linkedChatConversationId: row.linkedChatConversationId,
        startedChatMessageId: row.startedChatMessageId,
        terminalChatMessageId: row.terminalChatMessageId,
        lastChatMessageId: row.lastChatMessageId,
        coalescedIntoRunId: row.coalescedIntoRunId,
        failureReason: row.failureReason,
        completedAt: row.completedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        linkedIssue: row.linkedIssueId
          ? {
            id: row.linkedIssueId,
            identifier: row.issueIdentifier,
            title: row.issueTitle ?? "Automation execution",
            status: row.issueStatus ?? "todo",
            priority: row.issuePriority ?? "medium",
            updatedAt: row.issueUpdatedAt ?? row.updatedAt,
          }
          : null,
        linkedChatConversation: linkedChatConversationFromRow(row),
        trigger: row.triggerId
          ? {
            id: row.triggerId,
            kind: row.triggerKind as NonNullable<AutomationRunSummary["trigger"]>["kind"],
            label: row.triggerLabel,
          }
          : null,
      }));
    },

    tickScheduledTriggers: async (now: Date = new Date()) => {
      const due = await db
        .select({
          trigger: automationTriggers,
          automation: automations,
        })
        .from(automationTriggers)
        .innerJoin(automations, eq(automationTriggers.automationId, automations.id))
        .where(
          and(
            eq(automationTriggers.kind, "schedule"),
            eq(automationTriggers.enabled, true),
            eq(automations.status, "active"),
            isNotNull(automationTriggers.nextRunAt),
            lte(automationTriggers.nextRunAt, now),
          ),
        )
        .orderBy(asc(automationTriggers.nextRunAt), asc(automationTriggers.createdAt));

      let triggered = 0;
      for (const row of due) {
        if (!row.trigger.nextRunAt || !row.trigger.cronExpression || !row.trigger.timezone) continue;

        let runCount = 1;
        let claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, now);

        if (row.automation.catchUpPolicy === "enqueue_missed_with_cap") {
          let cursor: Date | null = row.trigger.nextRunAt;
          runCount = 0;
          while (cursor && cursor <= now && runCount < MAX_CATCH_UP_RUNS) {
            runCount += 1;
            claimedNextRunAt = nextCronTickInTimeZone(row.trigger.cronExpression, row.trigger.timezone, cursor);
            cursor = claimedNextRunAt;
          }
        }

        const claimed = await db
          .update(automationTriggers)
          .set({
            nextRunAt: claimedNextRunAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(automationTriggers.id, row.trigger.id),
              eq(automationTriggers.enabled, true),
              eq(automationTriggers.nextRunAt, row.trigger.nextRunAt),
            ),
          )
          .returning({ id: automationTriggers.id })
          .then((rows) => rows[0] ?? null);
        if (!claimed) continue;

        for (let i = 0; i < runCount; i += 1) {
          await dispatchAutomationRun({
            automation: row.automation,
            trigger: row.trigger,
            source: "schedule",
          });
          triggered += 1;
        }
      }

      return { triggered };
    },

    syncRunStatusForIssue: async (issueId: string) => {
      const issue = await db
        .select({
          id: issues.id,
          status: issues.status,
          originKind: issues.originKind,
          originId: issues.originId,
          originRunId: issues.originRunId,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      if (!issue || issue.originKind !== "automation_execution" || !issue.originRunId) return null;
      const automation = issue.originId ? await getAutomationById(issue.originId) : null;
      if (issue.status === "done") {
        const run = await finalizeRun(issue.originRunId, {
          status: "completed",
          completedAt: new Date(),
        });
        if (automation) {
          await postAutomationRunChatEvent({
            automation,
            runId: issue.originRunId,
            status: "completed",
            source: run?.source ?? "manual",
            triggerId: run?.triggerId ?? null,
            issueId: issue.id,
            terminal: true,
          });
          return getAutomationRunById(issue.originRunId);
        }
        return run;
      }
      if (issue.status === "blocked" || issue.status === "cancelled") {
        const failureReason = `Execution issue moved to ${issue.status}`;
        const run = await finalizeRun(issue.originRunId, {
          status: "failed",
          failureReason,
          completedAt: new Date(),
        });
        if (automation) {
          await postAutomationRunChatEvent({
            automation,
            runId: issue.originRunId,
            status: "failed",
            source: run?.source ?? "manual",
            triggerId: run?.triggerId ?? null,
            issueId: issue.id,
            failureReason,
            terminal: true,
          });
          return getAutomationRunById(issue.originRunId);
        }
        return run;
      }
      return null;
    },
  };
}
