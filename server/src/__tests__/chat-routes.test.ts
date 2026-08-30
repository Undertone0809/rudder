import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conflict, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { createChatBackgroundRuntime, type ChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { chatRoutes } from "../routes/chats.js";
import { claimChatGeneration, clearActiveChatGenerationsForTest, createChatRuntimeControlCoordinator, getActiveChatGeneration, hasActiveChatGeneration } from "../services/chat-generation-locks.js";
import { CHAT_TITLE_PROMPT_TOKEN_LIMIT, countChatTitlePromptTokens } from "../services/title-generation.js";

const mockChatService = vi.hoisted(() => ({
  generationProtocol: {
    getLatestVisibleCheckpoint: vi.fn(),
    appendGenerationEvent: vi.fn(),
    appendVisibleEventAndProject: vi.fn(),
    projectVisibleMessage: vi.fn(),
    getFrozenVisibleProjection: vi.fn(),
    recordClientCheckpoint: vi.fn(),
    beginStopAction: vi.fn(),
    beginSteerFallbackCutoff: vi.fn(),
    markNetworkResumed: vi.fn(),
    recordRuntimeTerminal: vi.fn(),
    claimTerminalProjection: vi.fn(),
    getNextTerminalProjectionWakeAt: vi.fn(),
    completeTerminalProjection: vi.fn(),
    retryTerminalProjection: vi.fn(),
    recoverStaleControlOwners: vi.fn(),
  },
  list: vi.fn(),
  getById: vi.fn(),
  resolveByReference: vi.fn(),
  create: vi.fn(),
  createWithInitialMessage: vi.fn(),
  forkConversation: vi.fn(),
  update: vi.fn(),
  updateAgentModelInvariant: vi.fn(),
  listAttachmentsForConversation: vi.fn(),
  assetHasAttachments: vi.fn(),
  remove: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  setPinned: vi.fn(),
  listMessages: vi.fn(),
  listRecentUserMessages: vi.fn(),
  getMessageTranscript: vi.fn(),
  getMessage: vi.fn(),
  getUserMessageByClientMutationId: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  updateMessageStructuredPayload: vi.fn(),
  updateMessageInternalInlineVisuals: vi.fn(),
  markInterruptedStreamingMessages: vi.fn(),
  addUserChatMessage: vi.fn(),
  addContextLink: vi.fn(),
  setProjectContextLink: vi.fn(),
  createAttachment: vi.fn(),
  removeAttachment: vi.fn(),
  convertToIssue: vi.fn(),
  resolve: vi.fn(),
  createProposalApproval: vi.fn(),
  resolveOperationProposal: vi.fn(),
  updateDefaultTitle: vi.fn(),
  replaceSystemGeneratedTitle: vi.fn(),
  getQueueSnapshot: vi.fn(),
  getQueuedMessageReplay: vi.fn(),
  createQueuedMessage: vi.fn(),
  createQueuedMessageWithStagedAttachments: vi.fn(),
  updateQueuedMessage: vi.fn(),
  updateQueuedMessageWithStagedAttachments: vi.fn(),
  cancelQueuedMessage: vi.fn(),
  cancelQueuedMessageWithStagedAttachments: vi.fn(),
  finalizeQueuedAnnotationAssetCleanup: vi.fn(),
  scheduleSteerContinuation: vi.fn(),
  markQueuedMessageSteerFallback: vi.fn(),
  beginSteerControlAction: vi.fn(),
  claimSteerProviderSend: vi.fn(),
  releaseSteerProviderSendClaim: vi.fn(),
  resolveSteerControlAction: vi.fn(),
  appendGenerationEvent: vi.fn(),
  beginGenerationControlAttempt: vi.fn(),
  markGenerationControlReady: vi.fn(),
  renewGenerationControlLease: vi.fn(),
  markGenerationControlAttemptCompleted: vi.fn(),
  claimNextServerQueuedMessage: vi.fn(),
  renewServerQueuedMessageClaim: vi.fn(),
  acknowledgeServerQueuedMessageDelivery: vi.fn(),
  completeServerQueuedMessageDelivery: vi.fn(),
  releaseServerQueuedMessageClaim: vi.fn(),
  recoverExpiredServerQueueClaims: vi.fn(),
  claimNextQueuedMessage: vi.fn(),
  releaseQueuedMessageClaim: vi.fn(),
  createGeneration: vi.fn(),
  markGenerationTerminal: vi.fn(),
  getLatestActiveGeneration: vi.fn(),
  getLatestGeneration: vi.fn(),
  assertQueuedMessageClaimedForDelivery: vi.fn(),
  markQueuedMessageRunning: vi.fn(),
  markQueuedMessageDeliveryTerminal: vi.fn(),
}));

const mockSideChatService = vi.hoisted(() => ({
  create: vi.fn(),
  destroy: vi.fn(),
  keepInMessenger: vi.fn(),
  assertAccessible: vi.fn(),
  assertMutable: vi.fn(),
  touch: vi.fn(),
}));

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  listLabels: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAutomationService = vi.hoisted(() => ({
  create: vi.fn(),
  createTrigger: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockOperatorProfileService = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockProductIntelligenceService = vi.hoisted(() => ({
  execute: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockChatAssistantService = vi.hoisted(() => ({
  enrichConversation: vi.fn(),
  enrichConversations: vi.fn(),
  getChatAssistantAvailability: vi.fn(),
  getDraftChatAssistantAvailability: vi.fn(),
  generateChatAssistantReply: vi.fn(),
  streamChatAssistantReply: vi.fn(),
}));

const mockChatAgentRuns = vi.hoisted(() => ({
  linkAssistantMessage: vi.fn(),
  finalizeRun: vi.fn(),
  releaseOwnedRun: vi.fn(),
}));

const mockChatWorkManifest = vi.hoisted(() => ({
  reconcileConversation: vi.fn(),
  getConversationManifest: vi.fn(),
}));

const mockChatInlineAnnotations = vi.hoisted(() => ({
  prepare: vi.fn(),
}));

const testBackgroundRuntimes = new Set<ChatBackgroundRuntime>();

const mockChatSteerMessages = vi.hoisted(() => ({
  beginControlAction: vi.fn(),
  scheduleContinuation: vi.fn(),
}));

const mockStorage = vi.hoisted(() => ({
  putFile: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  automationService: () => mockAutomationService,
  chatService: () => mockChatService,
  heartbeatService: () => mockHeartbeatService,
  organizationService: () => mockCompanyService,
  goalService: () => mockGoalService,
  issueService: () => mockIssueService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  productIntelligenceService: () => mockProductIntelligenceService,
  sideChatService: () => mockSideChatService,
  logActivity: mockLogActivity,
  operatorProfileService: () => mockOperatorProfileService,
  projectService: () => mockProjectService,
}));

vi.mock("../services/chat-assistant.js", () => ({
  CHAT_ASSISTANT_USER_ERROR_MESSAGE: "The assistant hit a system-level issue. Rudder saved the details for diagnostics; retry when ready.",
  chatAssistantErrorForLog: (error: unknown) => error,
  ChatAssistantStreamError: class ChatAssistantStreamError extends Error {
    partialBody: string;
    partialBodyUserVisible: boolean;
    generatedAttachments: unknown[];
    errorCode: string;
    userMessage: string;
    retryable?: boolean;
    failurePhase?: string;
    action?: string;

    constructor(message: string, partialBody = "", generatedAttachments: unknown[] = [], options: {
      partialBodyUserVisible?: boolean;
      errorCode?: string;
      userMessage?: string;
      retryable?: boolean;
      failurePhase?: string;
      action?: string;
    } = {}) {
      super(message);
      this.partialBody = partialBody;
      this.partialBodyUserVisible = options.partialBodyUserVisible === true;
      this.generatedAttachments = generatedAttachments;
      this.errorCode = options.errorCode ?? "chat_runtime_exception";
      this.userMessage = options.userMessage ?? "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.";
      this.retryable = options.retryable;
      this.failurePhase = options.failurePhase;
      this.action = options.action;
    }
  },
  chatAssistantService: () => mockChatAssistantService,
  userVisiblePartialBodyFromError: (error: unknown) => {
    const candidate = error as { partialBody?: unknown; partialBodyUserVisible?: unknown };
    return candidate?.partialBodyUserVisible === true && typeof candidate.partialBody === "string"
      ? candidate.partialBody
      : "";
  },
}));

vi.mock("../services/chat-agent-runs.js", () => ({
  chatAgentRunService: () => mockChatAgentRuns,
}));

vi.mock("../services/chat-work-manifest.js", () => ({
  chatWorkManifestService: () => mockChatWorkManifest,
}));

vi.mock("../services/chat-steer-messages.js", () => ({
  chatSteerMessageService: () => mockChatSteerMessages,
}));

vi.mock("../services/chat-inline-annotations.js", async () => {
  const actual = await vi.importActual<typeof import("../services/chat-inline-annotations.js")>(
    "../services/chat-inline-annotations.js",
  );
  return {
    ...actual,
    chatInlineAnnotationService: () => mockChatInlineAnnotations,
  };
});

const annotationConversationId = "10000000-0000-4000-8000-000000000001";
const annotationSourceMessageId = "10000000-0000-4000-8000-000000000002";

function createInlineAnnotation(overrides: Record<string, unknown> = {}) {
  return {
    id: "10000000-0000-4000-8000-000000000003",
    surface: "assistant_body",
    selectedText: "Quoted assistant response",
    comment: "Explain this boundary",
    sourceConversationId: annotationConversationId,
    sourceMessageId: annotationSourceMessageId,
    sourceHash: "a".repeat(64),
    start: 0,
    end: 10,
    prefix: "",
    suffix: "",
    attachmentIds: [],
    ...overrides,
  };
}

function createConversation(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-26T08:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "organization-1",
    status: "active",
    conversationKind: "chat",
    messengerVisible: true,
    sideChatState: null,
    sideChatExpiresAt: null,
    sideChatCompletedAt: null,
    sideChatKeptAt: null,
    sideChatClientMutationId: null,
    title: "New chat",
    summary: null,
    latestReplyPreview: null,
    latestUserMessagePreview: null,
    userMessageCount: 0,
    preferredAgentId: "agent-1",
    modelOverride: null,
    effortOverride: null,
    routedAgentId: null,
    primaryIssueId: null,
    primaryIssue: null,
    issueCreationMode: "manual_approval",
    planMode: false,
    createdByUserId: "user-1",
    lastMessageAt: now,
    lastReadAt: now,
    isPinned: false,
    isUnread: false,
    unreadCount: 0,
    needsAttention: false,
    resolvedAt: null,
    forkedFromConversationId: null,
    forkedFromMessageId: null,
    forkRootConversationId: null,
    sourceMetadata: null,
    mutability: "native_chat",
    chatRuntime: {
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      effort: null,
      available: true,
      error: null,
    },
    contextLinks: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createFeishuBackedConversation(overrides: Partial<Record<string, unknown>> = {}) {
  return createConversation({
    mutability: "external_bound_chat",
    sourceMetadata: {
      source: "agent_integration",
      provider: "feishu",
      integrationId: "integration-1",
      externalChatId: "oc_chat",
      externalChatType: "p2p",
    },
    ...overrides,
  });
}

function createMessage(id: string, role: "user" | "assistant" | "system", kind: string, body: string, approvalId: string | null = null) {
  const now = new Date("2026-03-26T08:01:00.000Z");
  return {
    id,
    orgId: "organization-1",
    conversationId: "chat-1",
    role,
    kind,
    status: "completed",
    body,
    structuredPayload: null,
    approvalId,
    approval: null,
    attachments: [],
    transcript: [],
    replyingAgentId: null,
    chatTurnId: "10000000-0000-4000-8000-000000000001",
    turnVariant: 0,
    supersededAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function createApp(
  actor: Record<string, unknown> = {
    type: "board",
    userId: "user-1",
    orgIds: ["organization-1"],
    source: "session",
    isInstanceAdmin: false,
    runId: null,
  },
  backgroundRuntime?: ChatBackgroundRuntime,
  registerNetworkWaitingRunHandler?: (handler: (run: any) => Promise<boolean>) => void,
) {
  const runtime = backgroundRuntime ?? createChatBackgroundRuntime();
  testBackgroundRuntimes.add(runtime);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    chatRoutes({} as any, mockStorage as any, runtime, registerNetworkWaitingRunHandler),
  );
  app.use(errorHandler);
  return app;
}

async function waitUntil(assertion: () => void, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError;
}

describe("chat routes", { retry: 2 }, () => {
  afterEach(async () => {
    await Promise.all([...testBackgroundRuntimes].map((runtime) => runtime.close()));
    testBackgroundRuntimes.clear();
    for (let index = 0; index < 3; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    clearActiveChatGenerationsForTest();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    clearActiveChatGenerationsForTest();
    mockCompanyService.getById.mockResolvedValue({
      id: "organization-1",
      defaultChatIssueCreationMode: "manual_approval",
    });
    mockAgentService.list.mockResolvedValue([
      { id: "agent-1", orgId: "organization-1", status: "idle" },
    ]);
    mockChatAssistantService.enrichConversation.mockImplementation(async (conversation) => conversation);
    mockChatAssistantService.enrichConversations.mockImplementation(async (conversations) => conversations);
    mockChatAgentRuns.linkAssistantMessage.mockResolvedValue(null);
    mockChatAgentRuns.finalizeRun.mockResolvedValue(null);
    mockChatSteerMessages.beginControlAction.mockImplementation((input) => (
      mockChatService.beginSteerControlAction(input)
    ));
    mockChatSteerMessages.scheduleContinuation.mockImplementation((input) => (
      mockChatService.scheduleSteerContinuation(input)
    ));
    mockChatWorkManifest.reconcileConversation.mockResolvedValue(undefined);
    mockChatWorkManifest.getConversationManifest.mockResolvedValue({
      conversationId: "chat-1",
      totalCount: 0,
      outputs: [],
      sources: [],
      references: [],
      project: null,
    });
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValue({
      available: true,
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      effort: null,
      error: null,
    });
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValue({
      available: true,
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      effort: null,
      error: null,
    });
    mockLogActivity.mockResolvedValue(undefined);
    mockSideChatService.assertAccessible.mockImplementation(async (conversation) => conversation);
    mockSideChatService.assertMutable.mockImplementation(async (conversation) => conversation);
    mockSideChatService.touch.mockImplementation(async (conversation) => conversation);
    mockHeartbeatService.wakeup.mockResolvedValue({ id: "wake-1" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAutomationService.create.mockResolvedValue({
      id: "automation-1",
      orgId: "organization-1",
      title: "每天中午 12 点发送 AI HOT 日报",
      description: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
      assigneeAgentId: "agent-1",
      projectId: null,
      goalId: null,
      parentIssueId: null,
      outputMode: "chat_output",
      chatConversationId: null,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
      createdByAgentId: "agent-1",
      createdByUserId: "user-1",
      updatedByAgentId: "agent-1",
      updatedByUserId: "user-1",
      lastTriggeredAt: null,
      lastEnqueuedAt: null,
      createdAt: new Date("2026-03-26T08:02:00.000Z"),
      updatedAt: new Date("2026-03-26T08:02:00.000Z"),
    });
    mockAutomationService.createTrigger.mockResolvedValue({
      trigger: {
        id: "trigger-1",
        orgId: "organization-1",
        automationId: "automation-1",
        kind: "schedule",
        label: "daily noon",
        enabled: true,
        cronExpression: "0 12 * * *",
        timezone: "Asia/Shanghai",
        nextRunAt: new Date("2026-03-27T04:00:00.000Z"),
        lastFiredAt: null,
        publicId: null,
        secretId: null,
        signingMode: null,
        replayWindowSec: null,
        lastRotatedAt: null,
        lastResult: null,
        createdByAgentId: "agent-1",
        createdByUserId: "user-1",
        updatedByAgentId: "agent-1",
        updatedByUserId: "user-1",
        createdAt: new Date("2026-03-26T08:02:00.000Z"),
        updatedAt: new Date("2026-03-26T08:02:00.000Z"),
      },
      secretMaterial: null,
    });
    mockIssueService.listLabels.mockResolvedValue([]);
    mockOperatorProfileService.get.mockResolvedValue({
      nickname: "Zee",
      moreAboutYou: "Prefers concise answers",
    });
    mockStorage.putFile.mockResolvedValue({
      provider: "local_disk",
      objectKey: "chats/chat-1/image.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256",
      originalFilename: "image.png",
    });
    mockStorage.deleteObject.mockResolvedValue(undefined);
    mockChatService.addUserChatMessage.mockImplementation(async (
      _cid: string,
      _orgId: string,
      body: string,
      _editUserMessageId?: string | null,
      options?: { structuredPayload?: Record<string, unknown> | null },
    ) => ({
      ...createMessage("message-user", "user", "message", body),
      structuredPayload: options?.structuredPayload ?? null,
    }));
    mockChatService.updateMessageStructuredPayload.mockImplementation(async (
      _conversationId: string,
      messageId: string,
      structuredPayload: Record<string, unknown> | null,
    ) => ({
      ...createMessage(messageId, "user", "message", ""),
      structuredPayload,
    }));
    mockChatInlineAnnotations.prepare.mockImplementation(async (input: {
      annotations: Array<Record<string, unknown>>;
    }) => ({
      annotations: input.annotations.map(({ attachmentFileIndexes: _ignored, ...annotation }) => annotation),
      attachmentFileIndexesByAnnotationId: new Map(
        input.annotations.map((annotation) => [
          annotation.id,
          Array.isArray(annotation.attachmentFileIndexes)
            ? annotation.attachmentFileIndexes
            : [],
        ]),
      ),
    }));
    mockChatService.updateMessage.mockImplementation(async (_conversationId: string, messageId: string, input: Record<string, unknown>) => ({
      ...createMessage(
        messageId,
        "assistant",
        typeof input.kind === "string" ? input.kind : "message",
        typeof input.body === "string" ? input.body : "",
      ),
      status: typeof input.status === "string" ? input.status : "completed",
      structuredPayload: input.structuredPayload ?? null,
      transcript: Array.isArray(input.transcript) ? input.transcript : [],
      replyingAgentId: typeof input.replyingAgentId === "string" ? input.replyingAgentId : null,
    }));
    mockChatService.updateMessageInternalInlineVisuals.mockImplementation(async (
      _conversationId: string,
      messageId: string,
      input: Record<string, unknown>,
    ) => ({
      ...createMessage(messageId, "assistant", "message", ""),
      structuredPayload: input,
    }));
    mockChatService.markInterruptedStreamingMessages.mockResolvedValue([]);
    mockChatService.getQueueSnapshot.mockResolvedValue({
      activeGenerationId: null,
      activeAttemptEpoch: null,
      activeControlVersion: null,
      activeGenerationStatus: null,
      items: [],
    });
    mockChatService.getQueuedMessageReplay.mockResolvedValue(null);
    mockChatService.getUserMessageByClientMutationId.mockResolvedValue(null);
    mockChatService.createQueuedMessage.mockImplementation(async (input: Record<string, unknown>) => ({
      id: "queued-1",
      orgId: input.orgId,
      conversationId: input.conversationId,
      position: 1,
      status: "queued",
      version: 1,
      clientMutationId: input.clientMutationId,
      payload: input.payload,
      deliveryIntent: "queue",
      deliveryDisposition: null,
      controlActionId: null,
      expectedGenerationId: input.expectedGenerationId ?? null,
      activeGenerationId: null,
      attemptEpoch: null,
      providerClientMessageId: null,
      providerThreadId: null,
      providerTurnId: null,
      providerEvidence: null,
      continuationGenerationId: null,
      continuationMessageId: null,
      deliveryLeaseToken: null,
      deliveryLeaseEpoch: 0,
      deliveryLeaseOwner: null,
      deliveryLeaseExpiresAt: null,
      reconciliationReason: null,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastDeliveryReason: null,
      sourceMessageId: null,
      deliveredMessageId: null,
      cancelledAt: null,
      steeredAt: null,
      dequeuedAt: null,
      createdAt: new Date("2026-03-26T08:02:00.000Z"),
      updatedAt: new Date("2026-03-26T08:02:00.000Z"),
    }));
    mockChatService.createQueuedMessageWithStagedAttachments.mockImplementation(
      async (input: Record<string, unknown>) => ({
        item: await mockChatService.createQueuedMessage(input),
        accepted: true,
        cleanupAttachments: [],
      }),
    );
    mockChatService.updateQueuedMessage.mockImplementation(async (_chatId: string, itemId: string, input: Record<string, unknown>) => ({
      id: itemId,
      orgId: "organization-1",
      conversationId: "chat-1",
      position: 1,
      status: "queued",
      version: Number(input.version ?? 1) + 1,
      clientMutationId: "client-1",
      payload: input.payload,
      deliveryIntent: "queue",
      deliveryDisposition: null,
      controlActionId: null,
      expectedGenerationId: null,
      activeGenerationId: null,
      attemptEpoch: null,
      providerClientMessageId: null,
      providerThreadId: null,
      providerTurnId: null,
      providerEvidence: null,
      continuationGenerationId: null,
      continuationMessageId: null,
      deliveryLeaseToken: null,
      deliveryLeaseEpoch: 0,
      deliveryLeaseOwner: null,
      deliveryLeaseExpiresAt: null,
      reconciliationReason: null,
      deliveryAttempts: 0,
      lastAttemptAt: null,
      lastDeliveryReason: null,
      sourceMessageId: null,
      deliveredMessageId: null,
      cancelledAt: null,
      steeredAt: null,
      dequeuedAt: null,
      createdAt: new Date("2026-03-26T08:02:00.000Z"),
      updatedAt: new Date("2026-03-26T08:03:00.000Z"),
    }));
    mockChatService.updateQueuedMessageWithStagedAttachments.mockImplementation(
      async (input: Record<string, unknown>) => ({
        item: await mockChatService.updateQueuedMessage(
          input.conversationId,
          input.itemId,
          input,
        ),
        cleanupAttachments: [],
      }),
    );
    mockChatService.cancelQueuedMessage.mockResolvedValue(null);
    mockChatService.cancelQueuedMessageWithStagedAttachments.mockResolvedValue({
      item: null,
      cleanupAttachments: [],
    });
    mockChatService.finalizeQueuedAnnotationAssetCleanup.mockResolvedValue([]);
    mockChatService.markQueuedMessageSteerFallback.mockResolvedValue({
      id: "queued-1",
      status: "queued",
      lastDeliveryReason: "unsupported",
    });
    mockChatService.claimSteerProviderSend.mockResolvedValue(null);
    mockChatService.releaseSteerProviderSendClaim.mockResolvedValue({ id: "control-action-1" });
    mockChatService.appendGenerationEvent.mockResolvedValue({ id: "event-1" });
    mockChatService.beginGenerationControlAttempt.mockResolvedValue(undefined);
    mockChatService.markGenerationControlReady.mockResolvedValue(undefined);
    mockChatService.renewGenerationControlLease.mockResolvedValue(true);
    mockChatService.markGenerationControlAttemptCompleted.mockResolvedValue(undefined);
    mockChatService.claimNextServerQueuedMessage.mockResolvedValue(null);
    mockChatService.renewServerQueuedMessageClaim.mockResolvedValue(true);
    mockChatService.acknowledgeServerQueuedMessageDelivery.mockResolvedValue(null);
    mockChatService.completeServerQueuedMessageDelivery.mockResolvedValue(null);
    mockChatService.releaseServerQueuedMessageClaim.mockResolvedValue(null);
    mockChatService.recoverExpiredServerQueueClaims.mockResolvedValue({ inspected: 0, requeued: 0, ambiguous: 0 });
    mockChatService.claimNextQueuedMessage.mockResolvedValue(null);
    mockChatService.releaseQueuedMessageClaim.mockResolvedValue(null);
    mockChatService.createGeneration.mockResolvedValue({ id: "generation-1" });
    mockChatService.markGenerationTerminal.mockResolvedValue(undefined);
    mockChatService.getLatestActiveGeneration.mockResolvedValue(null);
    mockChatService.assertQueuedMessageClaimedForDelivery.mockResolvedValue(undefined);
    mockChatService.markQueuedMessageRunning.mockResolvedValue(undefined);
    mockChatService.markQueuedMessageDeliveryTerminal.mockResolvedValue(undefined);
    mockChatService.generationProtocol.appendGenerationEvent.mockImplementation(async (input) => ({
      event: { id: "generation-event-1", generationSeq: 1, payload: input.payload ?? {} },
      generation: { id: input.generationId },
    }));
    mockChatService.generationProtocol.appendVisibleEventAndProject.mockImplementation(async (input) => ({
      event: {
        id: "generation-event-1",
        generationSeq: 1,
        payload: { ...(input.payload ?? {}), bodyHash: input.bodyHash },
      },
      generation: { id: input.generationId },
      message: { id: input.messageId ?? "message-assistant" },
    }));
    mockChatService.generationProtocol.projectVisibleMessage.mockResolvedValue({
      generation: { id: "generation-1" },
      message: { id: "message-progress" },
      projected: true,
    });
    mockChatService.generationProtocol.getFrozenVisibleProjection.mockResolvedValue(null);
    mockChatService.generationProtocol.getLatestVisibleCheckpoint.mockResolvedValue({
      generation: { id: "generation-1", attemptEpoch: 1, controlVersion: 0 },
      generationSeq: 0,
      bodyHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
    mockChatService.generationProtocol.beginStopAction.mockImplementation(async (input) => ({
      action: {
        id: input.controlActionId,
        acceptedThroughSeq: input.requestedRenderSeq,
        frozenBodyHash: input.requestedBodyHash,
      },
      generation: {
        id: input.expectedGenerationId,
        attemptEpoch: input.expectedAttemptEpoch,
        controlVersion: input.expectedControlVersion + 1,
      },
      stopRequestedEvent: { id: "stop-requested-event" },
      outputCutoffEvent: { id: "output-cutoff-event" },
      idempotent: false,
    }));
    mockChatService.generationProtocol.recordRuntimeTerminal.mockResolvedValue({
      outbox: { id: "terminal-outbox-1" },
    });
    mockChatService.generationProtocol.claimTerminalProjection.mockResolvedValue(null);
    mockChatService.generationProtocol.completeTerminalProjection.mockResolvedValue(null);
    mockChatService.generationProtocol.retryTerminalProjection.mockResolvedValue(null);
    mockChatService.generationProtocol.recoverStaleControlOwners.mockResolvedValue([]);
    mockChatService.assetHasAttachments.mockResolvedValue(false);
  });

  it("resolves a typed short chat reference within the actor organization scope", async () => {
    const conversationId = "14ff96a7-2518-456a-8aae-480360f0d9aa";
    const conversation = createConversation({ id: conversationId, shortRef: "cht_14ff96a7" });
    mockChatService.resolveByReference.mockResolvedValue({ conversation, ambiguous: false });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatAssistantService.enrichConversation.mockResolvedValue(conversation);

    const res = await request(createApp()).get("/api/chats/cht_14ff96a7");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: conversationId, shortRef: "cht_14ff96a7" });
    expect(mockChatService.resolveByReference).toHaveBeenCalledWith("cht_14ff96a7", ["organization-1"]);
    expect(mockChatService.getById).toHaveBeenCalledWith(conversationId);
  });

  it("rejects an ambiguous typed short chat reference", async () => {
    mockChatService.resolveByReference.mockResolvedValue({ conversation: null, ambiguous: true });

    const res = await request(createApp()).get("/api/chats/cht_14ff96a7");

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("ambiguous");
    expect(mockChatService.getById).not.toHaveBeenCalled();
  });

  it("passes chat search query and status to the chat list service", async () => {
    mockChatService.list.mockResolvedValue([createConversation({ title: "Searchable chat" })]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/chats")
      .query({ status: "all", q: "launch notes", limit: "20" });

    expect(res.status).toBe(200);
    expect(mockChatService.list).toHaveBeenCalledWith(
      "organization-1",
      { status: "all", q: "launch notes", limit: 20 },
      "user-1",
    );
    expect(mockChatAssistantService.enrichConversations).toHaveBeenCalled();
  });

  it("passes a trimmed project filter to the chat list service", async () => {
    mockChatService.list.mockResolvedValue([createConversation({ title: "Project chat" })]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/chats")
      .query({ projectId: " project-1 ", limit: "40" });

    expect(res.status).toBe(200);
    expect(mockChatService.list).toHaveBeenCalledWith(
      "organization-1",
      { status: "active", q: undefined, limit: 40, projectId: "project-1" },
      "user-1",
    );
  });

  it("returns the reconciled work manifest for an accessible chat", async () => {
    mockChatService.getById.mockResolvedValue(createConversation());
    mockChatWorkManifest.getConversationManifest.mockResolvedValue({
      conversationId: "chat-1",
      totalCount: 1,
      outputs: [{ id: "manifest-1", category: "output", title: "report.md" }],
      sources: [],
      references: [],
      project: { id: "project-1", totalCount: 3 },
    });

    const res = await request(createApp()).get("/api/chats/chat-1/work-manifest");

    expect(res.status).toBe(200);
    expect(mockChatWorkManifest.reconcileConversation).toHaveBeenCalledWith("chat-1");
    expect(mockChatWorkManifest.getConversationManifest).toHaveBeenCalledWith("chat-1");
    expect(res.body).toMatchObject({
      conversationId: "chat-1",
      totalCount: 1,
      project: { id: "project-1", totalCount: 3 },
    });
  });

  it("keeps a server-owned queued message retryable when runtime boot fails before a control handle is registered", async () => {
    const previousWorkerFlag = process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
    process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = "true";
    const backgroundRuntime = createChatBackgroundRuntime();
    const conversation = createConversation();
    const queuedUserMessage = createMessage("queued-user-message", "user", "message", "Retry after runtime boot failure");
    const claim = {
      item: {
        id: "queued-1",
        conversationId: conversation.id,
        orgId: conversation.orgId,
        runtimeSnapshotVersion: null,
        payload: {
          body: queuedUserMessage.body,
          model: "legacy-client-forged-model",
          effort: null,
        },
        requestActor: {
          type: "board",
          source: "session",
          userId: "user-1",
          orgIds: [conversation.orgId],
          isInstanceAdmin: false,
        },
      },
      generationId: "queued-generation-1",
      userMessageId: queuedUserMessage.id,
      leaseToken: "queued-delivery-lease",
      leaseEpoch: 1,
    };
    try {
      mockChatService.getById.mockResolvedValue(conversation);
      mockChatService.getMessage.mockResolvedValue(queuedUserMessage);
      mockChatService.listMessages.mockResolvedValue([queuedUserMessage]);
      mockChatService.claimNextServerQueuedMessage
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null);
      mockChatService.releaseServerQueuedMessageClaim.mockResolvedValue({
        id: claim.item.id,
        status: "failed_actionable",
      });
      mockChatService.getLatestGeneration.mockResolvedValue({
        id: claim.generationId,
        attemptEpoch: 1,
        controlOwnerToken: claim.leaseToken,
      });
      mockChatAssistantService.streamChatAssistantReply.mockRejectedValue(new Error("runtime boot rejected"));

      const res = await request(createApp(undefined as any, backgroundRuntime))
        .post(`/api/chats/${conversation.id}/queue`)
        .send({
          clientMutationId: "queue-runtime-boot-failure",
          payload: { body: queuedUserMessage.body },
        });

      expect(res.status).toBe(201);
      await waitUntil(() => {
        expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledOnce();
        expect(mockChatService.releaseServerQueuedMessageClaim).toHaveBeenCalledWith(expect.objectContaining({
          itemId: claim.item.id,
          generationId: claim.generationId,
        }));
        expect(hasActiveChatGeneration(conversation.id)).toBe(false);
      });
      const legacyInvocation = mockChatAssistantService.streamChatAssistantReply.mock.calls[0]?.[0];
      expect(legacyInvocation).not.toHaveProperty("modelSnapshot");
      expect(legacyInvocation).not.toHaveProperty("effortSnapshot");
      expect(mockChatService.acknowledgeServerQueuedMessageDelivery).not.toHaveBeenCalled();
    } finally {
      if (previousWorkerFlag === undefined) delete process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
      else process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = previousWorkerFlag;
      await backgroundRuntime.close();
    }
  });

  it("acknowledges a server-owned queued message at control-handle registration before a later runtime failure", async () => {
    const previousWorkerFlag = process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
    process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = "true";
    const backgroundRuntime = createChatBackgroundRuntime();
    const conversation = createConversation();
    const queuedUserMessage = createMessage("queued-user-message", "user", "message", "Persist this before the runtime fails");
    const claim = {
      item: {
        id: "queued-1",
        conversationId: conversation.id,
        orgId: conversation.orgId,
        requestActor: {
          type: "board",
          source: "session",
          userId: "user-1",
          orgIds: [conversation.orgId],
          isInstanceAdmin: false,
        },
      },
      generationId: "queued-generation-1",
      userMessageId: queuedUserMessage.id,
      leaseToken: "queued-delivery-lease",
      leaseEpoch: 1,
    };
    try {
      mockChatService.getById.mockResolvedValue(conversation);
      mockChatService.getMessage.mockResolvedValue(queuedUserMessage);
      mockChatService.listMessages.mockResolvedValue([queuedUserMessage]);
      mockChatService.claimNextServerQueuedMessage
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null);
      mockChatService.acknowledgeServerQueuedMessageDelivery.mockResolvedValue({
        id: claim.item.id,
        status: "completed",
      });
      mockChatService.getLatestGeneration.mockResolvedValue({
        id: claim.generationId,
        attemptEpoch: 1,
        controlOwnerToken: claim.leaseToken,
      });
      mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
        const attempt = await input.controlCoordinator.beginAttempt({
          attemptIndex: 0,
          runtimeType: "codex_local",
          model: null,
          isFallback: false,
        });
        await attempt.register({
          runtimeType: "codex_local",
          capabilities: { steer: "native", interrupt: "process" },
          steer: async () => ({ disposition: "closing" }),
          interrupt: async () => ({ disposition: "interrupted" }),
          dispose: async () => undefined,
        });
        await attempt.complete();
        throw new Error("runtime failed after accepting the queued user message");
      });

      const res = await request(createApp(undefined as any, backgroundRuntime))
        .post(`/api/chats/${conversation.id}/queue`)
        .send({
          clientMutationId: "queue-runtime-accepted-then-failed",
          payload: { body: queuedUserMessage.body },
        });

      expect(res.status).toBe(201);
      await waitUntil(() => {
        expect(mockChatService.acknowledgeServerQueuedMessageDelivery).toHaveBeenCalledWith({
          itemId: claim.item.id,
          generationId: claim.generationId,
          leaseToken: claim.leaseToken,
          leaseEpoch: claim.leaseEpoch,
        });
        expect(hasActiveChatGeneration(conversation.id)).toBe(false);
      });
      expect(mockChatService.releaseServerQueuedMessageClaim).not.toHaveBeenCalled();
      expect(mockChatService.completeServerQueuedMessageDelivery).not.toHaveBeenCalled();
    } finally {
      if (previousWorkerFlag === undefined) delete process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
      else process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = previousWorkerFlag;
      await backgroundRuntime.close();
    }
  });

  it("does not abort an acknowledged queued continuation when an in-flight lease renewal rejects", async () => {
    const previousWorkerFlag = process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
    process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = "true";
    const intervalTasks: Array<() => void | Promise<void>> = [];
    const backgroundRuntime = {
      acceptingWork: true,
      setTimeout: (task: () => void | Promise<void>) => {
        void Promise.resolve().then(task);
        return {} as ReturnType<typeof setTimeout>;
      },
      setInterval: (task: () => void | Promise<void>) => {
        intervalTasks.push(task);
        return {} as ReturnType<typeof setTimeout>;
      },
      clearTimer: vi.fn(),
      createCoalescingTask: (task: () => Promise<void>, onError: (error: unknown) => void) => ({
        wake: () => void Promise.resolve().then(task).catch(onError),
      }),
      track: <T,>(work: Promise<T>) => work,
      manageAbortController: () => ({ controller: new AbortController(), release: vi.fn() }),
      close: async () => undefined,
    };
    const conversation = createConversation();
    const queuedUserMessage = createMessage("queued-user-message", "user", "message", "Keep the runtime alive after acknowledgement");
    const claim = {
      item: {
        id: "queued-1",
        conversationId: conversation.id,
        orgId: conversation.orgId,
        requestActor: {
          type: "board",
          source: "session",
          userId: "user-1",
          orgIds: [conversation.orgId],
          isInstanceAdmin: false,
        },
      },
      generationId: "queued-generation-1",
      userMessageId: queuedUserMessage.id,
      leaseToken: "queued-delivery-lease",
      leaseEpoch: 1,
    };
    let beginAttempt!: () => void;
    const attemptStarted = new Promise<void>((resolve) => { beginAttempt = resolve; });
    let allowRegistration!: () => void;
    const registrationAllowed = new Promise<void>((resolve) => { allowRegistration = resolve; });
    let rejectRenewal!: (error: Error) => void;
    const renewal = new Promise<boolean>((_resolve, reject) => { rejectRenewal = reject; });
    let capturedAbortSignal: AbortSignal | null = null;
    try {
      mockChatService.getById.mockResolvedValue(conversation);
      mockChatService.getMessage.mockResolvedValue(queuedUserMessage);
      mockChatService.listMessages.mockResolvedValue([queuedUserMessage]);
      mockChatService.claimNextServerQueuedMessage
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null);
      mockChatService.acknowledgeServerQueuedMessageDelivery.mockResolvedValue({
        id: claim.item.id,
        status: "completed",
      });
      mockChatService.getLatestGeneration.mockResolvedValue({
        id: claim.generationId,
        attemptEpoch: 1,
        controlOwnerToken: claim.leaseToken,
      });
      mockChatService.renewServerQueuedMessageClaim.mockImplementation(() => renewal);
      mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
        capturedAbortSignal = input.abortSignal ?? null;
        const attempt = await input.controlCoordinator.beginAttempt({
          attemptIndex: 0,
          runtimeType: "codex_local",
          model: null,
          isFallback: false,
        });
        beginAttempt();
        await registrationAllowed;
        await attempt.register({
          runtimeType: "codex_local",
          capabilities: { steer: "native", interrupt: "process" },
          steer: async () => ({ disposition: "closing" }),
          interrupt: async () => ({ disposition: "interrupted" }),
          dispose: async () => undefined,
        });
        await attempt.complete();
        throw new Error("finish after renewal race assertion");
      });

      const res = await request(createApp(undefined as any, backgroundRuntime)).post(`/api/chats/${conversation.id}/queue`).send({
        clientMutationId: "queue-acknowledgement-renewal-race",
        payload: { body: queuedUserMessage.body },
      });

      expect(res.status).toBe(201);
      await attemptStarted;
      void intervalTasks.at(-1)!();
      await waitUntil(() => {
        expect(mockChatService.renewServerQueuedMessageClaim).toHaveBeenCalledOnce();
      });
      allowRegistration();
      await waitUntil(() => {
        expect(mockChatService.acknowledgeServerQueuedMessageDelivery).toHaveBeenCalledOnce();
      });
      rejectRenewal(new Error("lease renewal failed after acknowledgement"));
      await Promise.resolve();
      await Promise.resolve();

      expect(capturedAbortSignal?.aborted).toBe(false);
      await waitUntil(() => {
        expect(hasActiveChatGeneration(conversation.id)).toBe(false);
      });
    } finally {
      if (previousWorkerFlag === undefined) delete process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
      else process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = previousWorkerFlag;
    }
  });

  it("returns 404 for a missing chat work manifest", async () => {
    mockChatService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/chats/missing/work-manifest");

    expect(res.status).toBe(404);
    expect(mockChatWorkManifest.reconcileConversation).not.toHaveBeenCalled();
  });

  it("updates chat unread state through the user-state endpoint", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.markUnread.mockResolvedValue({});

    const res = await request(createApp())
      .post("/api/chats/chat-1/user-state")
      .send({ unread: true });

    expect(res.status).toBe(200);
    expect(mockChatService.markUnread).toHaveBeenCalledWith("chat-1", "organization-1", "user-1");
    expect(mockChatService.markRead).not.toHaveBeenCalled();
    expect(res.body.id).toBe("chat-1");
  });

  it("deletes a chat conversation and logs the activity", async () => {
    const conversation = createConversation({ title: "Delete me" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listAttachmentsForConversation.mockResolvedValue([
      {
        id: "attachment-1",
        orgId: "organization-1",
        assetId: "asset-1",
        objectKey: "orgs/organization-1/chats/chat-1/image.png",
      },
    ]);
    mockChatService.remove.mockResolvedValue(conversation);

    const res = await request(createApp())
      .delete("/api/chats/chat-1");

    expect(res.status).toBe(200);
    expect(mockChatService.listAttachmentsForConversation).toHaveBeenCalledWith("chat-1");
    expect(mockChatService.remove).toHaveBeenCalledWith("chat-1");
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      "organization-1",
      "orgs/organization-1/chats/chat-1/image.png",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "organization-1",
      action: "chat.deleted",
      entityType: "chat",
      entityId: "chat-1",
      details: { title: "Delete me" },
    }));
  });

  it("keeps a shared fork asset object while another conversation still references it", async () => {
    const conversation = createConversation({ title: "Delete source" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listAttachmentsForConversation.mockResolvedValue([{
      id: "attachment-source",
      orgId: "organization-1",
      assetId: "asset-shared",
      objectKey: "orgs/organization-1/chats/chat-1/visual.html",
    }]);
    mockChatService.remove.mockResolvedValue(conversation);
    mockChatService.assetHasAttachments.mockResolvedValueOnce(true);

    const res = await request(createApp()).delete("/api/chats/chat-1");

    expect(res.status).toBe(200);
    expect(mockChatService.assetHasAttachments).toHaveBeenCalledWith("asset-shared");
    expect(mockStorage.deleteObject).not.toHaveBeenCalled();
  });

  it("requires board access to delete a chat conversation", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: null,
    }))
      .delete("/api/chats/chat-1");

    expect(res.status).toBe(403);
    expect(mockChatService.getById).not.toHaveBeenCalled();
    expect(mockChatService.remove).not.toHaveBeenCalled();
  });

  it("rejects deleting a chat conversation while a reply is in progress", async () => {
    const conversation = createConversation({ title: "Generating chat" });
    mockChatService.getById.mockResolvedValue(conversation);
    const release = claimChatGeneration(conversation.id);

    try {
      const res = await request(createApp())
        .delete("/api/chats/chat-1");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Cannot delete a chat while a reply is in progress");
      expect(mockChatService.listAttachmentsForConversation).not.toHaveBeenCalled();
      expect(mockChatService.remove).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("rejects deleting Feishu-bound chat conversations", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .delete("/api/chats/chat-1");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Fork this Feishu chat to continue in Rudder");
    expect(mockChatService.listAttachmentsForConversation).not.toHaveBeenCalled();
    expect(mockChatService.remove).not.toHaveBeenCalled();
  });

  it("allows passive user-state updates for Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    mockChatService.getById.mockResolvedValueOnce(conversation).mockResolvedValueOnce({
      ...conversation,
      isPinned: true,
    });
    mockChatService.setPinned.mockResolvedValue({});

    const res = await request(createApp())
      .post("/api/chats/chat-1/user-state")
      .send({ pinned: true });

    expect(res.status).toBe(200);
    expect(mockChatService.setPinned).toHaveBeenCalledWith("chat-1", "organization-1", "user-1", true);
  });

  it("creates an owner-scoped hidden Side Chat from an assistant message", async () => {
    const sourceMessageId = "10000000-0000-4000-8000-000000000010";
    const clientMutationId = "side-chat-create-1";
    const preferredAgentId = "20000000-0000-4000-8000-000000000020";
    const sourceConversation = createConversation({ id: "chat-source", title: "Original topic" });
    const sideConversation = createConversation({
      id: "chat-side",
      title: "Side Chat",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      sideChatExpiresAt: new Date("2026-03-26T10:00:00.000Z"),
      sideChatClientMutationId: clientMutationId,
      forkedFromConversationId: "chat-source",
      forkedFromMessageId: sourceMessageId,
      forkRootConversationId: "chat-source",
    });
    mockChatService.getById.mockResolvedValue(sourceConversation);
    mockAgentService.getById.mockResolvedValue({
      id: preferredAgentId,
      orgId: "organization-1",
      status: "idle",
    });
    mockSideChatService.create.mockResolvedValue(sideConversation);

    const res = await request(createApp())
      .post("/api/chats/chat-source/side-chats")
      .send({
        sourceMessageId,
        clientMutationId,
        preferredAgentId,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: "chat-side",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
    });
    expect(mockSideChatService.create).toHaveBeenCalledWith({
      sourceConversationId: "chat-source",
      sourceMessageId,
      clientMutationId,
      orgId: "organization-1",
      userId: "user-1",
      preferredAgentId,
    });
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith({
      orgId: "organization-1",
      preferredAgentId,
      modelOverride: null,
      effortOverride: null,
      contextLinks: [],
      planMode: false,
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.side_chat_created",
      entityId: "chat-side",
      orgId: "organization-1",
      idempotencyKey: "chat.side_chat_created:chat-side",
    }));
  });

  it("destroys an unkept Side Chat when its tab is closed", async () => {
    const sideConversation = createConversation({
      id: "chat-side",
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
    });
    mockChatService.getById.mockResolvedValue(sideConversation);
    mockChatService.listAttachmentsForConversation.mockResolvedValue([]);
    mockSideChatService.destroy.mockResolvedValue({ id: "chat-side" });

    const res = await request(createApp())
      .delete("/api/chats/chat-side/side-chat");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "chat-side" });
    expect(mockSideChatService.destroy).toHaveBeenCalledWith({
      conversationId: "chat-side",
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.side_chat_destroyed",
      entityId: "chat-side",
    }));

    const legacyComplete = await request(createApp())
      .post("/api/chats/chat-side/side-chat/complete")
      .send({});
    expect(legacyComplete.status).toBe(404);
  });

  it("keeps a Side Chat in Messenger without changing its conversation id", async () => {
    const sideConversation = createConversation({
      id: "chat-side",
      conversationKind: "side_chat",
      messengerVisible: true,
      sideChatState: "kept",
      sideChatKeptAt: new Date("2026-03-26T08:30:00.000Z"),
    });
    mockChatService.getById.mockResolvedValue(sideConversation);
    mockSideChatService.keepInMessenger.mockResolvedValue(sideConversation);

    const res = await request(createApp())
      .post("/api/chats/chat-side/side-chat/keep")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "chat-side",
      messengerVisible: true,
      sideChatState: "kept",
    });
    expect(mockSideChatService.keepInMessenger).toHaveBeenCalledWith({
      conversationId: "chat-side",
      userId: "user-1",
    });
  });

  it("omits hidden Side Chats from the ordinary organization chat list", async () => {
    mockChatService.list.mockResolvedValue([
      createConversation({ id: "chat-visible" }),
      createConversation({
        id: "chat-side",
        conversationKind: "side_chat",
        messengerVisible: false,
        sideChatState: "active",
      }),
    ]);

    const res = await request(createApp()).get("/api/orgs/organization-1/chats");

    expect(res.status).toBe(200);
    expect(res.body.map((conversation: { id: string }) => conversation.id)).toEqual(["chat-visible"]);
  });

  it("forks a chat conversation from a selected message and logs the activity", async () => {
    const sourceMessageId = "10000000-0000-4000-8000-000000000010";
    const sourceConversation = createConversation({
      id: "chat-source",
      title: "Original topic",
    });
    const childConversation = createConversation({
      id: "chat-child",
      title: "Alternative angle",
      forkedFromConversationId: "chat-source",
      forkedFromMessageId: sourceMessageId,
      forkRootConversationId: "chat-source",
    });
    mockChatService.getById.mockResolvedValue(sourceConversation);
    mockChatService.forkConversation.mockResolvedValue(childConversation);

    const res = await request(createApp())
      .post("/api/chats/chat-source/fork")
      .send({ sourceMessageId, title: "Alternative angle" });

    expect(res.status).toBe(201);
    expect(mockChatService.forkConversation).toHaveBeenCalledWith({
      sourceConversationId: "chat-source",
      orgId: "organization-1",
      userId: "user-1",
      sourceMessageId,
      title: "Alternative angle",
      createdByUserId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "organization-1",
      action: "chat.forked",
      entityType: "chat",
      entityId: "chat-child",
      details: {
        sourceConversationId: "chat-source",
        sourceMessageId,
        forkRootConversationId: "chat-source",
      },
    }));
    expect(res.body).toEqual(expect.objectContaining({
      id: "chat-child",
      forkedFromConversationId: "chat-source",
      forkedFromMessageId: sourceMessageId,
      forkRootConversationId: "chat-source",
    }));
  });

  it("does not log a fork when annotation lineage falls outside the copied range", async () => {
    const sourceMessageId = "10000000-0000-4000-8000-000000000010";
    const sourceConversation = createConversation({
      id: "chat-source",
      title: "Corrupted annotation fork",
    });
    mockChatService.getById.mockResolvedValue(sourceConversation);
    mockChatService.forkConversation.mockRejectedValue(
      unprocessable("Fork annotation source message falls outside the copied range"),
    );

    const res = await request(createApp())
      .post("/api/chats/chat-source/fork")
      .send({ sourceMessageId });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("outside the copied range");
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "chat.forked" }),
    );
  });

  it("requires board access to fork a chat conversation", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: null,
    }))
      .post("/api/chats/chat-1/fork")
      .send({});

    expect(res.status).toBe(403);
    expect(mockChatService.getById).not.toHaveBeenCalled();
    expect(mockChatService.forkConversation).not.toHaveBeenCalled();
  });

  it("rejects forking a chat while a reply is in progress", async () => {
    const conversation = createConversation({ title: "Generating chat" });
    mockChatService.getById.mockResolvedValue(conversation);
    const release = claimChatGeneration(conversation.id);

    try {
      const res = await request(createApp())
        .post("/api/chats/chat-1/fork")
        .send({});

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Cannot fork a chat while a reply is in progress");
      expect(mockChatService.forkConversation).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("forks from a selected message while later reply generation is in progress", async () => {
    const sourceMessageId = "10000000-0000-4000-8000-000000000011";
    const sourceConversation = createConversation({
      id: "chat-source",
      title: "Generating chat",
    });
    const childConversation = createConversation({
      id: "chat-child",
      title: "Alternative angle",
      forkedFromConversationId: "chat-source",
      forkedFromMessageId: sourceMessageId,
      forkRootConversationId: "chat-source",
    });
    mockChatService.getById.mockResolvedValue(sourceConversation);
    mockChatService.forkConversation.mockResolvedValue(childConversation);
    const release = claimChatGeneration(sourceConversation.id);

    try {
      const res = await request(createApp())
        .post("/api/chats/chat-source/fork")
        .send({ sourceMessageId, title: "Alternative angle" });

      expect(res.status).toBe(201);
      expect(mockChatService.forkConversation).toHaveBeenCalledWith({
        sourceConversationId: "chat-source",
        orgId: "organization-1",
        userId: "user-1",
        sourceMessageId,
        title: "Alternative angle",
        createdByUserId: "user-1",
      });
      expect(res.body).toEqual(expect.objectContaining({
        id: "chat-child",
        forkedFromConversationId: "chat-source",
        forkedFromMessageId: sourceMessageId,
        forkRootConversationId: "chat-source",
      }));
    } finally {
      release?.();
    }
  });

  it("cancels and deletes an active chat conversation when explicitly requested", async () => {
    const conversation = createConversation({ title: "Generating chat" });
    const abortController = new AbortController();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listAttachmentsForConversation.mockResolvedValue([]);
    mockChatService.remove.mockResolvedValue(conversation);
    const release = claimChatGeneration(conversation.id, abortController);

    try {
      const res = await request(createApp())
        .delete("/api/chats/chat-1?cancelActive=true");

      expect(res.status).toBe(200);
      expect(abortController.signal.aborted).toBe(true);
      expect(hasActiveChatGeneration(conversation.id)).toBe(false);
      expect(mockChatService.listAttachmentsForConversation).toHaveBeenCalledWith("chat-1");
      expect(mockChatService.remove).toHaveBeenCalledWith("chat-1");
    } finally {
      release?.();
    }
  });

  it("creates a conversation with the organization default agent and issue creation mode", async () => {
    const conversation = createConversation({ title: "Start with evidence" });
    const message = createMessage("message-first", "user", "message", "Start with evidence");
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message });
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "\"Evidence-first kickoff\"",
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ initialMessage: { body: "Start with evidence" } });

    expect(res.status).toBe(201);
    expect(mockChatService.createWithInitialMessage).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        preferredAgentId: "agent-1",
        issueCreationMode: "manual_approval",
        planMode: false,
        contextLinks: [],
        initialMessage: expect.objectContaining({ role: "user", body: "Start with evidence" }),
      }),
    );
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "organization-1",
        purpose: "lightweight",
        feature: "chat_title",
        prompt: expect.stringContaining("Start with evidence"),
      }));
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith(
        "chat-1",
        "Start with evidence",
        "Start with evidence",
      );
      expect(mockChatService.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
        "chat-1",
        "Start with evidence",
        "Evidence-first kickoff",
      );
    });
  });

  it("preserves an explicit title during atomic chat creation", async () => {
    const conversation = createConversation({ title: "Operator title" });
    const message = createMessage("message-first", "user", "message", "Start with evidence");
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({
        title: "Operator title",
        initialMessage: { body: "Start with evidence" },
      });

    expect(res.status).toBe(201);
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.updateDefaultTitle).not.toHaveBeenCalled();
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("rejects direct chat creation without an initial message", async () => {
    const res = await request(createApp()).post("/api/orgs/organization-1/chats").send({});
    expect(res.status).toBe(400);
    expect(mockChatService.createWithInitialMessage).not.toHaveBeenCalled();
  });

  it("preflights a draft without creating a conversation", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000001";
    const unavailable = { available: false, sourceType: "agent", sourceLabel: "Unsupported agent", runtimeAgentId: preferredAgentId, agentRuntimeType: "process", model: null, error: "The current user has not configured a chat model yet." };
    mockAgentService.getById.mockResolvedValue({ id: preferredAgentId, orgId: "organization-1", status: "idle" });
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValue(unavailable);
    const res = await request(createApp()).post("/api/orgs/organization-1/chats/preflight").send({
      preferredAgentId,
      modelOverride: "gpt-5.6-terra",
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(unavailable);
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAgentId, modelOverride: "gpt-5.6-terra" }),
    );
    expect(mockChatService.createWithInitialMessage).not.toHaveBeenCalled();
  });

  it("accepts same-organization Goal context during Chat draft preflight", async () => {
    const goalId = "10000000-0000-4000-8000-000000000009";
    mockGoalService.getById.mockResolvedValue({ id: goalId, orgId: "organization-1" });

    const res = await request(createApp()).post("/api/orgs/organization-1/chats/preflight").send({
      contextLinks: [{ entityType: "goal", entityId: goalId }],
    });

    expect(res.status).toBe(200);
    expect(mockGoalService.getById).toHaveBeenCalledWith(goalId);
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "organization-1",
        contextLinks: [{ entityType: "goal", entityId: goalId }],
      }),
    );
  });

  it("rejects cross-organization Goal context before Chat persistence", async () => {
    const goalId = "10000000-0000-4000-8000-000000000010";
    mockGoalService.getById.mockResolvedValue({ id: goalId, orgId: "organization-2" });

    const res = await request(createApp()).post("/api/orgs/organization-1/chats/preflight").send({
      contextLinks: [{ entityType: "goal", entityId: goalId }],
    });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Goal context must belong to the same organization" });
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatService.createWithInitialMessage).not.toHaveBeenCalled();
  });

  it("rejects an unavailable first turn before persistence", async () => {
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValue({ available: false, sourceType: "agent", sourceLabel: "Unsupported agent", runtimeAgentId: "agent-1", agentRuntimeType: "process", model: null, error: "The current user has not configured a chat model yet." });
    const res = await request(createApp()).post("/api/orgs/organization-1/chats/messages/stream").send({ body: "Do not create an empty chat" });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "The current user has not configured a chat model yet." });
    expect(mockChatService.createWithInitialMessage).not.toHaveBeenCalled();
  });

  it("atomically accepts a first turn and includes the conversation in the stream ack", async () => {
    const conversation = createConversation({
      title: "Start atomically",
      modelOverride: "gpt-5.6-terra",
      chatRuntime: {
        ...createConversation().chatRuntime,
        model: "gpt-5.6-terra",
      },
    });
    const userMessage = createMessage("message-user", "user", "message", "Start atomically");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Ready.");
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message: userMessage });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.addMessage.mockResolvedValue(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Ready.",
      replyingAgentId: "agent-1",
      reply: { kind: "message", body: "Ready.", structuredPayload: null, replyingAgentId: "agent-1" },
    });
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "\"Atomic chat kickoff\"",
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats/messages/stream")
      .send({
        body: "Start atomically",
        modelOverride: "gpt-5.6-terra",
        groupId: "33333333-3333-4333-8333-333333333333",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body).trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toEqual(expect.objectContaining({
      type: "ack",
      conversation: expect.objectContaining({ id: "chat-1" }),
      userMessage: expect.objectContaining({ id: "message-user", body: "Start atomically" }),
    }));
    expect(mockChatService.createWithInitialMessage).toHaveBeenCalledTimes(1);
    expect(mockChatService.createWithInitialMessage).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        modelOverride: null,
        effortOverride: null,
        messengerGroupId: "33333333-3333-4333-8333-333333333333",
        messengerGroupUserId: "user-1",
      }),
    );
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledWith(
      expect.objectContaining({ modelSnapshot: "gpt-5.6-terra" }),
    );
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "organization-1",
        purpose: "lightweight",
        feature: "chat_title",
        prompt: expect.stringContaining("Start atomically"),
      }));
      expect(mockChatService.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
        "chat-1",
        "Start atomically",
        "Atomic chat kickoff",
      );
    });
  });

  it("preserves an explicit New chat title during an atomic streaming first turn", async () => {
    const conversation = createConversation({ title: "New chat" });
    const userMessage = createMessage("message-user", "user", "message", "Keep the explicit title");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Ready.");
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message: userMessage });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValue(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Ready.",
      replyingAgentId: "agent-1",
      reply: { kind: "message", body: "Ready.", structuredPayload: null, replyingAgentId: "agent-1" },
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats/messages/stream")
      .send({ title: "New chat", body: "Keep the explicit title" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.updateDefaultTitle).not.toHaveBeenCalled();
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("rejects direct streaming of a claimed queued message in favor of the server-owned worker", async () => {
    const queuedMessageId = "10000000-0000-4000-8000-000000000011";
    const conversation = createConversation({
      title: "Queued Agent default snapshot",
      modelOverride: "gpt-5.6-luna",
      chatRuntime: {
        ...createConversation().chatRuntime,
        model: "gpt-5.6-luna",
      },
    });
    const userMessage = createMessage("message-user", "user", "message", "Use the queued Agent default");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Default kept.");
    const claimedQueuedMessage = await mockChatService.createQueuedMessage({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      clientMutationId: "claimed-null-model",
      payload: {
        body: "Use the queued Agent default",
        model: null,
      },
    });
    mockChatService.createQueuedMessage.mockClear();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.assertQueuedMessageClaimedForDelivery.mockResolvedValueOnce({
      ...claimedQueuedMessage,
      id: queuedMessageId,
    });
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValueOnce({
      ...conversation.chatRuntime,
      model: "gpt-5.6-luna",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Default kept.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Default kept.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({
        body: "Use the queued Agent default",
        queuedMessageId,
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(409);
    expect(JSON.parse(String(res.body))).toEqual({
      error: "Queued messages are delivered only by Rudder's server-owned Queue worker",
    });
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("normalizes multipart draft fields before accepting an attached first turn", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000001";
    const projectId = "10000000-0000-4000-8000-000000000002";
    const conversation = createConversation({ preferredAgentId, planMode: true });
    const userMessage = createMessage("message-user", "user", "message", "Start with an attachment");
    mockAgentService.getById.mockResolvedValue({ id: preferredAgentId, orgId: "organization-1", status: "idle" });
    mockProjectService.getById.mockResolvedValue({ id: projectId, orgId: "organization-1" });
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message: userMessage });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Ready.",
      replyingAgentId: preferredAgentId,
      reply: { kind: "message", body: "Ready.", structuredPayload: null, replyingAgentId: preferredAgentId },
    });
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValueOnce({
      ...conversation.chatRuntime,
      sourceType: "agent",
      sourceLabel: "Agent default",
      model: "gpt-5.6-sol",
      effort: "high",
      available: true,
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats/messages/stream")
      .field("body", "Start with an attachment")
      .field("preferredAgentId", preferredAgentId)
      .field("modelOverride", "__rudder_agent_default__")
      .field("effortOverride", "__rudder_agent_default__")
      .field("issueCreationMode", "manual_approval")
      .field("planMode", "true")
      .field("contextLinks", JSON.stringify([{ entityType: "project", entityId: projectId }]))
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatService.createWithInitialMessage).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        preferredAgentId,
        modelOverride: null,
        effortOverride: null,
        planMode: true,
        contextLinks: [expect.objectContaining({ entityType: "project", entityId: projectId })],
      }),
    );
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredAgentId,
        modelOverride: null,
        effortOverride: null,
      }),
    );
  });

  it("binds first-turn Annotation files into the canonical user message before ack", async () => {
    const conversation = createConversation({ id: "10000000-0000-4000-8000-000000000020" });
    const annotationId = "10000000-0000-4000-8000-000000000021";
    const attachmentId = "10000000-0000-4000-8000-000000000022";
    const annotationInput = createInlineAnnotation({
      id: annotationId,
      attachmentFileIndexes: [0],
    });
    const userMessage = {
      ...createMessage("10000000-0000-4000-8000-000000000023", "user", "message", "Review this run"),
      conversationId: conversation.id,
      structuredPayload: {
        inlineAnnotations: [createInlineAnnotation({ id: annotationId })],
      },
    };
    const assistantMessage = createMessage("10000000-0000-4000-8000-000000000024", "assistant", "message", "Done.");
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message: userMessage });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.createAttachment.mockResolvedValueOnce({ id: attachmentId });
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.updateMessageStructuredPayload.mockImplementationOnce(async (
      _conversationId: string,
      messageId: string,
      structuredPayload: Record<string, unknown> | null,
    ) => ({
      ...userMessage,
      id: messageId,
      structuredPayload,
      attachments: [{ id: attachmentId }],
    }));
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
      outcome: "completed",
      partialBody: "Done.",
      replyingAgentId: "agent-1",
      reply: { kind: "message", body: "Done.", structuredPayload: null, replyingAgentId: "agent-1" },
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats/messages/stream")
      .field("body", "Review this run")
      .field("inlineAnnotations", JSON.stringify([annotationInput]))
      .attach("files", Buffer.from("run evidence"), {
        filename: "run-evidence.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatService.updateMessageStructuredPayload).toHaveBeenCalledWith(
      conversation.id,
      userMessage.id,
      expect.objectContaining({
        inlineAnnotations: [expect.objectContaining({
          id: annotationId,
          attachmentIds: [attachmentId],
        })],
      }),
    );
    const events = String(res.body).trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      type: "ack",
      userMessage: {
        structuredPayload: {
          inlineAnnotations: [expect.objectContaining({ attachmentIds: [attachmentId] })],
        },
      },
    });
  });

  it("keeps the accepted first message and records failure evidence when generation startup fails", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Start despite runtime failure");
    const failedMessage = { ...createMessage("message-failed", "assistant", "message", "The assistant reply could not be completed."), status: "failed" };
    mockChatService.createWithInitialMessage.mockResolvedValue({ conversation, message: userMessage });
    mockChatService.createGeneration.mockRejectedValueOnce(new Error("generation insert failed"));
    mockChatService.addMessage.mockResolvedValueOnce(failedMessage);

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats/messages/stream")
      .send({ body: "Start despite runtime failure" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body).trim().split("\n").map((line) => JSON.parse(line));
    expect(events[0]).toEqual(expect.objectContaining({ type: "ack", conversation: expect.objectContaining({ id: "chat-1" }), userMessage: expect.objectContaining({ id: "message-user" }) }));
    expect(events[1]).toEqual(expect.objectContaining({ type: "error", messageId: "message-failed" }));
    expect(mockChatService.addMessage).toHaveBeenCalledWith("chat-1", expect.objectContaining({ role: "assistant", status: "failed" }));
  });

  it("rejects chat creation when the organization has no available agent", async () => {
    mockAgentService.list.mockResolvedValueOnce([]);

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ initialMessage: { body: "Start" } });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Chat requires an available agent" });
    expect(mockChatService.create).not.toHaveBeenCalled();
  });

  it("rejects chat creation when the preferred agent is unknown", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000001";
    mockAgentService.getById.mockResolvedValueOnce(null);

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ preferredAgentId, initialMessage: { body: "Start" } });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Preferred agent must be available in the same organization" });
    expect(mockAgentService.getById).toHaveBeenCalledWith(preferredAgentId);
    expect(mockChatService.create).not.toHaveBeenCalled();
  });

  it("rejects chat creation when the preferred agent belongs to another organization", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000002";
    mockAgentService.getById.mockResolvedValueOnce({
      id: preferredAgentId,
      orgId: "other-organization",
      status: "idle",
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ preferredAgentId, initialMessage: { body: "Start" } });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Preferred agent must be available in the same organization" });
    expect(mockAgentService.getById).toHaveBeenCalledWith(preferredAgentId);
    expect(mockChatService.create).not.toHaveBeenCalled();
  });

  it("rejects chat creation with a terminated preferred agent", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000003";
    mockAgentService.getById.mockResolvedValueOnce({
      id: preferredAgentId,
      orgId: "organization-1",
      status: "terminated",
    });

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ preferredAgentId, initialMessage: { body: "Start" } });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Preferred agent must be available in the same organization" });
    expect(mockChatService.create).not.toHaveBeenCalled();
  });

  it("rejects clearing the preferred agent from an existing chat", async () => {
    mockChatService.getById.mockResolvedValueOnce(createConversation());

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ preferredAgentId: null });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Chat requires an available agent" });
    expect(mockChatService.update).not.toHaveBeenCalled();
  });

  it("rejects message sends before persisting when no preferred agent is available", async () => {
    const conversation = createConversation({
      preferredAgentId: null,
      chatRuntime: {
        sourceType: "unconfigured",
        sourceLabel: "Choose an agent",
        runtimeAgentId: null,
        agentRuntimeType: null,
        model: null,
        available: false,
        error: "Choose a chat agent before sending messages.",
      },
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValueOnce(conversation.chatRuntime);

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "Choose a chat agent before sending messages." });
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("persists agent-authenticated chat sends as direct incoming agent messages", async () => {
    const conversation = createConversation({
      preferredAgentId: null,
      chatRuntime: {
        sourceType: "unconfigured",
        sourceLabel: "Choose an agent",
        runtimeAgentId: null,
        agentRuntimeType: null,
        model: null,
        available: false,
        error: "Choose a chat agent before sending messages.",
      },
    });
    const agentMessage = {
      ...createMessage("message-agent", "assistant", "message", "I finished the handoff."),
      replyingAgentId: "agent-1",
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addMessage.mockResolvedValueOnce(agentMessage);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages")
      .send({ body: "I finished the handoff." });

    expect(res.status).toBe(201);
    expect(res.body.messages).toEqual([
      expect.objectContaining({
        id: "message-agent",
        role: "assistant",
        kind: "message",
        body: "I finished the handoff.",
        replyingAgentId: "agent-1",
      }),
    ]);
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        orgId: "organization-1",
        role: "assistant",
        kind: "message",
        body: "I finished the handoff.",
        replyingAgentId: "agent-1",
      }),
    );
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(hasActiveChatGeneration("chat-1")).toBe(false);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "chat.message_added",
        entityType: "chat",
        entityId: "chat-1",
        details: expect.objectContaining({
          messageId: "message-agent",
          role: "assistant",
          source: "agent_direct_message",
        }),
      }),
    );
  });

  it("rejects agent-authenticated chat sends that try to edit operator messages", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages")
      .send({
        body: "Rewrite the operator prompt",
        editUserMessageId: "10000000-0000-4000-8000-000000000099",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Agent-authored chat messages cannot edit operator messages" });
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated annotation fields instead of silently dropping them", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages")
      .send({
        body: "Agent-authored prose",
        inlineAnnotations: [createInlineAnnotation()],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("annotations");
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
  });

  it("requires a nonempty body independently for agent-authenticated messages", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages")
      .send({
        body: "",
        inlineAnnotations: [createInlineAnnotation()],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("nonempty body");
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
  });

  it("rejects local message sends to Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Continue this locally" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
  });

  it("never degrades a non-stream operator edit into Queue while another generation owns the chat", async () => {
    const conversation = createConversation();
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-active");
    mockChatService.getById.mockResolvedValue(conversation);

    try {
      const res = await request(createApp())
        .post("/api/chats/chat-1/messages")
        .send({
          body: "Edited operator prompt",
          editUserMessageId: "10000000-0000-4000-8000-000000000099",
        });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Stop the current response before editing this message" });
      expect(mockChatService.createQueuedMessage).not.toHaveBeenCalled();
      expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    } finally {
      releaseGeneration?.();
    }
  });

  it("rejects an invalid response annotation before persisting a user message or invoking the assistant", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatInlineAnnotations.prepare.mockRejectedValueOnce(
      unprocessable("Annotation source hash does not match persisted source"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages`)
      .send({
        body: "",
        inlineAnnotations: [createInlineAnnotation()],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("source hash");
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("persists canonical annotations while keeping quote and comment text out of activity details", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    const annotation = createInlineAnnotation();
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Explanation"),
      conversationId: annotationConversationId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockImplementation(async () => [{
      ...createMessage("message-user", "user", "message", "Explain this"),
      conversationId: annotationConversationId,
      structuredPayload: { inlineAnnotations: [annotation] },
    }]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
      outcome: "completed",
      partialBody: "Explanation",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Explanation",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages`)
      .send({
        body: "Explain this",
        inlineAnnotations: [annotation],
      });

    expect(res.status).toBe(201);
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      annotationConversationId,
      "organization-1",
      "Explain this",
      null,
      {
        structuredPayload: { inlineAnnotations: [annotation] },
        structuredPayloadProvided: true,
      },
    );
    const userActivity = mockLogActivity.mock.calls
      .map((call) => call[1])
      .find((activity) => activity?.details?.role === "user");
    expect(userActivity?.details).toMatchObject({
      annotationCount: 1,
      annotationSourceMessageIds: [annotationSourceMessageId],
    });
    expect(JSON.stringify(userActivity?.details)).not.toContain(annotation.selectedText);
    expect(JSON.stringify(userActivity?.details)).not.toContain(annotation.comment);
  });

  it("routes an annotation-only historical retry with the exact supplied snapshot", async () => {
    const editUserMessageId = "10000000-0000-4000-8000-000000000099";
    const conversation = createConversation({ id: annotationConversationId });
    const annotation = createInlineAnnotation();
    const editedUserMessage = {
      ...createMessage("10000000-0000-4000-8000-000000000098", "user", "message", ""),
      conversationId: annotationConversationId,
      structuredPayload: { inlineAnnotations: [annotation] },
      turnVariant: 1,
    };
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Retried."),
      conversationId: annotationConversationId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(editedUserMessage);
    mockChatService.listMessages.mockResolvedValue([editedUserMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
      outcome: "completed",
      partialBody: "Retried.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Retried.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages`)
      .send({
        body: "",
        editUserMessageId,
        inlineAnnotations: [annotation],
      });

    expect(res.status).toBe(201);
    expect(mockChatInlineAnnotations.prepare).toHaveBeenCalledWith({
      orgId: "organization-1",
      conversationId: annotationConversationId,
      annotations: [annotation],
      uploadedFileCount: 0,
      editUserMessageId,
    });
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      annotationConversationId,
      "organization-1",
      "",
      editUserMessageId,
      {
        structuredPayload: { inlineAnnotations: [annotation] },
        structuredPayloadProvided: true,
      },
    );
  });

  it("returns the immutable-snapshot rejection before a JSON historical edit can run", async () => {
    const editUserMessageId = "10000000-0000-4000-8000-000000000099";
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatInlineAnnotations.prepare.mockRejectedValue(
      unprocessable("Sent annotation snapshots are immutable across historical edits and retries"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages`)
      .send({
        body: "Mutate the old annotation",
        editUserMessageId,
        inlineAnnotations: [{
          ...createInlineAnnotation(),
          comment: "Changed after send",
        }],
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("immutable");
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("rejects agent-authenticated streaming chat sends before assistant generation", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "I should be a direct message, not a user prompt." });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Agent-authored chat messages must use the non-stream message endpoint" });
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(hasActiveChatGeneration("chat-1")).toBe(false);
  });

  it("replays the accepted user-message acknowledgement for a repeated send mutation", async () => {
    const conversation = createConversation();
    const userMessage = createMessage(
      "message-idempotent-user",
      "user",
      "message",
      "Send exactly once",
    );
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getUserMessageByClientMutationId.mockResolvedValue(userMessage);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValueOnce({
      available: false,
      error: "Runtime temporarily unavailable",
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({
        body: "Send exactly once",
        clientMutationId: "send-mutation-1",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(200);
    expect(String(res.body).trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        type: "ack",
        userMessage: expect.objectContaining({
          id: userMessage.id,
          body: userMessage.body,
        }),
      }),
      { type: "final", messages: [] },
    ]);
    expect(mockChatService.getUserMessageByClientMutationId).toHaveBeenCalledWith(
      conversation.orgId,
      conversation.id,
      "send-mutation-1",
    );
    expect(mockChatService.createGeneration).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("does not queue a concurrent retry with the active send mutation", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    const releaseGeneration = claimChatGeneration(
      conversation.id,
      new AbortController(),
      null,
      "send-mutation-active",
    );

    try {
      const res = await request(createApp())
        .post("/api/chats/chat-1/messages/stream")
        .send({
          body: "Send exactly once",
          clientMutationId: "send-mutation-active",
        });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        error: "This message is already being sent. Try again shortly.",
        details: {
          code: "chat_send_in_progress",
          phase: "message_acceptance",
        },
      });
      expect(mockChatService.createQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
    } finally {
      releaseGeneration?.();
    }
  });

  it("rejects agent-authenticated streaming chat edits before assistant generation", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .post("/api/chats/chat-1/messages/stream")
      .send({
        body: "Rewrite the operator prompt through stream",
        editUserMessageId: "10000000-0000-4000-8000-000000000099",
      });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Agent-authored chat messages cannot edit operator messages" });
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(hasActiveChatGeneration("chat-1")).toBe(false);
  });

  it("never degrades an operator edit into Queue while another generation owns the chat", async () => {
    const conversation = createConversation();
    const releaseGeneration = claimChatGeneration("chat-1", new AbortController(), "generation-active");
    mockChatService.getById.mockResolvedValue(conversation);

    try {
      const res = await request(createApp())
        .post("/api/chats/chat-1/messages/stream")
        .send({
          body: "Edited operator prompt",
          editUserMessageId: "10000000-0000-4000-8000-000000000099",
        });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Stop the current response before editing this message" });
      expect(mockChatService.createQueuedMessage).not.toHaveBeenCalled();
      expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    } finally {
      releaseGeneration?.();
    }
  });

  it("queues multipart annotation files when another generation owns the chat", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    const releaseGeneration = claimChatGeneration(
      annotationConversationId,
      new AbortController(),
      "10000000-0000-4000-8000-000000000011",
    );
    const canonicalAnnotation = createInlineAnnotation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${annotationConversationId}/during-stream.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "d".repeat(64),
      originalFilename: "during-stream.txt",
    });
    mockChatService.createQueuedMessageWithStagedAttachments.mockResolvedValue({
      accepted: true,
      cleanupAttachments: [],
      item: {
        id: "queued-stream-1",
        annotationCount: 1,
        payload: { body: "", inlineAnnotations: [canonicalAnnotation] },
      },
    });

    try {
      const res = await request(createApp())
        .post(`/api/chats/${annotationConversationId}/messages/stream`)
        .field("body", "")
        .field("inlineAnnotations", JSON.stringify([
          createInlineAnnotation({ attachmentFileIndexes: [0] }),
        ]))
        .attach("files", Buffer.from("file"), {
          filename: "during-stream.txt",
          contentType: "text/plain",
        })
        .buffer(true)
        .parse((response, callback) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => callback(null, text));
        });

      expect(res.status).toBe(202);
      expect(mockStorage.putFile).toHaveBeenCalledWith(expect.objectContaining({
        namespace: `chat-queue-annotations/${annotationConversationId}`,
      }));
      expect(mockChatService.createQueuedMessageWithStagedAttachments).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: conversation.orgId,
          conversationId: conversation.id,
          payload: expect.objectContaining({
            body: "",
            inlineAnnotations: [canonicalAnnotation],
          }),
          stagedAttachments: [expect.objectContaining({
            objectKey: `chat-queue-annotations/${annotationConversationId}/during-stream.txt`,
          })],
          attachmentFileIndexesByAnnotationId: expect.any(Map),
        }),
      );
      expect(JSON.parse(String(res.body).trim())).toMatchObject({
        type: "queued",
        item: {
          id: "queued-stream-1",
          annotationCount: 1,
          payload: { inlineAnnotations: [canonicalAnnotation] },
        },
      });
      expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
      expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    } finally {
      releaseGeneration?.();
    }
  });

  it("rejects legacy client delivery of a queued message before an annotation snapshot can be omitted", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .send({
        body: "Client-supplied replacement prose",
        queuedMessageId: "10000000-0000-4000-8000-000000000071",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("server-owned Queue worker");
    expect(mockChatService.assertQueuedMessageClaimedForDelivery).not.toHaveBeenCalled();
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatService.createGeneration).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("rejects legacy client delivery before an annotation snapshot or owned file can be replaced", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Client-supplied replacement prose")
      .field("queuedMessageId", "10000000-0000-4000-8000-000000000072")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [0] }),
      ]))
      .attach("files", Buffer.from("replacement"), {
        filename: "replacement.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("server-owned Queue worker");
    expect(mockChatService.assertQueuedMessageClaimedForDelivery).not.toHaveBeenCalled();
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockChatService.createGeneration).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("rejects a multipart annotation file index before storing files or creating a generation", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatInlineAnnotations.prepare.mockRejectedValue(
      unprocessable("Annotation file index does not match an uploaded file"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Explain this")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [1] }),
      ]))
      .attach("files", Buffer.from("file"), {
        filename: "annotation.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("file index");
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createAttachment).not.toHaveBeenCalled();
    expect(mockChatService.createGeneration).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
  });

  it("rejects local streaming sends to Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Stream from Rudder" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatService.addUserChatMessage).not.toHaveBeenCalled();
  });

  it("marks stale streaming assistant messages interrupted when listing messages", async () => {
    const conversation = createConversation();
    const interruptedMessage = {
      ...createMessage("message-streaming", "assistant", "message", "Partial preserved reply"),
      status: "interrupted",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.markInterruptedStreamingMessages.mockResolvedValueOnce([interruptedMessage]);
    mockChatService.listMessages.mockResolvedValueOnce([interruptedMessage]);

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages?orgId=organization-1");

    expect(res.status).toBe(200);
    expect(mockChatService.markInterruptedStreamingMessages).toHaveBeenCalledWith("chat-1");
    expect(mockChatService.listMessages).toHaveBeenCalledWith("chat-1", { includeTranscript: false });
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: "message-streaming",
      status: "interrupted",
      body: "Partial preserved reply",
    }));
  });

  it("falls back to a persisted active generation when no reply is running in memory", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValueOnce({
      activeGenerationId: "10000000-0000-4000-8000-000000000002",
      activeAttemptEpoch: 2,
      activeControlVersion: 1,
      activeGenerationStatus: "waiting_for_network",
      items: [],
    });

    const res = await request(createApp())
      .get("/api/chats/chat-1/queue");

    expect(res.status).toBe(200);
    expect(mockChatService.getQueueSnapshot).toHaveBeenCalledWith("chat-1");
    expect(res.body).toEqual({
      activeGenerationId: "10000000-0000-4000-8000-000000000002",
      activeAttemptEpoch: 2,
      activeControlVersion: 1,
      activeGenerationStatus: "waiting_for_network",
      items: [],
    });
  });

  it("passes the in-memory generation to queue snapshots while a reply is active", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValueOnce({
      activeGenerationId: "10000000-0000-4000-8000-000000000001",
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
      items: [],
    });
    const release = claimChatGeneration(conversation.id, null, "10000000-0000-4000-8000-000000000001");

    try {
      const res = await request(createApp())
        .get("/api/chats/chat-1/queue");

      expect(res.status).toBe(200);
      expect(mockChatService.getQueueSnapshot).toHaveBeenCalledWith("chat-1", "10000000-0000-4000-8000-000000000001");
      expect(res.body).toEqual({
        activeGenerationId: "10000000-0000-4000-8000-000000000001",
        activeAttemptEpoch: 1,
        activeControlVersion: 0,
        activeGenerationStatus: "running",
        items: [],
      });
    } finally {
      release?.();
    }
  });

  it("fails an unsafe network recovery without invoking the provider", async () => {
    let recover: ((run: any) => Promise<boolean>) | undefined;
    createApp(undefined, undefined, (handler) => {
      recover = handler;
    });
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Continue this reply");
    const generation = {
      id: "10000000-0000-4000-8000-000000000004",
      status: "waiting_for_network",
      attemptEpoch: 1,
      terminalReason: null,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getMessage.mockResolvedValue(userMessage);
    mockChatService.getLatestGeneration.mockResolvedValue(generation);
    mockChatService.generationProtocol.getFrozenVisibleProjection.mockResolvedValue({
      generation,
      projection: {
        body: "Partial reply",
        assistantMessageId: null,
        transcript: [],
      },
    });
    mockChatService.generationProtocol.recordRuntimeTerminal.mockResolvedValue({});

    const handled = await recover?.({
      id: "10000000-0000-4000-8000-000000000005",
      orgId: conversation.orgId,
      agentId: "agent-1",
      chatConversationId: conversation.id,
      executionOwnerToken: "owner-1",
      contextSnapshot: {
        conversationId: conversation.id,
        chatGenerationId: generation.id,
        userMessageId: userMessage.id,
        attemptEpoch: 1,
      },
      networkRecoveryFailure: {
        errorCode: "network_resume_unsafe",
        error: "Network recovery cannot safely resume this provider attempt",
      },
    });

    expect(handled).toBe(true);
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.markNetworkResumed).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalledWith(expect.objectContaining({
      generationId: generation.id,
      finalStatus: "failed",
      terminalReason: "Network recovery cannot safely resume this provider attempt",
    }));
  });

  it("does not restart a recovered Chat generation after Stop", async () => {
    let recover: ((run: any) => Promise<boolean>) | undefined;
    createApp(undefined, undefined, (handler) => {
      recover = handler;
    });
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Continue this reply");
    const generation = {
      id: "10000000-0000-4000-8000-000000000006",
      status: "stopping",
      attemptEpoch: 1,
      terminalReason: "operator_stop",
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getMessage.mockResolvedValue(userMessage);
    mockChatService.getLatestGeneration.mockResolvedValue(null);
    mockChatService.generationProtocol.getFrozenVisibleProjection.mockResolvedValue({
      generation,
      projection: {
        body: "Partial reply",
        assistantMessageId: null,
        transcript: [],
      },
    });

    const handled = await recover?.({
      id: "10000000-0000-4000-8000-000000000007",
      orgId: conversation.orgId,
      agentId: "agent-1",
      chatConversationId: conversation.id,
      executionOwnerToken: "owner-1",
      contextSnapshot: {
        conversationId: conversation.id,
        chatGenerationId: generation.id,
        userMessageId: userMessage.id,
        attemptEpoch: 1,
      },
    });

    expect(handled).toBe(true);
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.markNetworkResumed).not.toHaveBeenCalled();
    expect(mockChatAgentRuns.finalizeRun).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: "cancelled",
      errorCode: "chat_run_cancelled",
    }));
  });

  it("requires a board actor to create or replace Queue annotations", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      orgId: conversation.orgId,
      runId: "run-1",
    };

    const create = await request(createApp(agentActor))
      .post(`/api/chats/${annotationConversationId}/queue`)
      .send({
        clientMutationId: "agent-annotation-create",
        payload: {
          body: "Agent prose",
          inlineAnnotations: [],
        },
      });
    const update = await request(createApp(agentActor))
      .patch(`/api/chats/${annotationConversationId}/queue/queued-1`)
      .send({
        version: 1,
        payload: {
          body: "Agent edit",
          inlineAnnotations: [],
        },
      });

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
    expect(mockChatService.updateQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
  });

  it("rejects agent Queue create and update uploads before annotation preparation or object storage", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    const agentActor = {
      type: "agent",
      agentId: "agent-1",
      orgId: conversation.orgId,
      runId: "run-1",
    };

    const create = await request(createApp(agentActor))
      .post(`/api/chats/${annotationConversationId}/queue`)
      .field("clientMutationId", "agent-annotation-upload")
      .field("body", "Agent prose")
      .attach("files", Buffer.from("not allowed"), {
        filename: "agent.txt",
        contentType: "text/plain",
      });
    const update = await request(createApp(agentActor))
      .patch(`/api/chats/${annotationConversationId}/queue/queued-1`)
      .field("version", "1")
      .field("body", "Agent edit")
      .attach("files", Buffer.from("not allowed either"), {
        filename: "agent-update.txt",
        contentType: "text/plain",
      });

    expect(create.status).toBe(403);
    expect(update.status).toBe(403);
    expect(mockChatInlineAnnotations.prepare).not.toHaveBeenCalled();
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
    expect(mockChatService.updateQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
  });

  it("stages multipart Queue annotation files without leaking private storage references", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    const annotationInput = createInlineAnnotation({ attachmentFileIndexes: [0] });
    const canonicalAnnotation = createInlineAnnotation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${annotationConversationId}/staged.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "a".repeat(64),
      originalFilename: "staged.txt",
    });
    mockChatService.createQueuedMessageWithStagedAttachments.mockResolvedValue({
      accepted: true,
      cleanupAttachments: [],
      item: {
        id: "queued-1",
        orgId: conversation.orgId,
        conversationId: conversation.id,
        position: 1,
        status: "queued",
        version: 1,
        clientMutationId: "queue-files",
        deliveryIntent: "queue",
        deliveryDisposition: null,
        controlActionId: null,
        expectedGenerationId: null,
        activeGenerationId: null,
        attemptEpoch: null,
        providerClientMessageId: null,
        providerThreadId: null,
        providerTurnId: null,
        providerEvidence: null,
        continuationGenerationId: null,
        continuationMessageId: null,
        deliveryLeaseToken: null,
        deliveryLeaseEpoch: 0,
        deliveryLeaseOwner: null,
        deliveryLeaseExpiresAt: null,
        reconciliationReason: null,
        deliveryAttempts: 0,
        lastAttemptAt: null,
        lastDeliveryReason: null,
        sourceMessageId: null,
        deliveredMessageId: null,
        cancelledAt: null,
        steeredAt: null,
        dequeuedAt: null,
        createdAt: new Date("2026-03-26T08:02:00.000Z"),
        updatedAt: new Date("2026-03-26T08:02:00.000Z"),
        annotationCount: 1,
        payload: { body: "", inlineAnnotations: [canonicalAnnotation] },
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/queue`)
      .field("clientMutationId", "queue-files")
      .field("body", "")
      .field("inlineAnnotations", JSON.stringify([annotationInput]))
      .attach("files", Buffer.from("file"), {
        filename: "staged.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(mockChatInlineAnnotations.prepare).toHaveBeenCalledWith(expect.objectContaining({
      orgId: conversation.orgId,
      conversationId: conversation.id,
      annotations: [annotationInput],
      uploadedFileCount: 1,
    }));
    expect(mockStorage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      orgId: conversation.orgId,
      namespace: `chat-queue-annotations/${annotationConversationId}`,
      originalFilename: "staged.txt",
    }));
    expect(mockChatService.createQueuedMessageWithStagedAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        clientMutationId: "queue-files",
        payload: expect.objectContaining({
          body: "",
          inlineAnnotations: [canonicalAnnotation],
        }),
        stagedAttachments: [expect.objectContaining({
          objectKey: `chat-queue-annotations/${annotationConversationId}/staged.txt`,
        })],
        attachmentFileIndexesByAnnotationId: expect.any(Map),
      }),
    );
    expect(res.body).toMatchObject({
      annotationCount: 1,
      payload: { body: "", inlineAnnotations: [canonicalAnnotation] },
    });
    expect(JSON.stringify(res.body)).not.toContain("objectKey");
    expect(JSON.stringify(res.body)).not.toContain("assetId");
    expect(JSON.stringify(res.body)).not.toContain("attachmentFileIndexes");
  });

  it("compensates staged Queue objects when atomic persistence fails", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${annotationConversationId}/failed.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "b".repeat(64),
      originalFilename: "failed.txt",
    });
    mockChatService.createQueuedMessageWithStagedAttachments.mockRejectedValue(
      unprocessable("Queue persistence failed"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/queue`)
      .field("clientMutationId", "queue-files-failed")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [0] }),
      ]))
      .attach("files", Buffer.from("file"), {
        filename: "failed.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      conversation.orgId,
      `chat-queue-annotations/${annotationConversationId}/failed.txt`,
    );
  });

  it("replaces multipart Queue annotation files and cleans the committed prior asset", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    const annotationInput = createInlineAnnotation({ attachmentFileIndexes: [0] });
    const canonicalAnnotation = createInlineAnnotation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: `chat-queue-annotations/${annotationConversationId}/replacement.txt`,
      contentType: "text/plain",
      byteSize: 4,
      sha256: "c".repeat(64),
      originalFilename: "replacement.txt",
    });
    mockChatService.updateQueuedMessageWithStagedAttachments.mockResolvedValue({
      item: {
        id: "queued-1",
        version: 2,
        annotationCount: 1,
        payload: { body: "Updated", inlineAnnotations: [canonicalAnnotation] },
      },
      cleanupAttachments: [{
        assetId: "10000000-0000-4000-8000-000000000088",
        objectKey: `chat-queue-annotations/${annotationConversationId}/prior.txt`,
      }],
    });

    const res = await request(createApp())
      .patch(`/api/chats/${annotationConversationId}/queue/queued-1`)
      .field("version", "1")
      .field("body", "Updated")
      .field("inlineAnnotations", JSON.stringify([annotationInput]))
      .attach("files", Buffer.from("file"), {
        filename: "replacement.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(200);
    expect(mockChatService.updateQueuedMessageWithStagedAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        itemId: "queued-1",
        version: 1,
        payload: expect.objectContaining({
          body: "Updated",
          inlineAnnotations: [canonicalAnnotation],
        }),
        stagedAttachments: [expect.objectContaining({
          objectKey: `chat-queue-annotations/${annotationConversationId}/replacement.txt`,
        })],
        attachmentFileIndexesByAnnotationId: expect.any(Map),
      }),
    );
    expect(mockStorage.deleteObject).toHaveBeenCalledTimes(1);
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      conversation.orgId,
      `chat-queue-annotations/${annotationConversationId}/prior.txt`,
    );
    expect(mockChatService.finalizeQueuedAnnotationAssetCleanup).toHaveBeenCalledWith({
      orgId: conversation.orgId,
      assetIds: ["10000000-0000-4000-8000-000000000088"],
    });
    expect(JSON.stringify(res.body)).not.toContain("objectKey");
  });

  it("rejects a queued annotation file index before storing any object", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatInlineAnnotations.prepare.mockRejectedValue(
      unprocessable("Annotation file index does not match an uploaded file"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/queue`)
      .field("clientMutationId", "queue-invalid-index")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [1] }),
      ]))
      .attach("files", Buffer.from("file"), {
        filename: "only.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(422);
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createQueuedMessageWithStagedAttachments).not.toHaveBeenCalled();
  });

  it("deletes only orphaned Queue annotation objects after cancellation commits", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.cancelQueuedMessageWithStagedAttachments.mockResolvedValue({
      item: { id: "queued-1", status: "cancelled", payload: { body: "cancelled" } },
      cleanupAttachments: [{
        assetId: "10000000-0000-4000-8000-000000000099",
        objectKey: "chat-queue-annotations/chat-1/orphan.txt",
      }],
    });

    const res = await request(createApp())
      .delete("/api/chats/chat-1/queue/queued-1")
      .send({ version: 1 });

    expect(res.status).toBe(200);
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      conversation.orgId,
      "chat-queue-annotations/chat-1/orphan.txt",
    );
    expect(mockChatService.finalizeQueuedAnnotationAssetCleanup).toHaveBeenCalledWith({
      orgId: conversation.orgId,
      assetIds: ["10000000-0000-4000-8000-000000000099"],
    });
    expect(res.body).toMatchObject({ id: "queued-1", status: "cancelled" });
    expect(JSON.stringify(res.body)).not.toContain("objectKey");
  });

  it("does not mutate Feishu-bound chat messages while listing messages", async () => {
    const conversation = createFeishuBackedConversation();
    const message = createMessage("message-feishu", "user", "message", "Message from Feishu");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([message]);

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages?orgId=organization-1");

    expect(res.status).toBe(200);
    expect(mockChatService.markInterruptedStreamingMessages).not.toHaveBeenCalled();
    expect(mockChatService.listMessages).toHaveBeenCalledWith("chat-1", { includeTranscript: false });
    expect(res.body[0]).toEqual(expect.objectContaining({ id: "message-feishu" }));
  });

  it("rejects a multi-organization board message read when the requested organization does not own the chat", async () => {
    const conversation = createConversation({ orgId: "organization-2" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([
      createMessage("message-org-2", "assistant", "message", "Private organization 2 content"),
    ]);

    const res = await request(createApp({
      type: "board",
      userId: "user-1",
      orgIds: ["organization-1", "organization-2"],
      source: "session",
      isInstanceAdmin: false,
      runId: null,
    }))
      .get("/api/chats/chat-1/messages?orgId=organization-1");

    expect(res.status).toBe(404);
    expect(mockChatService.listMessages).not.toHaveBeenCalled();
  });

  it("rejects an agent message read when the requested organization does not own the chat", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([
      createMessage("message-agent", "assistant", "message", "Agent-scoped content"),
    ]);

    const res = await request(createApp({
      type: "agent",
      source: "agent_key",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: "run-1",
    }))
      .get("/api/chats/chat-1/messages?orgId=organization-2");

    expect(res.status).toBe(404);
    expect(mockChatService.listMessages).not.toHaveBeenCalled();
  });

  it("can include full chat transcripts when explicitly requested", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([]);

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages?orgId=organization-1&includeTranscript=true");

    expect(res.status).toBe(200);
    expect(mockChatService.listMessages).toHaveBeenCalledWith("chat-1", { includeTranscript: true });
  });

  it("can return paginated chat message envelopes for CLI readers", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([
      createMessage("message-1", "user", "message", "first"),
      createMessage("message-2", "assistant", "message", "second"),
      createMessage("message-3", "user", "message", "third"),
    ]);

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages?orgId=organization-1&envelope=true&order=newest&limit=1&cursor=message-3&includeTranscript=true");

    expect(res.status).toBe(200);
    expect(mockChatService.listMessages).toHaveBeenCalledWith("chat-1", { includeTranscript: true });
    expect(res.body.messages.map((message: { id: string }) => message.id)).toEqual(["message-2"]);
    expect(res.body.page).toMatchObject({
      cursor: "message-3",
      nextCursor: "message-2",
      hasMore: true,
      limit: 1,
      order: "newest",
      returnedMessages: 1,
      totalMessages: 3,
    });
  });

  it("allows a queued message claim after a verified operator Stop", async () => {
    const conversation = createConversation();
    const queuedItem = {
      id: "queued-after-stop",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "dequeue_claimed",
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getLatestGeneration.mockResolvedValue({
      id: "generation-stopped",
      status: "stopped",
      terminalReason: "operator_stop",
    });
    mockChatService.claimNextQueuedMessage.mockResolvedValue(queuedItem);

    const res = await request(createApp())
      .post(`/api/chats/${conversation.id}/queue/next/claim`)
      .send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ item: queuedItem });
    expect(mockChatService.claimNextQueuedMessage).toHaveBeenCalledWith(conversation.id);
  });

  it("rejects local queue mutations for Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const createRes = await request(createApp())
      .post("/api/chats/chat-1/queue")
      .send({
        clientMutationId: "mutation-1",
        payload: { body: "Follow up" },
      });
    const claimRes = await request(createApp())
      .post("/api/chats/chat-1/queue/next/claim")
      .send();
    const releaseRes = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/release-claim")
      .send();
    const patchRes = await request(createApp())
      .patch("/api/chats/chat-1/queue/queued-1")
      .send({ version: 1, payload: { body: "Updated" } });
    const deleteRes = await request(createApp())
      .delete("/api/chats/chat-1/queue/queued-1")
      .send({ version: 1 });
    const steerRes = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({ expectedActiveGenerationId: "10000000-0000-4000-8000-000000000001" });

    for (const res of [createRes, claimRes, releaseRes, patchRes, deleteRes, steerRes]) {
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    }
    expect(mockChatService.createQueuedMessage).not.toHaveBeenCalled();
    expect(mockChatService.claimNextQueuedMessage).not.toHaveBeenCalled();
    expect(mockChatService.releaseQueuedMessageClaim).not.toHaveBeenCalled();
    expect(mockChatService.updateQueuedMessage).not.toHaveBeenCalled();
    expect(mockChatService.cancelQueuedMessage).not.toHaveBeenCalled();
    expect(mockChatService.markQueuedMessageSteerFallback).not.toHaveBeenCalled();
  });

  it("validates and snapshots the submitted message runtime when a queued message is admitted", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValueOnce({
      ...conversation.chatRuntime,
      model: "gpt-5.6-luna",
      effort: "medium",
      available: true,
    });

    const response = await request(createApp())
      .post("/api/chats/chat-1/queue")
      .send({
        clientMutationId: "model-snapshot-1",
        payload: {
          body: "Use the admitted model",
          model: "gpt-5.6-luna",
          effort: "medium",
        },
      });

    expect(response.status).toBe(201);
    expect(mockChatService.createQueuedMessage).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "chat-1",
      runtimeSnapshotVersion: 1,
      payload: expect.objectContaining({
        body: "Use the admitted model",
        agentId: conversation.preferredAgentId,
        model: "gpt-5.6-luna",
        effort: "medium",
      }),
    }));
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith({
      orgId: conversation.orgId,
      preferredAgentId: conversation.preferredAgentId,
      modelOverride: "gpt-5.6-luna",
      effortOverride: "medium",
      contextLinks: conversation.contextLinks,
      planMode: conversation.planMode,
    });
  });

  it("replays a queued mutation before resolving a newer conversation model", async () => {
    const conversation = createConversation({ modelOverride: "gpt-5.6-terra" });
    const replay = {
      id: "queued-existing",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "queued",
      version: 1,
      clientMutationId: "model-snapshot-retry-1",
      payload: {
        body: "Retry after a lost response",
        attachmentIds: [],
        projectId: null,
        skillRefs: [],
        accessMode: null,
        model: "gpt-5.6-terra",
        effort: null,
        metadata: null,
      },
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueuedMessageReplay.mockResolvedValueOnce(replay);

    const response = await request(createApp())
      .post("/api/chats/chat-1/queue")
      .send({
        clientMutationId: "model-snapshot-retry-1",
        payload: {
          body: "Retry after a lost response",
          model: "gpt-5.6-luna",
        },
      });

    expect(response.status).toBe(201);
    expect(response.body).toEqual(expect.objectContaining({
      id: "queued-existing",
      payload: expect.objectContaining({ model: "gpt-5.6-terra" }),
    }));
    expect(mockChatService.getQueuedMessageReplay).toHaveBeenCalledWith({
      conversationId: "chat-1",
      clientMutationId: "model-snapshot-retry-1",
      payload: expect.objectContaining({
        body: "Retry after a lost response",
        model: "gpt-5.6-luna",
      }),
    });
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatService.createQueuedMessage).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.queue.created",
    }));
  });

  it("preserves a non-default model snapshot when queue availability is degraded", async () => {
    const conversation = createConversation({ modelOverride: "gpt-5.6-terra" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValueOnce({
      ...conversation.chatRuntime,
      available: false,
      model: "gpt-5.6-terra",
      error: "Workspace is temporarily unavailable.",
    });

    const response = await request(createApp())
      .post("/api/chats/chat-1/queue")
      .send({
        clientMutationId: "degraded-model-snapshot-1",
        payload: { body: "Keep the admitted model" },
      });

    expect(response.status).toBe(201);
    expect(mockChatService.createQueuedMessage).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ model: "gpt-5.6-terra" }),
    }));
  });

  it("schedules queued feedback after Stop when no in-memory runtime owner remains", async () => {
    const conversation = createConversation();
    const generationId = "10000000-0000-4000-8000-000000000001";
    const controlActionId = "20000000-0000-4000-8000-000000000002";
    const item = {
      id: "queued-1",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "continuation_pending",
      version: 2,
      clientMutationId: "client-1",
      payload: { body: "Use the public API" },
      deliveryIntent: "steer",
      deliveryDisposition: "continuation_pending",
      controlActionId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValueOnce({
      activeGenerationId: generationId,
      activeAttemptEpoch: 1,
      activeControlVersion: 1,
      activeGenerationStatus: "stopped",
      items: [item],
    });
    mockChatService.beginSteerControlAction.mockResolvedValueOnce({
      action: {
        id: controlActionId,
        expectedGenerationId: generationId,
        localDisposition: "continuation_pending",
      },
      item,
      generation: { id: generationId, status: "stopped", attemptEpoch: 1, controlVersion: 1 },
      idempotent: false,
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({
        expectedActiveGenerationId: generationId,
        controlActionId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 1,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      result: "scheduled_next",
      disposition: "continuation_pending",
      activeGenerationId: generationId,
      controlActionId,
      item: { id: "queued-1", status: "continuation_pending" },
    });
    expect(mockChatService.claimSteerProviderSend).not.toHaveBeenCalled();
  });

  it("retries failed actionable feedback through the continuation endpoint with a fresh idempotent action", async () => {
    const conversation = createConversation();
    const freshActionId = "20000000-0000-4000-8000-000000000002";
    const item = {
      id: "queued-1",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "continuation_pending",
      version: 3,
      clientMutationId: "retry-failed-actionable",
      payload: { body: "Retry this confirmed pre-delivery failure" },
      deliveryIntent: "steer",
      deliveryDisposition: "continuation_pending",
      controlActionId: freshActionId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatSteerMessages.scheduleContinuation
      .mockResolvedValueOnce({
        action: {
          id: freshActionId,
          expectedGenerationId: null,
          localDisposition: "continuation_pending",
        },
        item,
        idempotent: false,
      })
      .mockResolvedValueOnce({
        action: {
          id: freshActionId,
          expectedGenerationId: null,
          localDisposition: "continuation_pending",
        },
        item,
        idempotent: true,
      });

    const first = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({ controlActionId: freshActionId });
    const duplicate = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({ controlActionId: freshActionId });

    for (const response of [first, duplicate]) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        result: "scheduled_next",
        disposition: "continuation_pending",
        controlActionId: freshActionId,
        activeGenerationId: null,
        item: { id: "queued-1", status: "continuation_pending", controlActionId: freshActionId },
      });
    }
    expect(mockChatSteerMessages.scheduleContinuation).toHaveBeenCalledTimes(2);
    expect(mockChatSteerMessages.scheduleContinuation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ itemId: "queued-1", controlActionId: freshActionId }),
    );
    expect(mockChatSteerMessages.beginControlAction).not.toHaveBeenCalled();
  });

  it("rejects retrying failed actionable feedback when durable delivery evidence exists", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatSteerMessages.scheduleContinuation.mockRejectedValue(
      conflict("Queued feedback delivery is not safely retryable"),
    );

    const response = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({ controlActionId: "20000000-0000-4000-8000-000000000002" });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Queued feedback delivery is not safely retryable" });
  });

  it("rejects an active-generation retry when queue-side acknowledgement evidence exists", async () => {
    const conversation = createConversation();
    const generationId = "10000000-0000-4000-8000-000000000001";
    const freshActionId = "20000000-0000-4000-8000-000000000002";
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValue({
      activeGenerationId: generationId,
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
      items: [],
    });
    mockChatSteerMessages.beginControlAction.mockRejectedValue(
      conflict("Queued feedback delivery is not safely retryable"),
    );

    const response = await request(createApp())
      .post("/api/chats/chat-1/queue/queued-1/steer")
      .send({
        expectedActiveGenerationId: generationId,
        controlActionId: freshActionId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 0,
      });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Queued feedback delivery is not safely retryable" });
    expect(mockChatSteerMessages.beginControlAction).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "queued-1",
        controlActionId: freshActionId,
        expectedGenerationId: generationId,
      }),
    );
    expect(mockChatSteerMessages.scheduleContinuation).not.toHaveBeenCalled();
  });

  it("retries failed actionable feedback through the active runtime control handle", async () => {
    const conversation = createConversation();
    const generationId = "10000000-0000-4000-8000-000000000001";
    const controlActionId = "20000000-0000-4000-8000-000000000002";
    const item = {
      id: "queued-1",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "steer_pending",
      version: 2,
      clientMutationId: "retry-failed-actionable-active",
      payload: { body: "Retry this confirmed pre-delivery failure" },
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId,
      expectedGenerationId: generationId,
      activeGenerationId: generationId,
      attemptEpoch: 1,
      providerClientMessageId: controlActionId,
      providerThreadId: null,
      providerTurnId: null,
      providerEvidence: null,
      continuationGenerationId: null,
      continuationMessageId: null,
      deliveryLeaseToken: null,
      deliveryLeaseEpoch: 0,
      deliveryLeaseOwner: null,
      deliveryLeaseExpiresAt: null,
      reconciliationReason: null,
      deliveryAttempts: 1,
      lastAttemptAt: new Date(),
      lastDeliveryReason: null,
      sourceMessageId: null,
      deliveredMessageId: null,
      cancelledAt: null,
      steeredAt: null,
      dequeuedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const action = {
      id: controlActionId,
      localDisposition: "pending",
      providerClientMessageId: controlActionId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValue({
      activeGenerationId: generationId,
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
      items: [item],
    });
    mockChatService.beginSteerControlAction.mockResolvedValue({
      action,
      item,
      generation: { id: generationId, attemptEpoch: 1, controlVersion: 1 },
      idempotent: false,
    });
    mockChatService.claimSteerProviderSend.mockResolvedValue(action);
    mockChatService.resolveSteerControlAction.mockImplementation(async (input) => ({
      action: { ...action, localDisposition: input.disposition },
      item: {
        ...item,
        status: input.status,
        deliveryDisposition: input.disposition,
        providerThreadId: input.providerThreadId ?? null,
        providerTurnId: input.providerTurnId ?? null,
        version: 3,
      },
    }));

    const release = claimChatGeneration(conversation.id, new AbortController(), generationId);
    const attempt = await createChatRuntimeControlCoordinator(conversation.id, generationId).beginAttempt({
      attemptIndex: 0,
      runtimeType: "codex_local",
      model: "gpt-primary",
      isFallback: false,
    });
    const steer = vi.fn(async () => ({
      disposition: "accepted_current" as const,
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
    }));
    await attempt.register({
      runtimeType: "codex_local",
      providerThreadId: "thread-1",
      providerTurnId: "turn-1",
      capabilities: { steer: "native", interrupt: "native" },
      steer,
      interrupt: vi.fn(async () => "acknowledged" as const),
      dispose: vi.fn(async () => undefined),
    });

    try {
      const response = await request(createApp())
        .post("/api/chats/chat-1/queue/queued-1/steer")
        .send({
          expectedActiveGenerationId: generationId,
          controlActionId,
          expectedAttemptEpoch: 1,
          expectedControlVersion: 0,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        result: "delivered_current",
        disposition: "accepted_current",
        controlActionId,
        activeGenerationId: generationId,
        item: {
          id: "queued-1",
          status: "accepted_current",
          providerThreadId: "thread-1",
          providerTurnId: "turn-1",
        },
      });
      expect(steer).toHaveBeenCalledWith({
        text: "Retry this confirmed pre-delivery failure",
        clientMessageId: controlActionId,
      });
      expect(mockChatSteerMessages.beginControlAction).toHaveBeenCalledWith(
        expect.objectContaining({
          itemId: "queued-1",
          controlActionId,
          expectedGenerationId: generationId,
        }),
      );
      expect(mockChatSteerMessages.scheduleContinuation).not.toHaveBeenCalled();
      expect(mockChatService.markQueuedMessageSteerFallback).not.toHaveBeenCalled();
    } finally {
      release?.();
    }
  });

  it("freezes and interrupts before scheduling feedback for a runtime without native Steer", async () => {
    const conversation = createConversation();
    const generationId = "10000000-0000-4000-8000-000000000001";
    const controlActionId = "20000000-0000-4000-8000-000000000002";
    const renderedBodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const item = {
      id: "queued-1",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "steer_pending",
      version: 2,
      clientMutationId: "client-1",
      payload: { body: "Use the public API" },
      deliveryIntent: "steer",
      deliveryDisposition: "pending",
      controlActionId,
      expectedGenerationId: generationId,
      activeGenerationId: generationId,
      attemptEpoch: 1,
      providerClientMessageId: controlActionId,
      providerEvidence: null,
    };
    const action = {
      id: controlActionId,
      expectedGenerationId: generationId,
      expectedAttemptEpoch: 1,
      appliedControlVersion: 1,
      localDisposition: "pending",
      providerDisposition: "sent",
      providerClientMessageId: controlActionId,
      providerEvidence: null,
    };
    const continuationItem = {
      ...item,
      status: "continuation_pending",
      deliveryDisposition: "continuation_pending",
      version: 3,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getQueueSnapshot.mockResolvedValue({
      activeGenerationId: generationId,
      activeAttemptEpoch: 1,
      activeControlVersion: 0,
      activeGenerationStatus: "running",
      items: [item],
    });
    mockChatService.beginSteerControlAction.mockResolvedValue({
      action,
      item,
      generation: { id: generationId, attemptEpoch: 1, controlVersion: 1 },
      idempotent: false,
    });
    mockChatService.claimSteerProviderSend.mockResolvedValue(action);
    mockChatService.generationProtocol.beginSteerFallbackCutoff.mockResolvedValue({
      action: {
        ...action,
        localDisposition: "continuation_pending",
        providerDisposition: "not_sent",
        acceptedThroughSeq: 0,
        frozenBodyHash: renderedBodyHash,
      },
      generation: { id: generationId, attemptEpoch: 1, status: "stop_requested" },
      item: continuationItem,
      outputCutoffEvent: { id: "cutoff-1" },
      continuationEvent: { id: "continuation-1" },
      idempotent: false,
    });
    mockChatService.resolveSteerControlAction.mockImplementation(async (input) => ({
      action: { ...action, localDisposition: input.disposition },
      item: {
        ...continuationItem,
        status: input.status,
        deliveryDisposition: input.disposition,
        providerEvidence: input.providerEvidence ?? null,
        version: 4,
      },
    }));

    const abortController = new AbortController();
    const release = claimChatGeneration(conversation.id, abortController, generationId);
    const attempt = await createChatRuntimeControlCoordinator(conversation.id, generationId).beginAttempt({
      attemptIndex: 0,
      runtimeType: "legacy_local",
      model: "legacy-primary",
      isFallback: false,
    });
    const interrupt = vi.fn(async () => "acknowledged" as const);
    const steer = vi.fn();
    await attempt.register({
      runtimeType: "legacy_local",
      capabilities: { steer: "interrupt_continue", interrupt: "process" },
      steer,
      interrupt,
      dispose: vi.fn(async () => undefined),
    });

    try {
      const response = await request(createApp())
        .post("/api/chats/chat-1/queue/queued-1/steer")
        .send({
          expectedActiveGenerationId: generationId,
          controlActionId,
          expectedAttemptEpoch: 1,
          expectedControlVersion: 0,
          lastCommittedRenderSeq: 0,
          renderedBodyHash,
        });

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        result: "scheduled_next",
        disposition: "continuation_pending",
        controlActionId,
        activeGenerationId: generationId,
        item: { id: "queued-1", status: "continuation_pending" },
      });
      expect(mockChatService.generationProtocol.beginSteerFallbackCutoff).toHaveBeenCalledWith({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        generationId,
        expectedAttemptEpoch: 1,
        controlActionId,
        queueItemId: "queued-1",
        requestedRenderSeq: 0,
        requestedBodyHash: renderedBodyHash,
      });
      expect(steer).not.toHaveBeenCalled();
      expect(interrupt).toHaveBeenCalledWith("steer_fallback");
      expect(abortController.signal.aborted).toBe(true);
    } finally {
      release?.();
    }
  });

  it("returns a single chat message transcript for lazy loading", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getMessageTranscript.mockResolvedValueOnce({
      messageId: "message-1",
      transcript: [{ kind: "stdout", ts: "2026-03-26T08:01:00.000Z", text: "output" }],
    });

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages/message-1/transcript");

    expect(res.status).toBe(200);
    expect(mockChatService.getMessageTranscript).toHaveBeenCalledWith("chat-1", "message-1");
    expect(res.body.transcript).toHaveLength(1);
  });

  it("persists server-owned queued continuation transcripts incrementally in the generation ledger", async () => {
    const priorQueueWorkerFlag = process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
    process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = "true";
    const backgroundRuntime = createChatBackgroundRuntime();
    const conversation = createConversation();
    const userMessage = createMessage("message-user-queued", "user", "message", "Continue in background");
    const transcriptEntries = [
      {
        kind: "thinking" as const,
        ts: "2026-07-23T08:00:00.000Z",
        text: "Inspecting the queued continuation",
      },
      {
        kind: "tool_call" as const,
        ts: "2026-07-23T08:00:01.000Z",
        name: "read_file",
        input: { path: "/tmp/queued" },
      },
    ];
    const queuedItem = {
      id: "queued-1",
      orgId: conversation.orgId,
      conversationId: conversation.id,
      position: 1,
      status: "dequeue_claimed",
      version: 2,
      clientMutationId: "queued-client-1",
      payload: { body: "Continue in background" },
      deliveryIntent: "queue",
      deliveryDisposition: null,
      controlActionId: null,
      expectedGenerationId: null,
      activeGenerationId: "generation-1",
      attemptEpoch: 1,
      providerClientMessageId: null,
      providerThreadId: null,
      providerTurnId: null,
      providerEvidence: null,
      continuationGenerationId: "generation-1",
      continuationMessageId: userMessage.id,
      deliveryLeaseToken: "lease-1",
      deliveryLeaseEpoch: 1,
      deliveryLeaseOwner: "worker-1",
      deliveryLeaseExpiresAt: new Date("2026-07-23T08:02:00.000Z"),
      reconciliationReason: "server_claimed",
      deliveryAttempts: 1,
      lastAttemptAt: new Date("2026-07-23T08:00:00.000Z"),
      lastDeliveryReason: null,
      requestActor: {
        type: "board",
        source: "session",
        userId: "user-1",
        orgIds: [conversation.orgId],
        isInstanceAdmin: false,
      },
      sourceMessageId: userMessage.id,
      deliveredMessageId: userMessage.id,
      cancelledAt: null,
      steeredAt: null,
      dequeuedAt: new Date("2026-07-23T08:00:00.000Z"),
      createdAt: new Date("2026-07-23T08:00:00.000Z"),
      updatedAt: new Date("2026-07-23T08:00:00.000Z"),
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getMessage.mockResolvedValue(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.claimNextServerQueuedMessage
      .mockResolvedValueOnce({
        item: queuedItem,
        generationId: "generation-1",
        userMessageId: userMessage.id,
        leaseToken: "lease-1",
        leaseEpoch: 1,
      })
      .mockResolvedValue(null);
    mockChatService.getLatestGeneration.mockResolvedValue({
      id: "generation-1",
      attemptEpoch: 1,
      controlOwnerToken: "lease-1",
    });
    mockChatService.acknowledgeServerQueuedMessageDelivery.mockResolvedValue(queuedItem);
    let transcriptAdmissionCount = 0;
    mockChatService.generationProtocol.appendVisibleEventAndProject.mockImplementation(async (input) => {
      if (input.eventKind === "transcript") {
        transcriptAdmissionCount += 1;
        if (transcriptAdmissionCount === 2) {
          throw conflict("Chat-visible output admission is closed for this generation");
        }
      }
      if (input.eventKind === "runtime_output") {
        throw conflict("Chat-visible output admission is closed for this generation");
      }
      return {
        event: {
          id: `generation-event-${transcriptAdmissionCount}`,
          generationSeq: transcriptAdmissionCount,
          payload: { ...(input.payload ?? {}), bodyHash: input.bodyHash },
        },
        generation: { id: input.generationId },
        message: { id: input.messageId ?? "message-assistant" },
      };
    });
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      const attempt = await input.controlCoordinator?.beginAttempt({
        attemptIndex: 0,
        runtimeType: "codex_local",
        model: "gpt-primary",
        isFallback: false,
      });
      await attempt?.register({
        runtimeType: "codex_local",
        capabilities: { steer: "native", interrupt: "process" },
        steer: async () => ({ disposition: "closing" }),
        interrupt: async () => ({ disposition: "interrupted" }),
        dispose: async () => undefined,
      });
      await input.onTranscriptEntry?.(transcriptEntries[0]);
      await input.onTranscriptEntry?.(transcriptEntries[1]);
      await attempt?.complete();
      return {
        outcome: "completed",
        partialBody: "Queued reply",
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: "Queued reply",
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });

    try {
      createApp(undefined, backgroundRuntime);
      await waitUntil(() => {
        expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalled();
      }, 3_000);

      const visibleProjectionCalls =
        mockChatService.generationProtocol.appendVisibleEventAndProject.mock.calls;
      const transcriptCalls = visibleProjectionCalls.filter(([input]) => input.eventKind === "transcript");
      expect(transcriptCalls).toHaveLength(2);
      expect(transcriptCalls.map(([input]) => input.payload.entry)).toEqual(transcriptEntries);
      expect(transcriptCalls.every(([input]) => !Object.hasOwn(input, "transcript"))).toBe(true);
      expect(transcriptCalls.every(([input]) => input.replyingAgentId === "agent-1")).toBe(true);
      expect(visibleProjectionCalls.find(([input]) => input.eventKind === "runtime_output")?.[0])
        .toMatchObject({ messageId: "message-assistant" });
      expect(mockChatService.acknowledgeServerQueuedMessageDelivery).toHaveBeenCalledWith({
        itemId: queuedItem.id,
        generationId: "generation-1",
        leaseToken: "lease-1",
        leaseEpoch: 1,
      });
      expect(mockChatService.completeServerQueuedMessageDelivery).not.toHaveBeenCalled();
      expect(mockChatService.releaseServerQueuedMessageClaim).not.toHaveBeenCalled();
      expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).toMatchObject({ status: "stopped" });
      expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("transcript");
    } finally {
      if (priorQueueWorkerFlag === undefined) delete process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
      else process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = priorQueueWorkerFlag;
      await backgroundRuntime.close();
    }
  });

  it("does not return a lazy chat transcript without conversation access", async () => {
    mockChatService.getById.mockResolvedValue(null);

    const res = await request(createApp())
      .get("/api/chats/chat-1/messages/message-1/transcript");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Chat conversation not found" });
    expect(mockChatService.getMessageTranscript).not.toHaveBeenCalled();
  });

  it("updates a chat project context after validating organization ownership", async () => {
    const conversation = createConversation();
    const updatedConversation = createConversation({
      contextLinks: [{
        id: "context-project-1",
        orgId: "organization-1",
        conversationId: "chat-1",
        entityType: "project",
        entityId: "10000000-0000-4000-8000-000000000010",
        metadata: null,
        entity: null,
        createdAt: new Date("2026-03-26T08:00:00.000Z"),
        updatedAt: new Date("2026-03-26T08:00:00.000Z"),
      }],
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([]);
    mockProjectService.getById.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000010",
      orgId: "organization-1",
    });
    mockChatService.setProjectContextLink.mockResolvedValue(updatedConversation);

    const res = await request(createApp())
      .post("/api/chats/chat-1/project-context")
      .send({ projectId: "10000000-0000-4000-8000-000000000010" });

    expect(res.status).toBe(200);
    expect(mockProjectService.getById).toHaveBeenCalledWith("10000000-0000-4000-8000-000000000010");
    expect(mockChatService.setProjectContextLink).toHaveBeenCalledWith(
      "chat-1",
      "organization-1",
      "10000000-0000-4000-8000-000000000010",
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "chat.project_context_updated",
        details: { projectId: "10000000-0000-4000-8000-000000000010" },
      }),
    );
  });

  it("rejects local context mutations for Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    mockChatService.getById.mockResolvedValue(conversation);

    const contextLinkRes = await request(createApp())
      .post("/api/chats/chat-1/context-links")
      .send({
        entityType: "project",
        entityId: "10000000-0000-4000-8000-000000000010",
      });
    const projectRes = await request(createApp())
      .post("/api/chats/chat-1/project-context")
      .send({ projectId: "10000000-0000-4000-8000-000000000010" });

    expect(contextLinkRes.status).toBe(409);
    expect(contextLinkRes.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(projectRes.status).toBe(409);
    expect(projectRes.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatService.addContextLink).not.toHaveBeenCalled();
    expect(mockChatService.setProjectContextLink).not.toHaveBeenCalled();
  });

  it("clears a chat project context without project ownership lookup", async () => {
    const conversation = createConversation();
    const updatedConversation = createConversation({ contextLinks: [] });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValueOnce([]);
    mockChatService.setProjectContextLink.mockResolvedValue(updatedConversation);

    const res = await request(createApp())
      .post("/api/chats/chat-1/project-context")
      .send({ projectId: null });

    expect(res.status).toBe(200);
    expect(mockProjectService.getById).not.toHaveBeenCalled();
    expect(mockChatService.setProjectContextLink).toHaveBeenCalledWith(
      "chat-1",
      "organization-1",
      null,
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "chat.project_context_updated",
        details: { projectId: null },
      }),
    );
  });

  it("rejects project context changes after conversation messages exist", async () => {
    const conversation = createConversation({
      contextLinks: [{
        id: "context-project-1",
        orgId: "organization-1",
        conversationId: "chat-1",
        entityType: "project",
        entityId: "10000000-0000-4000-8000-000000000010",
        metadata: null,
        entity: null,
        createdAt: new Date("2026-03-26T08:00:00.000Z"),
        updatedAt: new Date("2026-03-26T08:00:00.000Z"),
      }],
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockProjectService.getById.mockResolvedValue({
      id: "10000000-0000-4000-8000-000000000011",
      orgId: "organization-1",
    });
    mockChatService.listMessages.mockResolvedValue([
      createMessage("message-user", "user", "message", "Keep this project scoped"),
    ]);

    const res = await request(createApp())
      .post("/api/chats/chat-1/project-context")
      .send({ projectId: "10000000-0000-4000-8000-000000000011" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Project context is locked after conversation starts" });
    expect(mockChatService.setProjectContextLink).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "chat.project_context_updated" }),
    );
  });

  it("turns assistant issue proposals into approval-backed proposal messages in manual mode", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need a scoped auth plan");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "This should become an issue.", "approval-1"),
      structuredPayload: {
        issueProposal: {
          title: "Implement auth flow",
          description: "Create a tracked auth implementation task.",
          priority: "high",
          assigneeUnassignedReason: "The operator needs to select the owner during approval.",
          reviewerAgentId: "10000000-0000-4000-8000-000000000077",
        },
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.createProposalApproval.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "This should become an issue.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "issue_proposal",
        body: "This should become an issue.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need a scoped auth plan" });

    expect(res.status).toBe(201);
    expect(mockChatService.createProposalApproval).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        type: "chat_issue_creation",
        payload: expect.objectContaining({
          proposedIssue: expect.objectContaining({
            reviewerAgentId: "10000000-0000-4000-8000-000000000077",
          }),
        }),
      }),
    );
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "issue_proposal",
        approvalId: "approval-1",
      }),
    );
    expect(res.body.messages).toHaveLength(2);
  });

  it("persists assistant ask_user replies without creating approvals", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help deciding scope");
    const askUserPayload = {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow", recommended: true },
              { id: "broad", label: "Broad" },
            ],
            allowFreeform: true,
          },
        ],
      },
    };
    const askUserMessage = {
      ...createMessage("message-ask-user", "assistant", "ask_user", "I need one decision before continuing."),
      structuredPayload: askUserPayload,
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(askUserMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I need one decision before continuing.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "ask_user",
        body: "I need one decision before continuing.",
        structuredPayload: askUserPayload,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help deciding scope" });

    expect(res.status).toBe(201);
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "ask_user",
        approvalId: null,
        structuredPayload: askUserPayload,
      }),
    );
    expect(res.body.messages).toHaveLength(2);
  });

  it("preserves an explicit selected-agent owner on manual approval-backed issue proposals", async () => {
    const conversation = createConversation({
      preferredAgentId: "agent-1",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Chat Specialist",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "codex_local",
        model: "gpt-5",
        available: true,
        error: null,
      },
    });
    const userMessage = createMessage("message-user", "user", "message", "Need the selected agent to own this");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "This should become an assigned issue.", "approval-1"),
      structuredPayload: {
        issueProposal: {
          title: "Implement owned flow",
          description: "Create a tracked implementation task for the selected agent.",
          priority: "medium",
          assigneeAgentId: "agent-1",
        },
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.createProposalApproval.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "This should become an assigned issue.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "issue_proposal",
        body: "This should become an assigned issue.",
        structuredPayload: {
          issueProposal: {
            title: "Implement owned flow",
            description: "Create a tracked implementation task for the selected agent.",
            priority: "medium",
            assigneeAgentId: "agent-1",
          },
        },
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need the selected agent to own this" });

    expect(res.status).toBe(201);
    const approvalInput = mockChatService.createProposalApproval.mock.calls[0]?.[1] as any;
    expect(approvalInput.payload.proposedIssue.assigneeAgentId).toBe("agent-1");
    expect(approvalInput.payload.proposedIssue.assigneeUserId).toBeUndefined();

    const savedMessage = mockChatService.addMessage.mock.calls[0]?.[1] as any;
    expect(savedMessage.structuredPayload.issueProposal.assigneeAgentId).toBe("agent-1");
    expect(savedMessage.structuredPayload.issueProposal.assigneeUserId).toBeUndefined();
    expect(mockAgentService.getById).not.toHaveBeenCalledWith("agent-1");
  });

  it("preserves explicitly unassigned manual approval-backed issue proposals", async () => {
    const conversation = createConversation({
      preferredAgentId: "agent-1",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Chat Specialist",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "codex_local",
        model: "gpt-5",
        available: true,
        error: null,
      },
    });
    const userMessage = createMessage("message-user", "user", "message", "Draft this but do not assign it yet");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "This should stay unassigned until scope is confirmed.", "approval-1"),
      structuredPayload: {
        issueProposal: {
          title: "Clarify owned flow",
          description: "Keep this unassigned until the operator confirms the execution owner.",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
          assigneeUnassignedReason: "The operator asked to confirm scope before choosing an owner.",
        },
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockAgentService.getById.mockResolvedValue({ id: "agent-1", orgId: "organization-1", status: "idle" });
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.createProposalApproval.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "This should stay unassigned until scope is confirmed.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "issue_proposal",
        body: "This should stay unassigned until scope is confirmed.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Draft this but do not assign it yet" });

    expect(res.status).toBe(201);
    const approvalInput = mockChatService.createProposalApproval.mock.calls[0]?.[1] as any;
    expect(approvalInput.payload.proposedIssue.assigneeAgentId).toBeNull();
    expect(approvalInput.payload.proposedIssue.assigneeUserId).toBeNull();
    expect(approvalInput.payload.proposedIssue.assigneeUnassignedReason).toBe("The operator asked to confirm scope before choosing an owner.");

    const savedMessage = mockChatService.addMessage.mock.calls[0]?.[1] as any;
    expect(savedMessage.structuredPayload.issueProposal.assigneeAgentId).toBeNull();
    expect(savedMessage.structuredPayload.issueProposal.assigneeUserId).toBeNull();
    expect(savedMessage.structuredPayload.issueProposal.assigneeUnassignedReason).toBe("The operator asked to confirm scope before choosing an owner.");
  });

  it("keeps plan-mode issue proposals approval-backed without a plan document payload", async () => {
    const conversation = createConversation({ planMode: true });
    const userMessage = createMessage("message-user", "user", "message", "Plan the auth rollout");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "I mapped the rollout plan.", "approval-1"),
      structuredPayload: {
        issueProposal: {
          title: "Implement auth flow",
          description: "Track the auth rollout plan in an issue.",
          priority: "high",
          assigneeUnassignedReason: "Plan mode should leave the execution owner for operator review.",
        },
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.createProposalApproval.mockResolvedValue({
      id: "approval-1",
      orgId: "organization-1",
      type: "chat_issue_creation",
      status: "pending",
      payload: {},
      requestedByAgentId: null,
      requestedByUserId: "user-1",
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I mapped the rollout plan.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "issue_proposal",
        body: "I mapped the rollout plan.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Plan the auth rollout" });

    expect(res.status).toBe(201);
    expect(mockChatService.convertToIssue).not.toHaveBeenCalled();
    expect(mockChatService.createProposalApproval).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        type: "chat_issue_creation",
        payload: expect.objectContaining({
          chatConversationId: "chat-1",
          proposedIssue: expect.objectContaining({
            title: "Implement auth flow",
            description: "Track the auth rollout plan in an issue.",
          }),
        }),
      }),
    );
    expect(mockChatService.createProposalApproval.mock.calls[0]?.[1].payload).not.toHaveProperty("planDocument");
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "issue_proposal",
        approvalId: "approval-1",
        structuredPayload: expect.not.objectContaining({ planDocument: expect.anything() }),
      }),
    );
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "chat.issue_converted" }),
    );
    expect(res.body.messages).toHaveLength(2);
  });

  it("still auto-creates non-plan issue proposals when auto-create mode is enabled", async () => {
    const conversation = createConversation({ issueCreationMode: "auto_create" });
    const userMessage = createMessage("message-user", "user", "message", "Create the issue directly");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "This should become an issue."),
      structuredPayload: {
        issueProposal: {
          title: "Implement direct issue flow",
          description: "Track the direct issue creation path.",
          priority: "medium",
          assigneeUnassignedReason: "The issue is created directly before an owner is chosen.",
        },
      },
    };
    const issue = {
      id: "issue-1",
      orgId: "organization-1",
      identifier: "ISS-1",
      title: "Implement direct issue flow",
    };
    const systemMessage = {
      ...createMessage("message-system", "system", "system_event", "Created issue ISS-1 from this chat conversation."),
      structuredPayload: {
        eventType: "issue_created",
        issueId: "issue-1",
        issueIdentifier: "ISS-1",
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.addMessage.mockResolvedValueOnce(systemMessage);
    mockChatService.convertToIssue.mockResolvedValue(issue);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "This should become an issue.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "issue_proposal",
        body: "This should become an issue.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Create the issue directly" });

    expect(res.status).toBe(201);
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
    expect(mockChatService.convertToIssue).toHaveBeenCalledWith("chat-1", {
      actorUserId: "user-1",
      createdByAgentId: "agent-1",
      messageId: "message-proposal",
    });
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      expect.objectContaining({
        role: "system",
        kind: "system_event",
        structuredPayload: expect.objectContaining({
          eventType: "issue_created",
          issueId: "issue-1",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "chat.issue_converted",
        details: expect.objectContaining({ source: "auto_create" }),
      }),
    );
    expect(res.body.messages).toHaveLength(3);
  });

  it("creates scheduled automations directly from chat assistant automation_create results", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "每天中午 12 点自动发 AI HOT 日报");
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "已创建每日中午 12 点的 AI HOT 日报自动化。"),
      structuredPayload: {
        automationCreate: {
          title: "每天中午 12 点发送 AI HOT 日报",
          instructions: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
          outputMode: "chat_output",
          schedule: {
            cronExpression: "0 12 * * *",
            timezone: "Asia/Shanghai",
          },
        },
        automationCreated: {
          automationId: "automation-1",
          triggerId: "trigger-1",
        },
      },
    };
    const systemMessage = {
      ...createMessage("message-system", "system", "system_event", 'Created automation "每天中午 12 点发送 AI HOT 日报" from this chat conversation.'),
      structuredPayload: {
        eventType: "automation_created",
        automationId: "automation-1",
        automationTitle: "每天中午 12 点发送 AI HOT 日报",
        triggerId: "trigger-1",
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.addMessage.mockResolvedValueOnce(systemMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "已创建每日中午 12 点的 AI HOT 日报自动化。",
      replyingAgentId: "agent-1",
      reply: {
        kind: "automation_create",
        body: "已创建每日中午 12 点的 AI HOT 日报自动化。",
        structuredPayload: {
          automationCreate: {
            title: "每天中午 12 点发送 AI HOT 日报",
            instructions: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
            assigneeAgentId: "00000000-0000-4000-8000-000000000999",
            outputMode: "chat_output",
            schedule: {
              cronExpression: "0 12 * * *",
              timezone: "Asia/Shanghai",
            },
          },
        },
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "每天中午 12 点自动发 AI HOT 日报" });

    expect(res.status).toBe(201);
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
    expect(mockAutomationService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        title: "每天中午 12 点发送 AI HOT 日报",
        assigneeAgentId: "agent-1",
        outputMode: "chat_output",
      }),
      { agentId: "agent-1", userId: "user-1" },
    );
    expect(mockAutomationService.createTrigger).toHaveBeenCalledWith(
      "automation-1",
      expect.objectContaining({
        kind: "schedule",
        cronExpression: "0 12 * * *",
        timezone: "Asia/Shanghai",
      }),
      { agentId: "agent-1", userId: "user-1" },
    );
    expect(mockAutomationService.createTrigger.mock.calls[0]?.[1]).not.toHaveProperty("label");
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      2,
      "chat-1",
      expect.objectContaining({
        role: "system",
        kind: "system_event",
        structuredPayload: expect.objectContaining({
          eventType: "automation_created",
          automationId: "automation-1",
          triggerId: "trigger-1",
        }),
      }),
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "chat.automation_created",
        details: expect.objectContaining({
          automationId: "automation-1",
          source: "automation_create",
        }),
      }),
    );
    expect(res.body.messages).toHaveLength(3);
  });

  it("rejects invalid automation_create schedules before creating an automation", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "每天中午 12 点自动发 AI HOT 日报");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "我来创建自动化。",
      replyingAgentId: "agent-1",
      reply: {
        kind: "automation_create",
        body: "我来创建自动化。",
        structuredPayload: {
          automationCreate: {
            title: "每天中午 12 点发送 AI HOT 日报",
            description: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
            outputMode: "chat_output",
            schedule: {
              cronExpression: "not a cron",
              timezone: "Asia/Shanghai",
            },
          },
        },
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "每天中午 12 点自动发 AI HOT 日报" });

    expect(res.status).toBe(422);
    expect(mockAutomationService.create).not.toHaveBeenCalled();
    expect(mockAutomationService.createTrigger).not.toHaveBeenCalled();
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
  });

  it("passes the current operator profile into chat assistant generation", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Working on it",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Working on it",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(mockOperatorProfileService.get).toHaveBeenCalledWith("user-1");
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorProfile: {
          nickname: "Zee",
          moreAboutYou: "Prefers concise answers",
        },
      }),
    );
  });

  it("persists the first user message as the default title before AI title generation", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Help me debug the release failure");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will inspect it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockRejectedValueOnce(new Error("Fast Intelligence unavailable"));
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will inspect it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will inspect it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Help me debug the release failure" });

    expect(res.status).toBe(201);
    expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Help me debug the release failure");
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
    });
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("generates a new chat title with the organization lightweight model without blocking the assistant reply", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Help me debug the release failure");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will inspect it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "\"Debug release failure\"",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will inspect it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will inspect it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Help me debug the release failure" });

    expect(res.status).toBe(201);
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalled();
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "organization-1",
        purpose: "lightweight",
        feature: "chat_title",
        prompt: expect.stringContaining("Help me debug the release failure"),
      }));
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Help me debug the release failure");
      expect(mockChatService.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
        "chat-1",
        "Help me debug the release failure",
        "Debug release failure",
      );
    });
  });

  it("keeps a numbered fork title after the first new user message when lightweight title generation is unavailable", async () => {
    const conversation = createConversation({
      title: "Inherited source title (2)",
      forkedFromConversationId: "source-chat-1",
      forkedFromMessageId: "source-message-1",
      forkRootConversationId: "source-chat-1",
    });
    const userMessage = createMessage("message-user", "user", "message", "What if we branch into a launch checklist?");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will outline it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will outline it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will outline it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "What if we branch into a launch checklist?" });

    expect(res.status).toBe(201);
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.updateDefaultTitle).not.toHaveBeenCalled();
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("does not use configured lightweight title generation for a numbered fork", async () => {
    const conversation = createConversation({
      title: "Inherited AI source title (2)",
      forkedFromConversationId: "source-chat-1",
      forkedFromMessageId: "source-message-1",
      forkRootConversationId: "source-chat-1",
    });
    const userMessage = createMessage("message-user", "user", "message", "Explore a pricing fork for team plans");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will compare team plans.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will compare team plans.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will compare team plans.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Explore a pricing fork for team plans" });

    expect(res.status).toBe(201);
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.updateDefaultTitle).not.toHaveBeenCalled();
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("keeps a numbered nested fork title after its first user message", async () => {
    const conversation = createConversation({
      title: "Inherited source title (3)",
      forkedFromConversationId: "source-chat-2",
      forkedFromMessageId: "source-message-2",
      forkRootConversationId: "source-chat-1",
    });
    const userMessage = createMessage("message-nested-user", "user", "message", "Name the current nested branch");
    const assistantMessage = createMessage("message-nested-assistant", "assistant", "message", "I will name it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will name it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will name it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Name the current nested branch" });

    expect(res.status).toBe(201);
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.updateDefaultTitle).not.toHaveBeenCalled();
    expect(mockChatService.replaceSystemGeneratedTitle).not.toHaveBeenCalled();
  });

  it("regenerates an existing chat title with the organization lightweight model", async () => {
    const conversation = createConversation({ title: "Old vague title" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listRecentUserMessages.mockResolvedValue([
      createMessage("message-user", "user", "message", "Audit recent user feedback and runtime failures"),
    ]);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      resultJson: { stdout: "Feedback Runtime Audit" },
    });
    mockChatService.update.mockResolvedValueOnce(createConversation({ title: "Feedback Runtime Audit" }));

    const res = await request(createApp())
      .post("/api/chats/chat-1/title/regenerate")
      .send();

    expect(res.status).toBe(200);
    expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      purpose: "lightweight",
      feature: "chat_title",
      prompt: expect.stringContaining("Audit recent user feedback and runtime failures"),
    }));
    expect(mockChatService.update).toHaveBeenCalledWith("chat-1", { title: "Feedback Runtime Audit" });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.title_regenerated",
      entityType: "chat",
      entityId: "chat-1",
      details: expect.objectContaining({
        previousTitle: "Old vague title",
        title: "Feedback Runtime Audit",
      }),
    }));
  });

  it("loads only the latest five user messages for title regeneration", async () => {
    const conversation = createConversation({ title: "Old title" });
    mockChatService.getById.mockResolvedValue(conversation);
    const recentUserMessages = Array.from({ length: 5 }, (_, index) =>
      createMessage(`recent-user-${index}`, "user", "message", `Recent user request ${index + 1}`),
    );
    mockChatService.listRecentUserMessages.mockResolvedValue(recentUserMessages);
    mockChatService.listMessages.mockResolvedValue([
      createMessage("older-user", "user", "message", "Older context that must not be loaded"),
      ...recentUserMessages,
      createMessage("latest-assistant", "assistant", "message", "Latest migration answer"),
    ]);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Latest Migration",
    });
    mockChatService.update.mockResolvedValueOnce(createConversation({ title: "Latest Migration" }));

    const res = await request(createApp())
      .post("/api/chats/chat-1/title/regenerate")
      .send();

    expect(res.status).toBe(200);
    expect(mockChatService.listRecentUserMessages).toHaveBeenCalledWith("chat-1", 5);
    expect(mockChatService.listMessages).not.toHaveBeenCalled();
    const prompt = mockProductIntelligenceService.execute.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("Recent user request 1");
    expect(prompt).toContain("Recent user request 5");
    expect(prompt).not.toContain("Latest migration answer");
    expect(prompt).not.toContain("Older context that must not be loaded");
  });

  it("returns 422 without updating when Fast Intelligence is not configured for title regeneration", async () => {
    const conversation = createConversation({ title: "Existing title" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listRecentUserMessages.mockResolvedValue([
      createMessage("message-user", "user", "message", "Find the right title"),
    ]);
    mockProductIntelligenceService.execute.mockRejectedValueOnce(unprocessable("Fast Intelligence is not configured"));

    const res = await request(createApp())
      .post("/api/chats/chat-1/title/regenerate")
      .send();

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Fast Intelligence is not configured" });
    expect(mockChatService.update).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.title_regenerated",
    }));
  });

  it("requires board access to regenerate a chat title", async () => {
    const res = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      runId: null,
    }))
      .post("/api/chats/chat-1/title/regenerate")
      .send();

    expect(res.status).toBe(403);
    expect(mockChatService.getById).not.toHaveBeenCalled();
    expect(mockProductIntelligenceService.execute).not.toHaveBeenCalled();
    expect(mockChatService.update).not.toHaveBeenCalled();
  });

  it("regenerates titles for Feishu-bound chat conversations without enabling local chat mutation", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());
    mockChatService.listRecentUserMessages.mockResolvedValue([
      createMessage("message-user", "user", "message", "hi, what skill do you have?"),
    ]);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Available Skills Inquiry",
    });
    mockChatService.update.mockResolvedValueOnce(createFeishuBackedConversation({ title: "Available Skills Inquiry" }));

    const res = await request(createApp())
      .post("/api/chats/chat-1/title/regenerate")
      .send();

    expect(res.status).toBe(200);
    expect(mockChatService.listRecentUserMessages).toHaveBeenCalledWith("chat-1", 5);
    expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      purpose: "lightweight",
      feature: "chat_title",
      prompt: expect.stringContaining("hi, what skill do you have?"),
    }));
    expect(mockChatService.update).toHaveBeenCalledWith("chat-1", { title: "Available Skills Inquiry" });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.title_regenerated",
      entityId: "chat-1",
      details: expect.objectContaining({ title: "Available Skills Inquiry" }),
    }));
  });

  it("rejects archiving Feishu-bound chat conversations", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ status: "archived" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Fork this Feishu chat to continue in Rudder");
    expect(mockChatService.update).not.toHaveBeenCalled();
  });

  it("persists a conversation model override and records it as activity evidence", async () => {
    const conversation = createConversation();
    const updated = createConversation({
      modelOverride: "gpt-5.6-terra",
      chatRuntime: { ...conversation.chatRuntime, model: "gpt-5.6-terra" },
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.updateAgentModelInvariant.mockResolvedValueOnce(updated);

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ modelOverride: "gpt-5.6-terra" });

    expect(res.status).toBe(200);
    expect(mockChatService.updateAgentModelInvariant).toHaveBeenCalledWith({
      id: "chat-1",
      expectedPreferredAgentId: "agent-1",
      patch: {
        modelOverride: "gpt-5.6-terra",
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.updated",
      details: { modelOverride: "gpt-5.6-terra" },
    }));
  });

  it("persists a conversation effort override without changing the Agent runtime", async () => {
    const conversation = createConversation();
    const updated = createConversation({
      effortOverride: "xhigh",
      chatRuntime: { ...conversation.chatRuntime, effort: "xhigh" },
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.updateAgentModelInvariant.mockResolvedValueOnce(updated);

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ effortOverride: "xhigh" });

    expect(res.status).toBe(200);
    expect(mockChatService.updateAgentModelInvariant).toHaveBeenCalledWith({
      id: "chat-1",
      expectedPreferredAgentId: "agent-1",
      patch: {
        effortOverride: "xhigh",
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.updated",
      details: { effortOverride: "xhigh" },
    }));
  });

  it("restores the Agent default by clearing the conversation model override", async () => {
    const conversation = createConversation({ modelOverride: "gpt-5.6-terra" });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.updateAgentModelInvariant.mockResolvedValueOnce(createConversation({ modelOverride: null }));

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ modelOverride: null });

    expect(res.status).toBe(200);
    expect(mockChatService.updateAgentModelInvariant).toHaveBeenCalledWith({
      id: "chat-1",
      expectedPreferredAgentId: "agent-1",
      patch: {
        modelOverride: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: { modelOverride: null },
    }));
  });

  it("repairs a historical unassigned conversation and clears its stale model override", async () => {
    const nextAgentId = "10000000-0000-4000-8000-000000000005";
    mockChatService.getById.mockResolvedValue(createConversation({
      preferredAgentId: null,
      modelOverride: "gpt-5.6-terra",
    }));
    mockAgentService.getById.mockResolvedValue({
      id: nextAgentId,
      orgId: "organization-1",
      status: "idle",
    });
    mockChatService.updateAgentModelInvariant.mockResolvedValueOnce(createConversation({
      preferredAgentId: nextAgentId,
      modelOverride: null,
    }));

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ preferredAgentId: nextAgentId });

    expect(res.status).toBe(200);
    expect(mockChatService.updateAgentModelInvariant).toHaveBeenCalledWith({
      id: "chat-1",
      expectedPreferredAgentId: null,
      patch: {
        preferredAgentId: nextAgentId,
        modelOverride: null,
        effortOverride: null,
      },
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      details: {
        preferredAgentId: nextAgentId,
        modelOverride: null,
        effortOverride: null,
      },
    }));
  });

  it("rejects changing the Agent on an assigned persisted conversation", async () => {
    const nextAgentId = "10000000-0000-4000-8000-000000000005";
    mockChatService.getById.mockResolvedValue(createConversation({
      preferredAgentId: "agent-1",
    }));
    mockAgentService.getById.mockResolvedValue({
      id: nextAgentId,
      orgId: "organization-1",
      status: "idle",
    });

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ preferredAgentId: nextAgentId });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Chat agent is locked after the conversation starts");
    expect(mockChatService.updateAgentModelInvariant).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.updated",
    }));
  });

  it("renames Feishu-bound chat conversations without enabling other local mutation fields", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());
    mockChatService.update.mockResolvedValueOnce(createFeishuBackedConversation({ title: "Renamed Feishu Chat" }));

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send({ title: "Renamed Feishu Chat" });

    expect(res.status).toBe(200);
    expect(mockChatService.update).toHaveBeenCalledWith("chat-1", { title: "Renamed Feishu Chat" });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "chat.updated",
      entityId: "chat-1",
      details: { title: "Renamed Feishu Chat" },
    }));
  });

  it.each([
    ["summary", { title: "Renamed Feishu Chat", summary: "Local summary update" }],
    ["preferred agent", { title: "Renamed Feishu Chat", preferredAgentId: "10000000-0000-4000-8000-000000000001" }],
    ["model override", { title: "Renamed Feishu Chat", modelOverride: "gpt-5.6-terra" }],
    ["effort override", { title: "Renamed Feishu Chat", effortOverride: "xhigh" }],
    ["primary issue", { title: "Renamed Feishu Chat", primaryIssueId: "10000000-0000-4000-8000-000000000002" }],
    ["routed agent", { title: "Renamed Feishu Chat", routedAgentId: "10000000-0000-4000-8000-000000000003" }],
    ["issue creation mode", { title: "Renamed Feishu Chat", issueCreationMode: "auto_create" }],
    ["plan mode", { title: "Renamed Feishu Chat", planMode: true }],
    ["context links", {
      title: "Renamed Feishu Chat",
      contextLinks: [{ entityType: "issue", entityId: "10000000-0000-4000-8000-000000000004" }],
    }],
    ["status", { title: "Renamed Feishu Chat", status: "archived" }],
  ])("rejects mixed title and %s patches for Feishu-bound chat conversations", async (_label, payload) => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .patch("/api/chats/chat-1")
      .send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Fork this Feishu chat to continue in Rudder");
    expect(mockChatService.update).not.toHaveBeenCalled();
  });

  it("falls back to the first user message when lightweight title generation is not configured", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockRejectedValueOnce(new Error("No lightweight profile configured"));
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Working on it",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Working on it",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalled();
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Need help");
    });
  });

  it("falls back to the first user message instead of failed lightweight title output", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need a migration plan");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "Migration plan",
      errorMessage: "model failed",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Working on it",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Working on it",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need a migration plan" });

    expect(res.status).toBe(201);
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Need a migration plan");
    });
  });

  it("bounds long chat title generation prompts", async () => {
    const conversation = createConversation();
    const longBody = `BEGINNING_MARKER ${"发布计划与回归检查 ".repeat(500)} ENDING_MARKER`;
    const userMessage = createMessage("message-user", "user", "message", longBody);
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Long input summary",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Working on it",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Working on it",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: longBody });

    expect(res.status).toBe(201);
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
    });
    const prompt = mockProductIntelligenceService.execute.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain("BEGINNING_MARKER");
    expect(prompt).toContain(" ... ");
    expect(prompt).toContain("ENDING_MARKER");
    expect(countChatTitlePromptTokens(prompt)).toBeLessThanOrEqual(CHAT_TITLE_PROMPT_TOKEN_LIMIT);
  });

  it("does not use process transcript text as the failed non-stream message body", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const failedMessage = {
      ...createMessage("message-assistant", "assistant", "message", "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready."),
      status: "failed",
      structuredPayload: {
        recoverableFailure: {
          recoverable: true,
          code: "chat_runtime_exception",
          message: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
          runId: null,
        },
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(failedMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onTranscriptEntry?.({
        kind: "assistant",
        ts: "2026-03-26T08:01:01.000Z",
        text: "I will inspect the issue first.",
        delta: true,
      });
      await input.onObservedTranscriptEntry?.({
        kind: "assistant",
        ts: "2026-03-26T08:01:01.000Z",
        text: "I will inspect the issue first.",
        delta: true,
      });
      const { ChatAssistantStreamError } = await import("../services/chat-assistant.js");
      throw new ChatAssistantStreamError("runtime process exited", "I will inspect the issue first.");
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(res.body.messages).toEqual([
      expect.objectContaining({ id: userMessage.id, role: "user", body: "Need help" }),
      expect.objectContaining({
        id: failedMessage.id,
        role: "assistant",
        status: "failed",
        body: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
        structuredPayload: failedMessage.structuredPayload,
      }),
    ]);
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        status: "failed",
        body: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
        structuredPayload: {
          recoverableFailure: {
            recoverable: true,
            code: "chat_runtime_exception",
            message: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
            runId: null,
          },
        },
        transcript: [expect.objectContaining({ kind: "assistant", text: "I will inspect the issue first." })],
      }),
    );
  });

  it("persists runtime boot failures as non-retryable chat messages", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const failurePayload = {
      recoverableFailure: {
        recoverable: false,
        retryable: false,
        phase: "runtime_boot",
        action: "repair_runtime",
        code: "chat_runtime_boot_failed",
        message: "The assistant runtime did not start successfully. Fix the runtime command or environment, then run again.",
        runId: null,
      },
    };
    const failedMessage = {
      ...createMessage("message-assistant", "assistant", "message", failurePayload.recoverableFailure.message),
      status: "failed",
      structuredPayload: failurePayload,
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(failedMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async () => {
      const { ChatAssistantStreamError } = await import("../services/chat-assistant.js");
      throw new ChatAssistantStreamError("Codex exited with code 137", "", [], {
        errorCode: "chat_runtime_boot_failed",
        userMessage: failurePayload.recoverableFailure.message,
        retryable: false,
        failurePhase: "runtime_boot",
        action: "repair_runtime",
      });
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(res.body.messages).toEqual([
      expect.objectContaining({ id: userMessage.id, role: "user", body: "Need help" }),
      expect.objectContaining({
        id: failedMessage.id,
        role: "assistant",
        status: "failed",
        body: failurePayload.recoverableFailure.message,
        structuredPayload: failurePayload,
      }),
    ]);
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        status: "failed",
        body: failurePayload.recoverableFailure.message,
        structuredPayload: failurePayload,
      }),
    );
  });

  it("starts a fresh generation when retrying a turn whose prior generation lost control", async () => {
    const conversation = createConversation();
    const originalUserMessage = createMessage(
      "10000000-0000-4000-8000-000000000091",
      "user",
      "message",
      "Try this work",
    );
    const priorFailedMessage = {
      ...createMessage(
        "10000000-0000-4000-8000-000000000092",
        "assistant",
        "message",
        "The prior runtime owner was lost.",
      ),
      status: "failed",
      generationId: "generation-control-lost",
      structuredPayload: {
        recoverableFailure: {
          recoverable: true,
          code: "control_lost",
          message: "The prior runtime owner was lost.",
        },
      },
    };
    const retryUserMessage = {
      ...createMessage(
        "10000000-0000-4000-8000-000000000093",
        "user",
        "message",
        "Try this work",
      ),
      turnVariant: 1,
    };
    const retryAssistantMessage = {
      ...createMessage(
        "10000000-0000-4000-8000-000000000094",
        "assistant",
        "message",
        "Fresh attempt completed.",
      ),
      generationId: "generation-retry",
      turnVariant: 1,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(retryUserMessage);
    mockChatService.listMessages.mockResolvedValue([
      originalUserMessage,
      priorFailedMessage,
      retryUserMessage,
    ]);
    mockChatService.createGeneration.mockResolvedValueOnce({
      id: "generation-retry",
      attemptEpoch: 0,
      controlVersion: 0,
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
    });
    mockChatService.getLatestGeneration.mockResolvedValue({
      id: "generation-retry",
      attemptEpoch: 1,
      controlOwnerToken: "retry-runtime-owner",
    });
    mockChatService.addMessage.mockResolvedValueOnce(retryAssistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementationOnce(async (input) => {
      const attempt = await input.controlCoordinator.beginAttempt({
        attemptIndex: 0,
        runtimeType: "codex_local",
        model: "gpt-5.4",
        isFallback: false,
      });
      await attempt.complete();
      return {
        outcome: "completed",
        partialBody: retryAssistantMessage.body,
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: retryAssistantMessage.body,
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({
        body: originalUserMessage.body,
        editUserMessageId: originalUserMessage.id,
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatService.createGeneration).toHaveBeenCalledTimes(1);
    expect(mockChatService.beginGenerationControlAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: "generation-retry",
        attemptEpoch: 1,
      }),
    );
    expect(mockChatService.beginGenerationControlAttempt).not.toHaveBeenCalledWith(
      expect.objectContaining({ generationId: "generation-control-lost" }),
    );
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: "generation-retry",
        expectedAttemptEpoch: 1,
        finalStatus: "completed",
      }),
    );
  });

  it("records pre-attempt skill preparation failures as actionable failures instead of stale control", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Use the selected skill");
    const actionableMessage =
      'Could not prepare organization skill "build-advisor". '
      + "Check that its installed files are available, then retry.";
    const failedMessage = {
      ...createMessage(
        "message-assistant",
        "assistant",
        "message",
        actionableMessage,
      ),
      status: "failed",
      structuredPayload: {
        recoverableFailure: {
          recoverable: true,
          code: "chat_runtime_preparation_failed",
          message: actionableMessage,
          runId: null,
          phase: "runtime_boot",
          action: "retry",
        },
      },
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.createGeneration.mockResolvedValueOnce({
      id: "generation-prep-failed",
      attemptEpoch: 0,
      controlVersion: 0,
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
    });
    mockChatService.getLatestGeneration.mockResolvedValue({
      id: "generation-prep-failed",
      attemptEpoch: 0,
      controlOwnerToken: null,
      controlLeaseExpiresAt: null,
    });
    mockChatService.addMessage.mockResolvedValueOnce(failedMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementationOnce(async () => {
      const { ChatAssistantStreamError } = await import("../services/chat-assistant.js");
      throw new ChatAssistantStreamError(
        'Chat runtime preparation failed for organization skill "build-advisor"',
        "",
        [],
        {
          errorCode: "chat_runtime_preparation_failed",
          userMessage: actionableMessage,
          retryable: true,
          failurePhase: "runtime_boot",
          action: "retry",
        },
      );
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: userMessage.body })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: actionableMessage,
      errorCode: "chat_runtime_preparation_failed",
      messageId: failedMessage.id,
    });
    expect(JSON.stringify(events)).not.toContain("/Users/alice");
    expect(JSON.stringify(events)).not.toContain("secret-token.json");
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({
        status: "failed",
        body: actionableMessage,
        structuredPayload: failedMessage.structuredPayload,
      }),
    );
    expect(JSON.stringify(mockChatService.addMessage.mock.calls)).not.toContain("/Users/alice");
    expect(JSON.stringify(mockChatService.addMessage.mock.calls)).not.toContain("secret-token.json");
    expect(mockChatService.beginGenerationControlAttempt).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: "generation-prep-failed",
        expectedAttemptEpoch: 0,
        finalStatus: "failed",
        terminalReason: "failed",
      }),
    );
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalledWith(
      expect.objectContaining({ terminalReason: "control_owner_stale" }),
    );
  });

  it("stores generated assistant images as chat attachments", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Generate a UI");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Generated a mockup.");
    const generatedAttachment = {
      id: "attachment-generated",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-assistant",
      assetId: "asset-generated",
      provider: "local_disk",
      objectKey: "chats/chat-1/generated/ig_test.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256-generated",
      originalFilename: "ig_test.png",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      contentPath: "/api/assets/asset-generated/content",
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.createAttachment.mockResolvedValueOnce(generatedAttachment);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: "chats/chat-1/generated/ig_test.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256-generated",
      originalFilename: "ig_test.png",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Generated a mockup.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Generated a mockup.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
        generatedAttachments: [{
          source: "codex_image_generation",
          originalFilename: "ig_test.png",
          contentType: "image/png",
          body: Buffer.from("fake-png"),
          toolCallId: "ig_test",
        }],
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Generate a UI" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      namespace: "chats/chat-1/generated",
      originalFilename: "ig_test.png",
      contentType: "image/png",
      body: Buffer.from("fake-png"),
    }));
    expect(mockChatService.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-assistant",
      createdByAgentId: "agent-1",
      createdByUserId: null,
    }));

    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "final",
      messages: [
        expect.objectContaining({
          id: "message-assistant",
          attachments: [expect.objectContaining({ id: "attachment-generated", contentPath: "/api/assets/asset-generated/content" })],
        }),
      ],
    }));
  });

  it("archives inline visuals and persists a server-owned attachment mapping", async () => {
    const conversation = createConversation();
    const body = 'Interactive chart\n::codex-inline-vis{file="chart.html"}';
    const userMessage = createMessage("message-user", "user", "message", "Make a chart");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", body);
    const generatedAttachment = {
      id: "attachment-visual",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-assistant",
      assetId: "asset-visual",
      provider: "local_disk",
      objectKey: "private-object-key",
      contentType: "text/html",
      byteSize: 28,
      sha256: "sha256-visual",
      originalFilename: "chart.html",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      contentPath: "/api/assets/asset-visual/content",
      createdAt: new Date("2026-07-15T08:01:00.000Z"),
      updatedAt: new Date("2026-07-15T08:01:00.000Z"),
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.createAttachment.mockResolvedValueOnce(generatedAttachment);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: "private-object-key",
      contentType: "text/html",
      byteSize: 28,
      sha256: "sha256-visual",
      originalFilename: "chart.html",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: body,
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body,
        structuredPayload: null,
        replyingAgentId: "agent-1",
        inlineVisuals: [{ directiveIndex: 0, file: "chart.html", status: "captured" }],
        generatedAttachments: [{
          source: "codex_inline_visual",
          originalFilename: "chart.html",
          contentType: "text/html",
          body: Buffer.from('<div id="widget">Chart</div>'),
          directiveIndex: 0,
          directiveFile: "chart.html",
        }],
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Make a chart" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      namespace: "chats/chat-1/generated",
      originalFilename: "chart.html",
      contentType: "text/html",
    }));
    expect(mockChatService.updateMessageInternalInlineVisuals).toHaveBeenCalledWith(
      "chat-1",
      "message-assistant",
      {
        inlineVisuals: [{
          directiveIndex: 0,
          file: "chart.html",
          status: "ready",
          attachmentId: "attachment-visual",
        }],
      },
    );
    expect(String(res.body)).not.toContain("private-object-key");
  });

  it("persists a runtime-neutral visual as reserved message presentation metadata", async () => {
    const conversation = createConversation();
    const body = 'Capacity\n::rudder-inline-vis{slot="0"}';
    const userMessage = createMessage("message-user", "user", "message", "Make a capacity view");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", body);
    const sha256 = "a".repeat(64);
    const generatedAttachment = {
      id: "attachment-visual-v1",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-assistant",
      assetId: "asset-visual-v1",
      provider: "local_disk",
      objectKey: "private-v1-object-key",
      contentType: "text/html",
      byteSize: 38,
      sha256,
      originalFilename: "inline-visual-1.html",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      contentPath: "/api/assets/asset-visual-v1/content",
      createdAt: new Date("2026-07-21T08:01:00.000Z"),
      updatedAt: new Date("2026-07-21T08:01:00.000Z"),
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.createAttachment.mockResolvedValueOnce(generatedAttachment);
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: "private-v1-object-key",
      contentType: "text/html",
      byteSize: 38,
      sha256,
      originalFilename: "inline-visual-1.html",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: body,
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body,
        structuredPayload: null,
        replyingAgentId: "agent-1",
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "captured",
          byteSize: 38,
        }],
        generatedAttachments: [{
          source: "rudder_inline_visual",
          originalFilename: "inline-visual-1.html",
          contentType: "text/html",
          body: Buffer.from('<div id="widget">Balanced</div>'),
          slot: 0,
        }],
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Make a capacity view" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatService.updateMessageInternalInlineVisuals).toHaveBeenCalledWith(
      "chat-1",
      "message-assistant",
      {
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "ready",
          attachmentId: "attachment-visual-v1",
          contentType: "text/html",
          byteSize: 38,
          sha256,
        }],
      },
    );
    expect(String(res.body)).not.toContain("private-v1-object-key");
    expect(String(res.body)).not.toContain("<div id=\\\"widget\\\"");
  });

  it("removes a just-created visual attachment and object when trusted mapping persistence fails", async () => {
    const conversation = createConversation();
    const body = 'Capacity\n::rudder-inline-vis{slot="0"}';
    const userMessage = createMessage("message-user", "user", "message", "Make a capacity view");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", body);
    const sha256 = "c".repeat(64);
    const generatedAttachment = {
      id: "attachment-cleanup-v1",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-assistant",
      assetId: "asset-cleanup-v1",
      provider: "local_disk",
      objectKey: "private-cleanup-object-key",
      contentType: "text/html",
      byteSize: 38,
      sha256,
      originalFilename: "inline-visual-1.html",
      createdByAgentId: "agent-1",
      createdByUserId: null,
      contentPath: "/api/assets/asset-cleanup-v1/content",
      createdAt: new Date("2026-07-21T08:01:00.000Z"),
      updatedAt: new Date("2026-07-21T08:01:00.000Z"),
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatService.createAttachment.mockResolvedValueOnce(generatedAttachment);
    mockChatService.updateMessageInternalInlineVisuals.mockRejectedValueOnce(new Error("mapping write failed"));
    mockChatService.removeAttachment.mockResolvedValueOnce({
      orgId: "organization-1",
      objectKey: "private-cleanup-object-key",
      assetDeleted: true,
    });
    mockStorage.putFile.mockResolvedValueOnce({
      provider: "local_disk",
      objectKey: "private-cleanup-object-key",
      contentType: "text/html",
      byteSize: 38,
      sha256,
      originalFilename: "inline-visual-1.html",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: body,
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body,
        structuredPayload: null,
        replyingAgentId: "agent-1",
        inlineVisualsV1: [{
          version: 1,
          slot: 0,
          file: "inline-visual-1.html",
          status: "captured",
          byteSize: 38,
        }],
        generatedAttachments: [{
          source: "rudder_inline_visual",
          originalFilename: "inline-visual-1.html",
          contentType: "text/html",
          body: Buffer.from('<div id="widget">Balanced</div>'),
          slot: 0,
        }],
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Make a capacity view" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatService.removeAttachment).toHaveBeenCalledWith("attachment-cleanup-v1");
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      "organization-1",
      "private-cleanup-object-key",
    );
    expect(String(res.body)).not.toContain("private-cleanup-object-key");
  });

  it("does not persist a captured inline visual when the final reply removed its directive", async () => {
    const conversation = createConversation();
    const body = "The final reply no longer contains a visual.";
    const userMessage = createMessage("message-user", "user", "message", "Make a chart");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", body);

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: body,
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body,
        structuredPayload: null,
        replyingAgentId: "agent-1",
        inlineVisuals: [{ directiveIndex: 0, file: "chart.html", status: "captured" }],
        generatedAttachments: [{
          source: "codex_inline_visual",
          originalFilename: "chart.html",
          contentType: "text/html",
          body: Buffer.from('<div id="widget">Stale chart</div>'),
          directiveIndex: 0,
          directiveFile: "chart.html",
        }],
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Make a chart" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createAttachment).not.toHaveBeenCalled();
    expect(mockChatService.updateMessage).toHaveBeenCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        body,
        status: "completed",
        structuredPayload: null,
      }),
    );
  });

  it("persists the selected agent as replyingAgentId for preferred-agent chats", async () => {
    const conversation = createConversation({
      preferredAgentId: "agent-1",
      chatRuntime: {
        sourceType: "agent",
        sourceLabel: "Builder",
        runtimeAgentId: "agent-1",
        agentRuntimeType: "codex_local",
        model: "gpt-5",
        available: true,
        error: null,
      },
    });
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Working on it"),
      replyingAgentId: "agent-1",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValueOnce({
      available: true,
      sourceType: "agent",
      sourceLabel: "Builder",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      error: null,
    });
    mockChatAssistantService.enrichConversation.mockImplementationOnce(async () => conversation);
    mockChatAssistantService.streamChatAssistantReply.mockImplementationOnce(async (input) => {
      await input.onRunCreated?.("chat-run-1");
      return {
        outcome: "completed",
        partialBody: "Working on it",
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: "Working on it",
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "message",
        replyingAgentId: "agent-1",
        runId: "chat-run-1",
      }),
    );
    expect(mockChatAgentRuns.linkAssistantMessage).toHaveBeenCalledWith("chat-run-1", "chat-1", "message-assistant");
  });

  it("accepts assistant runtimes that provide optional invocation metadata", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");
    const runtimePrompt = [
      "You are Chat Specialist, handling the current task and communicating with the user through Rudder Chat.",
      "",
      "<recent_rudder_context>",
      "#### today memory: 2026-06-19.md",
      "- Chat startup memory signal",
      "",
      "#### recent chats",
      "1. `chat-previous` |||| 2026-06-19T00:00:00.000Z |||| Previous |||| private chat snippet",
      "</recent_rudder_context>",
      "",
      "## Conversation input",
      "{}",
    ].join("\n");
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onInvocationMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/chat-runtime",
        commandNotes: ["Loaded agent instructions from /tmp/agent-instructions.md"],
        loadedSkills: [
          {
            key: "analysis",
            runtimeName: "analysis",
            name: "Analysis",
            description: "Analysis helpers",
          },
          {
            key: "checks",
            runtimeName: "checks",
            name: "Checks",
            description: "Verification helpers",
          },
        ],
        prompt: runtimePrompt,
        promptMetrics: {
          promptChars: 85,
        },
        context: {},
      });
      return {
        outcome: "completed",
        partialBody: "Working on it",
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: "Working on it",
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need help" });

    expect(res.status).toBe(201);
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledOnce();
  });

  it("streams ack, transcript entries, deltas, and final persisted messages", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Streaming reply");
    const runtimePrompt = "You are Chat Specialist in streaming mode.\n\nConversation input:\n{}";

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onRunCreated?.("chat-run-stream-1");
      await input.onInvocationMeta?.({
        agentRuntimeType: "codex_local",
        command: "codex",
        cwd: "/tmp/chat-runtime",
        commandNotes: [],
        loadedSkills: [],
        prompt: runtimePrompt,
        promptMetrics: {
          promptChars: runtimePrompt.length,
        },
        context: {},
      });
      await input.onAssistantState?.("streaming");
      await input.onTranscriptEntry?.({
        kind: "thinking",
        ts: "2026-03-26T08:01:01.000Z",
        text: "Inspecting current request",
      });
      await input.onObservedTranscriptEntry?.({
        kind: "thinking",
        ts: "2026-03-26T08:01:01.000Z",
        text: "Inspecting current request",
      });
      await input.onTranscriptEntry?.({
        kind: "tool_call",
        ts: "2026-03-26T08:01:02.000Z",
        name: "read_file",
        toolUseId: "tool-1",
        input: { path: "ui/src/pages/Chat.tsx" },
      });
      await input.onObservedTranscriptEntry?.({
        kind: "tool_call",
        ts: "2026-03-26T08:01:02.000Z",
        name: "read_file",
        toolUseId: "tool-1",
        input: { path: "ui/src/pages/Chat.tsx" },
      });
      await input.onAssistantDelta?.("Streaming ");
      await input.onAssistantDelta?.("reply");
      await input.onAssistantState?.("finalizing");
      return {
        outcome: "completed",
        partialBody: "Streaming reply",
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: "Streaming reply",
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.map((event) => event.type)).toEqual([
      "ack",
      "assistant_state",
      "transcript_entry",
      "transcript_entry",
      "assistant_delta",
      "assistant_delta",
      "assistant_state",
      "final",
    ]);
    expect(events[0]?.userMessage?.id).toBe("message-user");
    expect(events[1]).toMatchObject({
      type: "assistant_state",
      state: "streaming",
      generationId: "generation-1",
      attemptEpoch: 1,
    });
    expect(events[2]?.entry?.kind).toBe("thinking");
    expect(events[3]?.entry?.kind).toBe("tool_call");
    expect(events[7]?.messages).toHaveLength(1);
    expect(events[6]).toMatchObject({
      type: "assistant_state",
      state: "finalizing",
      generationId: "generation-1",
      attemptEpoch: 1,
    });
    expect(events[7]?.messages[0]?.id).toBe("message-assistant");
    expect(events[7]?.messages[0]?.generationId).toBe("generation-1");
    expect(mockChatService.generationProtocol.appendVisibleEventAndProject).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "chat-1",
        eventKind: "transcript",
        body: "",
        replyingAgentId: "agent-1",
        runId: "chat-run-stream-1",
      }),
    );
    const transcriptProjectionCall = mockChatService.generationProtocol.appendVisibleEventAndProject.mock.calls
      .find(([input]) => input.eventKind === "transcript");
    expect(transcriptProjectionCall?.[0]).not.toHaveProperty("transcript");
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        kind: "message",
        status: "completed",
        body: "Streaming reply",
        replyingAgentId: "agent-1",
        runId: "chat-run-stream-1",
      }),
    );
    expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("transcript");
    expect(mockChatAgentRuns.linkAssistantMessage).toHaveBeenCalledWith("chat-run-stream-1", "chat-1", "message-assistant");
  });

  it("does not persist process transcript text as the failed stream message body", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const progressMessage = {
      ...createMessage("message-assistant", "assistant", "message", ""),
      status: "streaming",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onAssistantState?.("streaming");
      await input.onTranscriptEntry?.({
        kind: "assistant",
        ts: "2026-03-26T08:01:01.000Z",
        text: "I will inspect the issue first.",
        delta: true,
      });
      const { ChatAssistantStreamError } = await import("../services/chat-assistant.js");
      throw new ChatAssistantStreamError("runtime process exited", "I will inspect the issue first.");
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "error",
      error: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
      errorCode: "chat_runtime_exception",
      messageId: "message-assistant",
    }));
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        status: "failed",
        body: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
        structuredPayload: {
          recoverableFailure: {
            recoverable: true,
            code: "chat_runtime_exception",
            message: "The assistant reply could not be completed. Rudder saved this attempt for diagnostics; retry when ready.",
            runId: null,
          },
        },
      }),
    );
    expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("transcript");
  });

  it("does not publish inline-visual backing HTML from a failed stream", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need a visual");
    const progressMessage = {
      ...createMessage("message-assistant", "assistant", "message", ""),
      status: "streaming",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async () => {
      const { ChatAssistantStreamError } = await import("../services/chat-assistant.js");
      throw new ChatAssistantStreamError("runtime process exited", "", [{
        source: "rudder_inline_visual",
        originalFilename: "inline-visual-1.html",
        contentType: "text/html",
        body: Buffer.from('<div id="widget">private fragment</div>'),
        slot: 0,
      }]);
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need a visual" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).not.toHaveBeenCalled();
    expect(mockChatService.createAttachment).not.toHaveBeenCalled();
    expect(String(res.body)).not.toContain("private fragment");
  });

  it("updates a streaming assistant placeholder into ask_user on final", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help choosing scope");
    const progressMessage = {
      ...createMessage("message-assistant", "assistant", "message", ""),
      status: "streaming",
    };
    const askUserPayload = {
      requestUserInput: {
        questions: [
          {
            id: "scope",
            question: "Which scope should the agent implement?",
            options: [
              { id: "narrow", label: "Narrow" },
              { id: "broad", label: "Broad" },
            ],
          },
        ],
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onAssistantState?.("streaming");
      await input.onAssistantDelta?.("I need one decision.");
      await input.onAssistantState?.("finalizing");
      return {
        outcome: "completed",
        partialBody: "I need one decision.",
        replyingAgentId: "agent-1",
        reply: {
          kind: "ask_user",
          body: "I need one decision.",
          structuredPayload: askUserPayload,
          replyingAgentId: "agent-1",
        },
      };
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help choosing scope" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.at(-1)?.type).toBe("final");
    expect(events.at(-1)?.messages[0]).toEqual(expect.objectContaining({
      id: "message-assistant",
      kind: "ask_user",
      structuredPayload: askUserPayload,
    }));
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        kind: "ask_user",
        status: "completed",
        body: "I need one decision.",
        structuredPayload: askUserPayload,
      }),
    );
  });

  it("generates a new chat title for streamed messages after acknowledging the user message", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Plan the migration");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will plan it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Migration plan",
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will plan it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will plan it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Plan the migration" });

    expect(res.status).toBe(201);
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "organization-1",
        purpose: "lightweight",
        feature: "chat_title",
        prompt: expect.stringContaining("Plan the migration"),
      }));
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Plan the migration");
      expect(mockChatService.replaceSystemGeneratedTitle).toHaveBeenCalledWith(
        "chat-1",
        "Plan the migration",
        "Migration plan",
      );
    });
  });

  it("falls back to the first user message for streamed messages when lightweight title generation fails", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Plan the migration");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "I will plan it.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockProductIntelligenceService.execute.mockRejectedValueOnce(new Error("No lightweight profile configured"));
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I will plan it.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "I will plan it.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Plan the migration" });

    expect(res.status).toBe(201);
    await waitUntil(() => {
      expect(mockProductIntelligenceService.execute).toHaveBeenCalled();
      expect(mockChatService.updateDefaultTitle).toHaveBeenCalledWith("chat-1", "Plan the migration");
    });
  });

  it("stores streamed chat attachments before invoking the assistant", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Can you see this?");
    const attachment = {
      id: "attachment-1",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-user",
      assetId: "asset-1",
      provider: "local_disk",
      objectKey: "chats/chat-1/image.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256",
      originalFilename: "image.png",
      createdByAgentId: null,
      createdByUserId: "user-1",
      contentPath: "/api/assets/asset-1/content",
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    };
    const userMessageWithAttachment = {
      ...userMessage,
      attachments: [attachment],
    };
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Yes.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessageWithAttachment);
    mockChatService.listMessages.mockResolvedValue([userMessageWithAttachment]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Yes.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Yes.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .field("body", "Can you see this?")
      .attach("files", Buffer.from("fake-png"), {
        filename: "image.png",
        contentType: "image/png",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(mockStorage.putFile).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      namespace: "chats/chat-1",
      originalFilename: "image.png",
      contentType: "image/png",
    }));
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      "chat-1",
      "organization-1",
      "Can you see this?",
      null,
      expect.objectContaining({
        attachments: [expect.objectContaining({
          objectKey: "chats/chat-1/image.png",
          contentType: "image/png",
          originalFilename: "image.png",
          createdByUserId: "user-1",
        })],
      }),
    );
    expect(events[0]).toEqual(expect.objectContaining({
      type: "ack",
      userMessage: expect.objectContaining({
        id: "message-user",
        attachments: [expect.objectContaining({ id: "attachment-1", contentPath: "/api/assets/asset-1/content" })],
      }),
    }));
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        id: "message-user",
        attachments: [expect.objectContaining({ id: "attachment-1" })],
      })],
    }));
  });

  it("uses explicit Agent defaults for multipart sends on legacy override conversations", async () => {
    const conversation = createConversation({
      modelOverride: "gpt-5.6-terra",
      effortOverride: "xhigh",
    });
    const userMessage = createMessage("message-user", "user", "message", "Use Agent defaults");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Done.");
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.getDraftChatAssistantAvailability.mockResolvedValueOnce({
      ...conversation.chatRuntime,
      sourceType: "agent",
      sourceLabel: "Agent default",
      model: "gpt-5.6-sol",
      effort: "high",
      available: true,
    });
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Done.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Done.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .field("body", "Use Agent defaults")
      .field("modelOverride", "__rudder_agent_default__")
      .field("effortOverride", "__rudder_agent_default__")
      .attach("files", Buffer.from("prompt"), {
        filename: "prompt.txt",
        contentType: "text/plain",
      });

    expect(res.status).toBe(201);
    expect(mockChatAssistantService.getDraftChatAssistantAvailability).toHaveBeenCalledWith({
      orgId: conversation.orgId,
      preferredAgentId: conversation.preferredAgentId,
      modelOverride: null,
      effortOverride: null,
      contextLinks: conversation.contextLinks,
      planMode: conversation.planMode,
    });
    expect(mockChatAssistantService.getChatAssistantAvailability).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledWith(
      expect.objectContaining({ modelSnapshot: "gpt-5.6-sol", effortSnapshot: "high" }),
    );
  });

  it("binds multipart annotation files into the canonical user message before the stream ack", async () => {
    const attachmentId = "10000000-0000-4000-8000-000000000004";
    const assetId = "10000000-0000-4000-8000-000000000005";
    const conversation = createConversation({ id: annotationConversationId });
    const annotationInput = createInlineAnnotation({ attachmentFileIndexes: [0] });
    const canonicalAnnotation = createInlineAnnotation({
      attachmentIds: [attachmentId],
    });
    const userMessage = {
      ...createMessage("10000000-0000-4000-8000-000000000006", "user", "message", "Explain this"),
      conversationId: annotationConversationId,
      structuredPayload: {
        inlineAnnotations: [createInlineAnnotation()],
      },
    };
    const attachment = {
      id: attachmentId,
      orgId: "organization-1",
      conversationId: annotationConversationId,
      messageId: userMessage.id,
      assetId,
      provider: "local_disk",
      objectKey: "chats/annotation/context.txt",
      contentType: "text/plain",
      byteSize: 4,
      sha256: "sha256",
      originalFilename: "context.txt",
      createdByAgentId: null,
      createdByUserId: "user-1",
      contentPath: `/api/assets/${assetId}/content`,
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    };
    const canonicalUserMessage = {
      ...userMessage,
      structuredPayload: { inlineAnnotations: [canonicalAnnotation] },
      attachments: [attachment],
    };
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Explanation"),
      conversationId: annotationConversationId,
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(canonicalUserMessage);
    mockChatService.listMessages.mockResolvedValue([canonicalUserMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
      outcome: "completed",
      partialBody: "Explanation",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Explanation",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Explain this")
      .field("inlineAnnotations", JSON.stringify([annotationInput]))
      .attach("files", Buffer.from("file"), {
        filename: "context.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      annotationConversationId,
      "organization-1",
      "Explain this",
      null,
      expect.objectContaining({
        structuredPayload: {
          inlineAnnotations: [createInlineAnnotation()],
        },
        structuredPayloadProvided: true,
        attachments: [expect.objectContaining({
          originalFilename: "image.png",
          createdByUserId: "user-1",
        })],
        attachmentFileIndexesByAnnotationId: expect.any(Map),
      }),
    );
    expect(events[0]).toMatchObject({
      type: "ack",
      userMessage: {
        id: userMessage.id,
        structuredPayload: {
          inlineAnnotations: [canonicalAnnotation],
        },
        attachments: [{ id: attachmentId }],
      },
    });
    expect(JSON.stringify(events[0])).not.toContain("attachmentFileIndexes");
  });

  it("routes a Side Chat parent-anchor annotation file into a child-owned user message", async () => {
    const parentConversationId = "10000000-0000-4000-8000-000000000010";
    const attachmentId = "10000000-0000-4000-8000-000000000011";
    const assetId = "10000000-0000-4000-8000-000000000012";
    const conversation = createConversation({
      id: annotationConversationId,
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      forkedFromConversationId: parentConversationId,
      forkedFromMessageId: annotationSourceMessageId,
      forkRootConversationId: parentConversationId,
    });
    const annotationInput = createInlineAnnotation({
      sourceConversationId: parentConversationId,
      attachmentFileIndexes: [0],
    });
    const canonicalAnnotation = createInlineAnnotation({
      sourceConversationId: parentConversationId,
      attachmentIds: [attachmentId],
    });
    const userMessage = {
      ...createMessage("10000000-0000-4000-8000-000000000013", "user", "message", ""),
      conversationId: annotationConversationId,
      structuredPayload: { inlineAnnotations: [canonicalAnnotation] },
      attachments: [{
        id: attachmentId,
        orgId: "organization-1",
        conversationId: annotationConversationId,
        messageId: "10000000-0000-4000-8000-000000000013",
        assetId,
        provider: "local_disk",
        objectKey: "chats/side-chat/context.txt",
        contentType: "text/plain",
        byteSize: 4,
        sha256: "sha256",
        originalFilename: "context.txt",
        createdByAgentId: null,
        createdByUserId: "user-1",
        contentPath: `/api/assets/${assetId}/content`,
        createdAt: new Date("2026-03-26T08:01:00.000Z"),
        updatedAt: new Date("2026-03-26T08:01:00.000Z"),
      }],
    };
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Side response"),
      conversationId: annotationConversationId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
      outcome: "completed",
      partialBody: "Side response",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Side response",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "")
      .field("inlineAnnotations", JSON.stringify([annotationInput]))
      .attach("files", Buffer.from("file"), {
        filename: "context.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockSideChatService.assertMutable).toHaveBeenCalledWith(
      conversation,
      "user-1",
    );
    expect(mockChatInlineAnnotations.prepare).toHaveBeenCalledWith({
      orgId: "organization-1",
      conversationId: annotationConversationId,
      annotations: [annotationInput],
      uploadedFileCount: 1,
      editUserMessageId: null,
    });
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      annotationConversationId,
      "organization-1",
      "",
      null,
      expect.objectContaining({
        structuredPayload: {
          inlineAnnotations: [createInlineAnnotation({
            sourceConversationId: parentConversationId,
          })],
        },
        structuredPayloadProvided: true,
        attachments: [expect.objectContaining({
          originalFilename: "image.png",
          createdByUserId: "user-1",
        })],
      }),
    );
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      type: "ack",
      userMessage: {
        conversationId: annotationConversationId,
        structuredPayload: {
          inlineAnnotations: [{
            sourceConversationId: parentConversationId,
            sourceMessageId: annotationSourceMessageId,
            attachmentIds: [attachmentId],
          }],
        },
        attachments: [{
          id: attachmentId,
          conversationId: annotationConversationId,
          messageId: userMessage.id,
        }],
      },
    });
  });

  it("removes staged objects and emits no assistant message when atomic multipart persistence fails", async () => {
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockRejectedValueOnce(
      unprocessable("Annotation file attachment could not be rebound to the user message"),
    );

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Explain this")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [0] }),
      ]))
      .attach("files", Buffer.from("file"), {
        filename: "context.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).toHaveBeenCalledTimes(1);
    expect(mockStorage.deleteObject).toHaveBeenCalledWith(
      "organization-1",
      "chats/chat-1/image.png",
    );
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        messageId: null,
      }),
    ]);
  });

  it("retains committed multipart objects when message hydration fails after the transaction", async () => {
    const committedUserMessageId = "10000000-0000-4000-8000-000000000007";
    const conversation = createConversation({ id: annotationConversationId });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockImplementationOnce(async (
      _conversationId,
      _orgId,
      _body,
      _editUserMessageId,
      options,
    ) => {
      options?.onTransactionCommitted?.(committedUserMessageId);
      throw new Error("Failed to hydrate created chat message");
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Explain this")
      .field("inlineAnnotations", JSON.stringify([
        createInlineAnnotation({ attachmentFileIndexes: [0] }),
      ]))
      .attach("files", Buffer.from("file"), {
        filename: "context.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockStorage.putFile).toHaveBeenCalledTimes(1);
    expect(mockStorage.deleteObject).not.toHaveBeenCalled();
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        messageId: committedUserMessageId,
      }),
    ]);
  });

  it("keeps copied edit attachments in the stream ack when no new files are uploaded", async () => {
    const conversation = createConversation();
    const editUserMessageId = "10000000-0000-4000-8000-000000000099";
    const carriedAnnotation = createInlineAnnotation({
      attachmentIds: ["attachment-copied"],
    });
    const attachment = {
      id: "attachment-copied",
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-edited",
      assetId: "asset-copied",
      provider: "local_disk",
      objectKey: "chats/chat-1/copied.png",
      contentType: "image/png",
      byteSize: 8,
      sha256: "sha256",
      originalFilename: "copied.png",
      createdByAgentId: null,
      createdByUserId: "user-1",
      contentPath: "/api/assets/asset-copied/content",
      createdAt: new Date("2026-03-26T08:01:00.000Z"),
      updatedAt: new Date("2026-03-26T08:01:00.000Z"),
    };
    const editedUserMessage = {
      ...createMessage("message-edited", "user", "message", "Edited with copied attachment"),
      attachments: [attachment],
      structuredPayload: { inlineAnnotations: [carriedAnnotation] },
      turnVariant: 1,
    };
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Done.");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(editedUserMessage);
    mockChatService.listMessages.mockResolvedValue([editedUserMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Done.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Done.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Edited with copied attachment", editUserMessageId })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events[0]).toEqual(expect.objectContaining({
      type: "ack",
      userMessage: expect.objectContaining({
        id: "message-edited",
        attachments: [expect.objectContaining({ id: "attachment-copied", contentPath: "/api/assets/asset-copied/content" })],
        structuredPayload: { inlineAnnotations: [carriedAnnotation] },
      }),
    }));
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      "chat-1",
      "organization-1",
      "Edited with copied attachment",
      editUserMessageId,
      expect.objectContaining({
        onTransactionCommitted: expect.any(Function),
      }),
    );
    expect(mockChatAssistantService.streamChatAssistantReply).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({
        id: "message-edited",
        attachments: [expect.objectContaining({ id: "attachment-copied" })],
      })],
    }));
  });

  it("routes a multipart historical edit with an identical annotation snapshot and a generic new file", async () => {
    const editUserMessageId = "10000000-0000-4000-8000-000000000099";
    const priorAttachmentId = "10000000-0000-4000-8000-000000000091";
    const reboundAttachmentId = "10000000-0000-4000-8000-000000000092";
    const newAttachmentId = "10000000-0000-4000-8000-000000000093";
    const conversation = createConversation({ id: annotationConversationId });
    const suppliedAnnotation = createInlineAnnotation({
      attachmentIds: [priorAttachmentId],
    });
    const persistedAnnotation = createInlineAnnotation({
      attachmentIds: [reboundAttachmentId],
    });
    const editedUserMessage = {
      ...createMessage("10000000-0000-4000-8000-000000000094", "user", "message", "Edited"),
      conversationId: annotationConversationId,
      structuredPayload: { inlineAnnotations: [persistedAnnotation] },
      attachments: [
        {
          id: reboundAttachmentId,
          messageId: "10000000-0000-4000-8000-000000000094",
          conversationId: annotationConversationId,
        },
        {
          id: newAttachmentId,
          messageId: "10000000-0000-4000-8000-000000000094",
          conversationId: annotationConversationId,
        },
      ],
      turnVariant: 1,
    };
    const assistantMessage = {
      ...createMessage("message-assistant", "assistant", "message", "Done."),
      conversationId: annotationConversationId,
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(editedUserMessage);
    mockChatService.listMessages.mockResolvedValue([editedUserMessage]);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Done.",
      replyingAgentId: "agent-1",
      reply: {
        kind: "message",
        body: "Done.",
        structuredPayload: null,
        replyingAgentId: "agent-1",
      },
    });

    const res = await request(createApp())
      .post(`/api/chats/${annotationConversationId}/messages/stream`)
      .field("body", "Edited")
      .field("editUserMessageId", editUserMessageId)
      .field("inlineAnnotations", JSON.stringify([suppliedAnnotation]))
      .attach("files", Buffer.from("notes"), {
        filename: "notes.txt",
        contentType: "text/plain",
      })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    expect(mockChatInlineAnnotations.prepare).toHaveBeenCalledWith({
      orgId: "organization-1",
      conversationId: annotationConversationId,
      annotations: [suppliedAnnotation],
      uploadedFileCount: 1,
      editUserMessageId,
    });
    expect(mockChatService.addUserChatMessage).toHaveBeenCalledWith(
      annotationConversationId,
      "organization-1",
      "Edited",
      editUserMessageId,
      expect.objectContaining({
        structuredPayload: { inlineAnnotations: [suppliedAnnotation] },
        structuredPayloadProvided: true,
        attachments: [expect.objectContaining({
          originalFilename: "image.png",
          createdByUserId: "user-1",
        })],
        attachmentFileIndexesByAnnotationId: expect.any(Map),
      }),
    );
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events[0]).toMatchObject({
      type: "ack",
      userMessage: {
        structuredPayload: { inlineAnnotations: [persistedAnnotation] },
        attachments: [{ id: reboundAttachmentId }, { id: newAttachmentId }],
      },
    });
  });

  it("persists a stopped partial assistant message when streaming is interrupted", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const stoppedMessage = {
      ...createMessage("message-stopped", "assistant", "message", "Partial reply"),
      status: "stopped",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(stoppedMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "stopped",
      partialBody: "Partial reply",
      replyingAgentId: "agent-1",
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ id: "message-stopped", status: "stopped" })],
    });
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "message",
        status: "stopped",
        replyingAgentId: "agent-1",
      }),
    );
  });

  it("persists a visible stopped assistant status before the first runtime output", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Stop immediately");
    const stoppedMessage = {
      ...createMessage("message-stopped-empty", "assistant", "message", ""),
      status: "stopped",
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(stoppedMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "stopped",
      partialBody: "",
      replyingAgentId: "agent-1",
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Stop immediately" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });

    expect(res.status).toBe(201);
    const events = String(res.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ id: "message-stopped-empty", status: "stopped", body: "" })],
    });
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "message",
        status: "stopped",
        body: "",
        replyingAgentId: "agent-1",
      }),
    );
    expect(mockChatService.addMessage.mock.calls.at(-1)?.[1]).not.toHaveProperty("transcript");
  });

  it("keeps generating and persists the final reply when the stream client disconnects", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Completed after disconnect");
    let capturedSignal: AbortSignal | null = null;
    let releaseAssistant!: () => void;
    const assistantStarted = new Promise<void>((resolve) => {
      mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
        capturedSignal = input.abortSignal ?? null;
        await input.onAssistantState?.("streaming");
        resolve();
        await new Promise<void>((release) => {
          releaseAssistant = release;
        });
        return {
          outcome: "completed",
          partialBody: "Completed after disconnect",
          replyingAgentId: "agent-1",
          reply: {
            kind: "message",
            body: "Completed after disconnect",
            structuredPayload: null,
            replyingAgentId: "agent-1",
          },
        };
      });
    });

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);

    const server = http.createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;

    try {
      const body = JSON.stringify({ body: "Need help" });
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: address.port,
            path: "/api/chats/chat-1/messages/stream",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
            },
          },
          (res) => {
            res.setEncoding("utf8");
            res.on("data", () => {
              res.destroy();
              resolve();
            });
          },
        );
        req.on("error", reject);
        req.end(body);
      });

      await assistantStarted;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(capturedSignal?.aborted).toBe(false);

      releaseAssistant();
      await waitUntil(() => {
        expect(mockChatService.updateMessage).toHaveBeenCalledWith(
          "chat-1",
          "message-assistant",
          expect.objectContaining({
            status: "completed",
            body: "Completed after disconnect",
          }),
        );
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("aborts the active stream only through the explicit stop endpoint", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const progressMessage = {
      ...createMessage("message-progress", "assistant", "message", ""),
      status: "streaming",
    };
    const beforeStopTranscript = {
      kind: "assistant" as const,
      ts: "2026-03-26T08:01:01.000Z",
      text: "Before stop",
      delta: true,
    };
    const lateTranscript = {
      kind: "thinking" as const,
      ts: "2026-03-26T08:01:02.000Z",
      text: "Late reasoning must be fenced",
    };
    let capturedSignal: AbortSignal | null = null;
    let releaseAssistant!: () => void;
    const assistantStarted = new Promise<void>((resolve) => {
      mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
        capturedSignal = input.abortSignal ?? null;
        await input.onAssistantState?.("streaming");
        await input.onAssistantDelta?.("Before stop");
        await input.onTranscriptEntry?.(beforeStopTranscript);
        resolve();
        await new Promise<void>((release) => {
          releaseAssistant = release;
        });
        await input.onAssistantDelta?.(" Late assistant output");
        await input.onAssistantState?.("finalizing");
        await input.onTranscriptEntry?.(lateTranscript);
        return {
          outcome: "stopped",
          partialBody: "Before stop Late assistant output",
          replyingAgentId: "agent-1",
        };
      });
    });

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);

    const streamRequest = request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      });
    const streamPromise = streamRequest.then((response) => response);

    await assistantStarted;
    expect(capturedSignal?.aborted).toBe(false);

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({ stopped: true, disposition: "stopping", generationId: "generation-1" });
    expect(capturedSignal?.aborted).toBe(true);
    expect(capturedSignal?.reason).toEqual({
      kind: "operator_interrupt",
      hardDeadlineMs: 2_000,
    });
    expect(mockChatService.generationProtocol.beginStopAction).toHaveBeenCalled();

    const repeatedStopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});

    expect(repeatedStopRes.status).toBe(200);
    expect(repeatedStopRes.body).toMatchObject({ stopped: true, disposition: "stopping" });

    releaseAssistant();
    const streamRes = await streamPromise;
    expect(streamRes.status).toBe(201);
    const events = String(streamRes.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ id: "message-assistant", status: "stopped" })],
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "assistant_delta", delta: "Before stop" }));
    expect(JSON.stringify(events)).not.toContain("Late assistant output");
    expect(JSON.stringify(events)).not.toContain("Late reasoning");
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        status: "stopped",
        body: "Before stop",
      }),
    );
    expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("transcript");
  });

  it("never persists output when Stop closes ledger admission first", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const progressMessage = {
      ...createMessage("message-progress", "assistant", "message", ""),
      status: "streaming",
    };
    const visibleTranscript = {
      kind: "thinking" as const,
      ts: "2026-03-26T08:01:01.000Z",
      text: "Visible transcript",
    };
    const unadmittedTranscript = {
      kind: "thinking" as const,
      ts: "2026-03-26T08:01:02.000Z",
      text: "Unadmitted transcript",
    };
    let releaseBlockedAdmission!: () => void;
    const blockedAdmissionRelease = new Promise<void>((resolve) => {
      releaseBlockedAdmission = resolve;
    });
    let signalBlockedAdmissionStarted!: () => void;
    const blockedAdmissionStarted = new Promise<void>((resolve) => {
      signalBlockedAdmissionStarted = resolve;
    });

    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onAssistantState?.("streaming");
      await input.onAssistantDelta?.("Visible prefix");
      await input.onTranscriptEntry?.(visibleTranscript);
      await Promise.all([
        input.onAssistantDelta?.(" unadmitted tail"),
        input.onTranscriptEntry?.(unadmittedTranscript),
      ]);
      return {
        outcome: "stopped",
        partialBody: "Visible prefix unadmitted tail",
        replyingAgentId: "agent-1",
      };
    });
    let generationSeq = 0;
    mockChatService.generationProtocol.appendVisibleEventAndProject.mockImplementation(async (input) => {
      if (input.eventKind === "assistant_delta" && input.payload?.delta === " unadmitted tail") {
        signalBlockedAdmissionStarted();
        await blockedAdmissionRelease;
        throw Object.assign(new Error("Chat-visible output admission is closed for this generation"), { status: 409 });
      }
      return {
        event: {
          id: `generation-event-${generationSeq + 1}`,
          generationSeq: ++generationSeq,
          payload: { ...(input.payload ?? {}), bodyHash: input.bodyHash },
        },
        generation: { id: input.generationId },
        message: { id: input.messageId ?? "message-progress" },
      };
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);

    const streamPromise = request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      })
      .then((response) => response);

    await blockedAdmissionStarted;
    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});
    expect(stopRes.body).toMatchObject({ stopped: true, disposition: "stopping" });

    releaseBlockedAdmission();
    const streamRes = await streamPromise;
    const events = String(streamRes.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(events).toContainEqual(expect.objectContaining({ type: "assistant_delta", delta: "Visible prefix" }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "transcript_entry",
      entry: expect.objectContaining(visibleTranscript),
    }));
    expect(JSON.stringify(events)).not.toContain("unadmitted tail");
    expect(JSON.stringify(events)).not.toContain("Unadmitted transcript");
    expect(mockChatService.updateMessage).not.toHaveBeenCalledWith(
      "chat-1",
      "message-progress",
      expect.objectContaining({ body: "Visible prefix unadmitted tail" }),
    );
    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ body: "Visible prefix", status: "stopped" })],
    });
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-progress",
      expect.objectContaining({
        body: "Visible prefix",
        status: "stopped",
      }),
    );
    expect(mockChatService.updateMessage.mock.calls.at(-1)?.[2]).not.toHaveProperty("transcript");
  });

  it("converges Stop after final output admission without interrupting the completed turn", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const completedMessage = createMessage(
      "message-assistant",
      "assistant",
      "message",
      "Committed final reply",
    );
    let capturedSignal: AbortSignal | null = null;
    let completionAdmitted = false;
    let signalFinalPersistenceStarted!: () => void;
    const finalPersistenceStarted = new Promise<void>((resolve) => {
      signalFinalPersistenceStarted = resolve;
    });
    let releaseFinalPersistence!: () => void;
    const finalPersistenceRelease = new Promise<void>((resolve) => {
      releaseFinalPersistence = resolve;
    });

    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      capturedSignal = input.abortSignal ?? null;
      return {
        outcome: "completed",
        partialBody: "Committed final reply",
        replyingAgentId: "agent-1",
        reply: {
          kind: "message",
          body: "Committed final reply",
          structuredPayload: null,
          replyingAgentId: "agent-1",
        },
      };
    });
    mockChatService.generationProtocol.appendVisibleEventAndProject.mockImplementation(async (input) => {
      if (input.eventKind === "runtime_output") completionAdmitted = true;
      return {
        event: {
          id: "generation-event-final",
          generationSeq: 1,
          payload: { ...(input.payload ?? {}), bodyHash: input.bodyHash },
        },
        generation: { id: input.generationId },
        message: { id: input.messageId ?? "message-assistant" },
      };
    });
    mockChatService.generationProtocol.beginStopAction.mockImplementation(async (input) => {
      if (completionAdmitted) {
        return {
          action: {
            id: input.controlActionId,
            expectedControlVersion: input.expectedControlVersion,
            localDisposition: "cancelled",
            acceptedThroughSeq: null,
            frozenBodyHash: null,
            lastError: "generation_result_already_committed",
          },
          generation: {
            id: input.expectedGenerationId,
            attemptEpoch: input.expectedAttemptEpoch,
            controlVersion: input.expectedControlVersion,
            status: "closing",
          },
          stopRequestedEvent: null,
          outputCutoffEvent: null,
          outcome: "completion_committed" as const,
          idempotent: false,
        };
      }
      return {
        action: {
          id: input.controlActionId,
          acceptedThroughSeq: input.requestedRenderSeq,
          frozenBodyHash: input.requestedBodyHash,
        },
        generation: {
          id: input.expectedGenerationId,
          attemptEpoch: input.expectedAttemptEpoch,
          controlVersion: input.expectedControlVersion + 1,
        },
        stopRequestedEvent: { id: "stop-requested-event" },
        outputCutoffEvent: { id: "output-cutoff-event" },
        outcome: "stop_applied" as const,
        idempotent: false,
      };
    });
    mockChatService.updateMessage.mockImplementationOnce(async () => {
      signalFinalPersistenceStarted();
      await finalPersistenceRelease;
      return completedMessage;
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);

    const app = createApp();
    const streamPromise = request(app)
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      })
      .then((response) => response);

    try {
      await finalPersistenceStarted;
      const stopRes = await request(app)
        .post("/api/chats/chat-1/messages/stream/stop")
        .send({ controlActionId: "20000000-0000-4000-8000-000000000077" });

      expect(stopRes.status).toBe(200);
      expect(stopRes.body).toEqual({
        stopped: false,
        controlActionId: "20000000-0000-4000-8000-000000000077",
        generationId: "generation-1",
        disposition: "completion_committed",
      });
      expect(capturedSignal?.aborted).toBe(false);
      expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalled();
    } finally {
      releaseFinalPersistence();
    }

    const streamRes = await streamPromise;
    const events = String(streamRes.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ status: "completed", body: "Committed final reply" })],
    });
  });

  it("retries stopped message projection until the frozen cutoff converges", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const progressMessage = {
      ...createMessage("message-progress", "assistant", "message", ""),
      status: "streaming",
    };
    let releaseAssistant!: () => void;
    const assistantStarted = new Promise<void>((resolve) => {
      mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
        await input.onAssistantState?.("streaming");
        await input.onAssistantDelta?.("Visible prefix");
        resolve();
        await new Promise<void>((release) => {
          releaseAssistant = release;
        });
        return {
          outcome: "stopped",
          partialBody: "",
          replyingAgentId: "agent-1",
        };
      });
    });
    let stoppedPersistenceAttempts = 0;
    mockChatService.updateMessage.mockImplementation(async (_conversationId: string, messageId: string, input: Record<string, unknown>) => {
      stoppedPersistenceAttempts += 1;
      if (stoppedPersistenceAttempts === 1) {
        throw new Error("stopped persistence temporarily unavailable");
      }
      return {
        ...createMessage(messageId, "assistant", "message", String(input.body ?? "")),
        status: input.status,
        transcript: input.transcript,
        replyingAgentId: input.replyingAgentId,
      };
    });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(progressMessage);

    const streamPromise = request(createApp())
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        response.setEncoding("utf8");
        response.on("data", () => undefined);
        response.on("end", () => callback(null, ""));
      })
      .then((response) => response);

    await assistantStarted;
    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});
    expect(stopRes.body).toMatchObject({ stopped: true, disposition: "stopping" });

    releaseAssistant();
    await streamPromise;
    expect(stoppedPersistenceAttempts).toBe(2);
    expect(mockChatAgentRuns.linkAssistantMessage).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenLastCalledWith(
      expect.objectContaining({ generationId: "generation-1", finalStatus: "stopped" }),
    );
  });

  it("stops startup before generation creation can launch the provider", async () => {
    const conversation = createConversation();
    const controlActionId = "20000000-0000-4000-8000-000000000099";
    let releaseGenerationCreation!: () => void;
    const generationCreationRelease = new Promise<void>((resolve) => {
      releaseGenerationCreation = resolve;
    });
    let signalGenerationCreationStarted!: () => void;
    const generationCreationStarted = new Promise<void>((resolve) => {
      signalGenerationCreationStarted = resolve;
    });
    mockChatService.createGeneration.mockImplementationOnce(async () => {
      signalGenerationCreationStarted();
      await generationCreationRelease;
      return { id: "generation-1", attemptEpoch: 1, controlVersion: 0 };
    });
    mockChatService.getById.mockResolvedValue(conversation);
    const app = createApp();
    const streamPromise = request(app)
      .post("/api/chats/chat-1/messages/stream")
      .send({ body: "Need help" })
      .buffer(true)
      .parse((response, callback) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => callback(null, text));
      })
      .then((response) => response);

    await generationCreationStarted;
    const stopPromise = request(app)
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({ controlActionId })
      .then((response) => response);
    await waitUntil(() => {
      expect(getActiveChatGeneration("chat-1")?.lifecycle).toBe("stopping");
    });
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();

    releaseGenerationCreation();
    const stopRes = await stopPromise;
    const streamRes = await streamPromise;
    const events = String(streamRes.body)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({
      stopped: true,
      controlActionId,
      generationId: "generation-1",
      disposition: "stopping",
      acceptedThroughSeq: 0,
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "ack", generationId: "generation-1" }),
      { type: "final", messages: [] },
    ]);
    expect(mockChatAssistantService.streamChatAssistantReply).not.toHaveBeenCalled();
    expect(mockChatService.generationProtocol.beginStopAction).toHaveBeenCalledWith(
      expect.objectContaining({
        controlActionId,
        expectedGenerationId: "generation-1",
        requestedRenderSeq: 0,
      }),
    );
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: "generation-1",
        finalStatus: "stopped",
        terminalReason: "operator_stop",
      }),
    );
  });

  it("replays an exact Stop action after its generation is terminal", async () => {
    const conversation = createConversation();
    const controlActionId = "20000000-0000-4000-8000-000000000098";
    const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const terminalGeneration = {
      id: "10000000-0000-4000-8000-000000000097",
      attemptEpoch: 1,
      controlVersion: 1,
      status: "stopped",
      runtimeTerminalAt: new Date("2026-03-26T08:02:00.000Z"),
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getLatestActiveGeneration.mockResolvedValue(null);
    mockChatService.generationProtocol.getLatestVisibleCheckpoint.mockResolvedValue({
      generation: terminalGeneration,
      generationSeq: 0,
      bodyHash,
    });
    mockChatService.generationProtocol.beginStopAction.mockResolvedValue({
      action: {
        id: controlActionId,
        expectedControlVersion: 0,
        localDisposition: "stopped",
        acceptedThroughSeq: 0,
        frozenBodyHash: bodyHash,
      },
      generation: terminalGeneration,
      stopRequestedEvent: null,
      outputCutoffEvent: null,
      idempotent: true,
    });

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: terminalGeneration.id,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 0,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: bodyHash,
      });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toEqual({
      stopped: true,
      controlActionId,
      generationId: terminalGeneration.id,
      disposition: "stopped",
      acceptedThroughSeq: 0,
      frozenBodyHash: bodyHash,
    });
    expect(mockChatService.generationProtocol.beginStopAction).toHaveBeenCalledWith(
      expect.objectContaining({
        controlActionId,
        expectedGenerationId: terminalGeneration.id,
        expectedAttemptEpoch: 1,
        requestedRenderSeq: 0,
        requestedBodyHash: bodyHash,
      }),
    );
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalled();

    const mismatchedReplay = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: terminalGeneration.id,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 2,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: bodyHash,
      });
    expect(mismatchedReplay.status).toBe(409);
    expect(mismatchedReplay.body).toEqual({
      error: "Control action id was already used for a different Stop request",
    });
  });

  it("accepts a new Stop action idempotently when the targeted generation is already stopped", async () => {
    const conversation = createConversation();
    const controlActionId = "20000000-0000-4000-8000-000000000096";
    const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const terminalGeneration = {
      id: "10000000-0000-4000-8000-000000000095",
      attemptEpoch: 1,
      controlVersion: 1,
      status: "stopped",
      runtimeTerminalAt: new Date("2026-03-26T08:02:00.000Z"),
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.generationProtocol.getLatestVisibleCheckpoint.mockResolvedValue({
      generation: terminalGeneration,
      generationSeq: 0,
      bodyHash,
    });
    mockChatService.generationProtocol.beginStopAction.mockResolvedValue({
      action: {
        id: controlActionId,
        expectedControlVersion: 1,
        localDisposition: "stopped",
        acceptedThroughSeq: 0,
        frozenBodyHash: bodyHash,
      },
      generation: terminalGeneration,
      stopRequestedEvent: null,
      outputCutoffEvent: null,
      outcome: "already_terminal",
      idempotent: false,
    });

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: terminalGeneration.id,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 1,
        lastCommittedRenderSeq: 0,
        renderedBodyHash: bodyHash,
      });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toEqual({
      stopped: true,
      controlActionId,
      generationId: terminalGeneration.id,
      disposition: "stopped",
      acceptedThroughSeq: 0,
      frozenBodyHash: bodyHash,
    });
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalled();
  });

  it("keeps a Stop owned by another runtime instance in progress without synthesizing terminal evidence", async () => {
    const conversation = createConversation();
    const controlActionId = "20000000-0000-4000-8000-000000000092";
    const generationId = "10000000-0000-4000-8000-000000000091";
    const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const stoppingGeneration = {
      id: generationId,
      attemptEpoch: 1,
      controlVersion: 2,
      status: "stop_requested",
      runtimeTerminalAt: null,
    };
    const stoppedGeneration = {
      ...stoppingGeneration,
      status: "stopped",
      runtimeTerminalAt: new Date("2026-03-26T08:02:00.000Z"),
    };
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.generationProtocol.getLatestVisibleCheckpoint.mockResolvedValue({
      generation: stoppingGeneration,
      generationSeq: 4,
      bodyHash,
    });
    const storedStopAction = {
      id: controlActionId,
      expectedControlVersion: 2,
      localDisposition: "stopping",
      acceptedThroughSeq: 4,
      frozenBodyHash: bodyHash,
    };
    mockChatService.generationProtocol.beginStopAction
      .mockResolvedValueOnce({
        action: storedStopAction,
        generation: stoppingGeneration,
        stopRequestedEvent: null,
        outputCutoffEvent: null,
        outcome: "stop_in_progress",
        idempotent: false,
      })
      .mockResolvedValue({
        action: storedStopAction,
        generation: stoppedGeneration,
        stopRequestedEvent: null,
        outputCutoffEvent: null,
        outcome: "stop_in_progress",
        idempotent: true,
      });

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 2,
        lastCommittedRenderSeq: 4,
        renderedBodyHash: bodyHash,
      });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toEqual({
      stopped: false,
      controlActionId,
      generationId,
      disposition: "stopping",
      acceptedThroughSeq: 4,
      frozenBodyHash: bodyHash,
    });
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalled();

    const replayRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 2,
        lastCommittedRenderSeq: 4,
        renderedBodyHash: bodyHash,
      });

    expect(replayRes.status).toBe(200);
    expect(replayRes.body).toEqual({
      stopped: true,
      controlActionId,
      generationId,
      disposition: "stopped",
      acceptedThroughSeq: 4,
      frozenBodyHash: bodyHash,
    });
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).not.toHaveBeenCalled();
  });

  it("retries Stop with a refreshed admission version and exactly replays the original request", async () => {
    const conversation = createConversation();
    const generationId = "10000000-0000-4000-8000-000000000094";
    const controlActionId = "20000000-0000-4000-8000-000000000093";
    const bodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.generationProtocol.getLatestVisibleCheckpoint
      .mockResolvedValueOnce({
        generation: { id: generationId, status: "running", attemptEpoch: 1, controlVersion: 3 },
        generationSeq: 7,
        bodyHash,
      })
      .mockResolvedValue({
        generation: { id: generationId, status: "running", attemptEpoch: 1, controlVersion: 5 },
        generationSeq: 7,
        bodyHash,
      });
    let storedAction: {
      id: string;
      expectedControlVersion: number;
      acceptedThroughSeq: number;
      frozenBodyHash: string;
    } | null = null;
    mockChatService.generationProtocol.beginStopAction.mockImplementation(async (input) => {
      if (storedAction?.id === input.controlActionId) {
        return {
          action: storedAction,
          generation: {
            id: input.expectedGenerationId,
            status: "stopping",
            attemptEpoch: input.expectedAttemptEpoch,
            controlVersion: 6,
          },
          stopRequestedEvent: null,
          outputCutoffEvent: null,
          outcome: "stop_applied" as const,
          idempotent: true,
        };
      }
      const admissionControlVersion = (input as typeof input & { admissionControlVersion?: number })
        .admissionControlVersion ?? input.expectedControlVersion;
      if (admissionControlVersion === 3) {
        throw Object.assign(new Error("Control version changed"), { status: 409 });
      }
      storedAction = {
        id: input.controlActionId,
        expectedControlVersion: input.expectedControlVersion,
        acceptedThroughSeq: input.requestedRenderSeq,
        frozenBodyHash: input.requestedBodyHash,
      };
      return {
        action: storedAction,
        generation: {
          id: input.expectedGenerationId,
          status: "stopping",
          attemptEpoch: input.expectedAttemptEpoch,
          controlVersion: admissionControlVersion + 1,
        },
        stopRequestedEvent: { id: "stop-requested-event" },
        outputCutoffEvent: { id: "output-cutoff-event" },
        outcome: "stop_applied" as const,
        idempotent: false,
      };
    });

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 3,
        lastCommittedRenderSeq: 7,
        renderedBodyHash: bodyHash,
      });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({
      controlActionId,
      generationId,
      disposition: "interrupted_unverified",
    });
    expect(mockChatService.generationProtocol.beginStopAction.mock.calls.map(([input]) => (
      input.expectedControlVersion
    ))).toEqual([3, 3]);
    expect(mockChatService.generationProtocol.beginStopAction.mock.calls.map(([input]) => (
      (input as typeof input & { admissionControlVersion?: number }).admissionControlVersion
    ))).toEqual([3, 5]);

    const replayRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({
        controlActionId,
        expectedGenerationId: generationId,
        expectedAttemptEpoch: 1,
        expectedControlVersion: 3,
        lastCommittedRenderSeq: 7,
        renderedBodyHash: bodyHash,
    });

    expect(replayRes.status).toBe(200);
    expect(replayRes.body).toMatchObject({ controlActionId, generationId });
    expect(mockChatService.generationProtocol.beginStopAction.mock.calls.map(([input]) => (
      input.expectedControlVersion
    ))).toEqual([3, 3, 3]);
    expect(mockChatService.generationProtocol.beginStopAction.mock.calls.map(([input]) => (
      (input as typeof input & { admissionControlVersion?: number }).admissionControlVersion
    ))).toEqual([3, 5, 3]);
  });

  it("stops a persisted active generation when no local stream owner remains", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getLatestActiveGeneration.mockResolvedValueOnce({ id: "generation-stale" });

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({
      stopped: false,
      disposition: "interrupted_unverified",
      generationId: "generation-stale",
    });
    expect(mockChatService.getLatestActiveGeneration).toHaveBeenCalledWith("chat-1");
    expect(mockChatService.generationProtocol.recordRuntimeTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        generationId: "generation-stale",
        finalStatus: "interrupted_unverified",
      }),
    );
  });

  it("returns stopped false when no local stream or persisted generation is active", async () => {
    const conversation = createConversation();
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.getLatestActiveGeneration.mockResolvedValueOnce(null);

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});

    expect(stopRes.status).toBe(200);
    expect(stopRes.body).toMatchObject({
      stopped: false,
      disposition: "no_active_generation",
      generationId: null,
    });
    expect(mockChatService.generationProtocol.beginStopAction).not.toHaveBeenCalled();
  });

  it("rejects stopping active streams for Feishu-bound chat conversations", async () => {
    const conversation = createFeishuBackedConversation();
    claimChatGeneration("chat-1", "generation-feishu");
    mockChatService.getById.mockResolvedValue(conversation);

    const stopRes = await request(createApp())
      .post("/api/chats/chat-1/messages/stream/stop")
      .send({});

    expect(stopRes.status).toBe(409);
    expect(stopRes.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(hasActiveChatGeneration("chat-1")).toBe(true);
  });

  it("converts a chat proposal to an issue and wakes the assignee", async () => {
    const conversation = createConversation();
    const proposalMessageId = "10000000-0000-4000-8000-000000000099";
    const issue = {
      id: "issue-1",
      orgId: "organization-1",
      identifier: "ISS-1",
      title: "Implement auth flow",
      description: "Track the auth rollout plan in an issue.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: "agent-1",
    };
    const systemMessage = {
      ...createMessage("message-system", "system", "system_event", "Created issue ISS-1 from this chat conversation."),
      structuredPayload: {
        eventType: "issue_created",
        issueId: "issue-1",
        issueIdentifier: "ISS-1",
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.convertToIssue.mockResolvedValue(issue);
    mockChatService.addMessage.mockResolvedValue(systemMessage);

    const res = await request(createApp())
      .post("/api/chats/chat-1/convert-to-issue")
      .send({ messageId: proposalMessageId });

    expect(res.status).toBe(201);
    expect(mockHeartbeatService.wakeup).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: "issue-1", mutation: "chat_convert" },
        requestedByActorType: "user",
        requestedByActorId: "user-1",
        contextSnapshot: expect.objectContaining({
          issueId: "issue-1",
          source: "chat.convert_to_issue",
          wakeSource: "assignment",
          wakeReason: "issue_assigned",
        }),
      }),
    );
  });

  it("rejects chat-to-issue conversion for Feishu-bound chat conversations", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .post("/api/chats/chat-1/convert-to-issue")
      .send({ messageId: "10000000-0000-4000-8000-000000000099" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatService.convertToIssue).not.toHaveBeenCalled();
    expect(mockChatService.addMessage).not.toHaveBeenCalled();
    expect(mockHeartbeatService.wakeup).not.toHaveBeenCalled();
  });

  it("requires task assignment permission to convert reviewer-bearing chat proposals", async () => {
    mockChatService.getById.mockResolvedValue(createConversation());
    mockAccessService.canUser.mockResolvedValue(false);

    const res = await request(createApp())
      .post("/api/chats/chat-1/convert-to-issue")
      .send({
        proposal: {
          title: "Implement reviewed work",
          description: "Create a reviewed issue from chat.",
          priority: "medium",
          assigneeUnassignedReason: "The reviewer is selected before the execution owner.",
          reviewerAgentId: "10000000-0000-4000-8000-000000000077",
        },
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Missing permission: tasks:assign");
    expect(mockChatService.convertToIssue).not.toHaveBeenCalled();
  });

  it("resolves an operation proposal", async () => {
    const conversation = createConversation();
    const resolvedMessage = {
      ...createMessage("message-op", "assistant", "operation_proposal", "Rename the organization"),
      structuredPayload: {
        operationProposal: {
          targetType: "organization",
          targetId: "organization-1",
          summary: "Rename the organization",
          patch: { name: "New Name" },
        },
        operationProposalState: {
          status: "approved",
          decisionNote: "Apply it",
          decidedByUserId: "user-1",
          decidedAt: "2026-03-26T08:02:00.000Z",
        },
      },
    };
    const systemMessage = {
      ...createMessage("message-system-op", "system", "system_event", "Applied lightweight change: Rename the organization."),
      structuredPayload: {
        eventType: "operation_applied",
        source: "chat",
        sourceMessageId: "message-op",
        targetType: "organization",
        targetId: "organization-1",
      },
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.resolveOperationProposal.mockResolvedValue({
      message: resolvedMessage,
      systemMessage,
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/message-op/operation-proposal/resolve")
      .send({ action: "approve", decisionNote: "Apply it" });

    expect(res.status).toBe(201);
  });

  it("rejects operation proposal resolution for Feishu-bound chat conversations", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages/message-op/operation-proposal/resolve")
      .send({ action: "approve", decisionNote: "Apply it" });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatService.resolveOperationProposal).not.toHaveBeenCalled();
  });

  it("rejects resolving Feishu-bound chat conversations", async () => {
    mockChatService.getById.mockResolvedValue(createFeishuBackedConversation());

    const res = await request(createApp())
      .post("/api/chats/chat-1/resolve")
      .send();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Fork this Feishu chat to continue in Rudder" });
    expect(mockChatService.resolve).not.toHaveBeenCalled();
  });
});
