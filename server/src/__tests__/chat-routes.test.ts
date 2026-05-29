import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatRoutes } from "../routes/chats.js";
import { errorHandler } from "../middleware/index.js";

const mockWithExecutionObservation = vi.hoisted(() => vi.fn(async (_context, _input, fn) => fn(null)));
const mockObserveExecutionEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));
const mockUpdateExecutionObservation = vi.hoisted(() => vi.fn());
const mockUpdateExecutionTraceIO = vi.hoisted(() => vi.fn());
const mockEmitExecutionTranscriptTree = vi.hoisted(() =>
  vi.fn(() => ({
    turnCount: 0,
    toolCount: 0,
    eventCount: 0,
    finalOutput: null,
    finalModel: null,
    finalUsage: null,
    finalSessionId: null,
    hasError: false,
  })),
);

const mockChatService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  setPinned: vi.fn(),
  listMessages: vi.fn(),
  getMessage: vi.fn(),
  addMessage: vi.fn(),
  updateMessage: vi.fn(),
  markInterruptedStreamingMessages: vi.fn(),
  addUserChatMessage: vi.fn(),
  addContextLink: vi.fn(),
  setProjectContextLink: vi.fn(),
  createAttachment: vi.fn(),
  convertToIssue: vi.fn(),
  resolve: vi.fn(),
  createProposalApproval: vi.fn(),
  resolveOperationProposal: vi.fn(),
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
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockAutomationService = vi.hoisted(() => ({
  create: vi.fn(),
  createTrigger: vi.fn(),
}));

const mockGoalService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockOperatorProfileService = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockChatAssistantService = vi.hoisted(() => ({
  enrichConversation: vi.fn(),
  enrichConversations: vi.fn(),
  getChatAssistantAvailability: vi.fn(),
  generateChatAssistantReply: vi.fn(),
  streamChatAssistantReply: vi.fn(),
}));

const mockStorage = vi.hoisted(() => ({
  putFile: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  automationService: () => mockAutomationService,
  chatService: () => mockChatService,
  organizationService: () => mockCompanyService,
  goalService: () => mockGoalService,
  issueService: () => mockIssueService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  logActivity: mockLogActivity,
  operatorProfileService: () => mockOperatorProfileService,
  projectService: () => mockProjectService,
}));

vi.mock("../services/chat-assistant.js", () => ({
  ChatAssistantStreamError: class ChatAssistantStreamError extends Error {},
  chatAssistantService: () => mockChatAssistantService,
}));

vi.mock("../langfuse.js", () => ({
  withExecutionObservation: mockWithExecutionObservation,
  observeExecutionEvent: mockObserveExecutionEvent,
  updateExecutionObservation: mockUpdateExecutionObservation,
  updateExecutionTraceIO: mockUpdateExecutionTraceIO,
}));

vi.mock("../langfuse-transcript.js", () => ({
  emitExecutionTranscriptTree: mockEmitExecutionTranscriptTree,
}));

function createConversation(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-26T08:00:00.000Z");
  return {
    id: "chat-1",
    orgId: "organization-1",
    status: "active",
    title: "New chat",
    summary: null,
    latestReplyPreview: null,
    preferredAgentId: "agent-1",
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
    chatRuntime: {
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      available: true,
      error: null,
    },
    contextLinks: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
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

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
      runId: null,
    };
    next();
  });
  app.use(
    "/api",
    chatRoutes({} as any, mockStorage as any),
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

describe("chat routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({
      id: "organization-1",
      defaultChatIssueCreationMode: "manual_approval",
    });
    mockChatAssistantService.enrichConversation.mockImplementation(async (conversation) => conversation);
    mockChatAssistantService.enrichConversations.mockImplementation(async (conversations) => conversations);
    mockChatAssistantService.getChatAssistantAvailability.mockResolvedValue({
      available: true,
      sourceType: "agent",
      sourceLabel: "Chat Specialist",
      runtimeAgentId: "agent-1",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      error: null,
    });
    mockLogActivity.mockResolvedValue(undefined);
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
    mockChatService.addUserChatMessage.mockImplementation(async (_cid: string, _orgId: string, body: string) =>
      createMessage("message-user", "user", "message", body),
    );
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
    mockChatService.markInterruptedStreamingMessages.mockResolvedValue([]);
  });

  it("passes chat search query and status to the chat list service", async () => {
    mockChatService.list.mockResolvedValue([createConversation({ title: "Searchable chat" })]);

    const res = await request(createApp())
      .get("/api/orgs/organization-1/chats")
      .query({ status: "all", q: "launch notes" });

    expect(res.status).toBe(200);
    expect(mockChatService.list).toHaveBeenCalledWith(
      "organization-1",
      { status: "all", q: "launch notes" },
      "user-1",
    );
    expect(mockChatAssistantService.enrichConversations).toHaveBeenCalled();
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

  it("creates a conversation using the organization default issue creation mode", async () => {
    mockChatService.create.mockResolvedValue(createConversation());

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({});

    expect(res.status).toBe(201);
    expect(mockChatService.create).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({
        issueCreationMode: "manual_approval",
        planMode: false,
        contextLinks: [],
      }),
    );
  });

  it("rejects chat creation when the preferred agent is unknown", async () => {
    const preferredAgentId = "10000000-0000-4000-8000-000000000001";
    mockAgentService.getById.mockResolvedValueOnce(null);

    const res = await request(createApp())
      .post("/api/orgs/organization-1/chats")
      .send({ preferredAgentId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Preferred agent must belong to the same organization" });
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
      .send({ preferredAgentId });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Preferred agent must belong to the same organization" });
    expect(mockAgentService.getById).toHaveBeenCalledWith(preferredAgentId);
    expect(mockChatService.create).not.toHaveBeenCalled();
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
      .get("/api/chats/chat-1/messages");

    expect(res.status).toBe(200);
    expect(mockChatService.markInterruptedStreamingMessages).toHaveBeenCalledWith("chat-1");
    expect(mockChatService.listMessages).toHaveBeenCalledWith("chat-1");
    expect(res.body[0]).toEqual(expect.objectContaining({
      id: "message-streaming",
      status: "interrupted",
      body: "Partial preserved reply",
    }));
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
    mockChatService.listMessages.mockResolvedValue([]);
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

  it("clears a chat project context without project ownership lookup", async () => {
    const conversation = createConversation();
    const updatedConversation = createConversation({ contextLinks: [] });
    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([]);
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
    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_turn",
        rootExecutionId: "10000000-0000-4000-8000-000000000001",
        trigger: "assistant_reply",
        runtime: "codex_local",
      }),
      expect.objectContaining({
        name: "chat_turn",
        asType: "agent",
      }),
      expect.any(Function),
    );
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_turn",
        rootExecutionId: "10000000-0000-4000-8000-000000000001",
      }),
      expect.objectContaining({
        name: "chat.reply.persisted",
        metadata: expect.objectContaining({
          assistantKind: "issue_proposal",
          approvalId: "approval-1",
        }),
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
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "chat.reply.persisted",
        metadata: expect.objectContaining({
          assistantKind: "ask_user",
          approvalId: null,
        }),
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

  it("keeps plan-mode issue proposals approval-backed and preserves the plan document", async () => {
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
        planDocument: {
          title: "Auth rollout plan",
          body: "## Scope\n- Login\n- Session management",
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
          planDocument: expect.objectContaining({
            title: "Auth rollout plan",
            body: "## Scope\n- Login\n- Session management",
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
        structuredPayload: expect.objectContaining({
          planDocument: expect.objectContaining({ title: "Auth rollout plan" }),
        }),
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
          description: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
          outputMode: "chat_output",
          schedule: {
            cronExpression: "0 12 * * *",
            timezone: "Asia/Shanghai",
            label: "daily noon",
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
            description: "每天北京时间 12:00 使用 aihot 生成中文短日报并发送到 chat。",
            assigneeAgentId: "00000000-0000-4000-8000-000000000999",
            outputMode: "chat_output",
            schedule: {
              cronExpression: "0 12 * * *",
              timezone: "Asia/Shanghai",
              label: "daily noon",
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
              label: "daily noon",
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
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValueOnce({
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
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "message",
        replyingAgentId: "agent-1",
      }),
    );
  });

  it("records the runtime instruction into Langfuse chat-turn input when adapter metadata is available", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Working on it");
    const runtimePrompt = "You are Chat Specialist, replying inside Rudder's chat scene.\n\nConversation input:\n{}";

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
            key: "langfuse",
            runtimeName: "langfuse",
            name: "Langfuse",
            description: "Trace and eval instrumentation",
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
    expect(mockUpdateExecutionObservation).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        surface: "chat_turn",
        metadata: expect.objectContaining({
          runtimeCommand: "codex",
          runtimePromptCaptured: true,
          loadedSkillCount: 2,
          loadedSkillKeys: ["langfuse", "checks"],
          loadedSkills: [
            {
              key: "langfuse",
              runtimeName: "langfuse",
              name: "Langfuse",
              description: "Trace and eval instrumentation",
            },
            {
              key: "checks",
              runtimeName: "checks",
              name: "Checks",
              description: "Verification helpers",
            },
          ],
        }),
      }),
      expect.objectContaining({
        input: expect.objectContaining({
          body: "Need help",
          instruction: runtimePrompt,
          promptMetrics: {
            promptChars: 85,
          },
        }),
      }),
    );
    expect(mockEmitExecutionTranscriptTree).toHaveBeenCalledWith(expect.objectContaining({
      fallbackResult: {
        output: "Working on it",
      },
      initialTurnInput: runtimePrompt,
      transcript: [],
    }));
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
    expect(events[2]?.entry?.kind).toBe("thinking");
    expect(events[3]?.entry?.kind).toBe("tool_call");
    expect(events[7]?.messages).toHaveLength(1);
    expect(events[7]?.messages[0]?.id).toBe("message-assistant");
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "message",
        status: "streaming",
        body: "",
        replyingAgentId: "agent-1",
        transcript: expect.any(Array),
      }),
    );
    expect(mockChatService.updateMessage).toHaveBeenLastCalledWith(
      "chat-1",
      "message-assistant",
      expect.objectContaining({
        kind: "message",
        status: "completed",
        body: "Streaming reply",
        replyingAgentId: "agent-1",
        transcript: [
          expect.objectContaining({ kind: "thinking", text: "Inspecting current request" }),
          expect.objectContaining({ kind: "tool_call", name: "read_file" }),
        ],
      }),
    );
    expect(mockEmitExecutionTranscriptTree).toHaveBeenCalledWith(expect.objectContaining({
      fallbackResult: {
        output: "Streaming reply",
        subtype: "completed",
        isError: false,
      },
      initialTurnInput: runtimePrompt,
      transcript: [
        expect.objectContaining({ kind: "thinking", text: "Inspecting current request" }),
        expect.objectContaining({ kind: "tool_call", name: "read_file" }),
      ],
    }));
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
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.createAttachment.mockResolvedValueOnce(attachment);
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
    expect(mockChatService.createAttachment).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      conversationId: "chat-1",
      messageId: "message-user",
      contentType: "image/png",
      originalFilename: "image.png",
      createdByUserId: "user-1",
    }));
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
        transcript: [],
      }),
    );
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
    const stoppedMessage = {
      ...createMessage("message-stopped", "assistant", "message", "Partial reply"),
      status: "stopped",
    };
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
          outcome: "stopped",
          partialBody: "Partial reply",
          replyingAgentId: "agent-1",
        };
      });
    });

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(stoppedMessage);

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
    expect(stopRes.body).toEqual({ stopped: true });
    expect(capturedSignal?.aborted).toBe(true);

    releaseAssistant();
    const streamRes = await streamPromise;
    expect(streamRes.status).toBe(201);
    const events = String(streamRes.body)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toEqual({
      type: "final",
      messages: [expect.objectContaining({ id: "message-stopped", status: "stopped" })],
    });
  });

  it("traces manual chat-to-issue conversion as a chat action", async () => {
    const conversation = createConversation();
    const proposalMessageId = "10000000-0000-4000-8000-000000000099";
    const issue = {
      id: "issue-1",
      orgId: "organization-1",
      identifier: "ISS-1",
      title: "Implement auth flow",
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
    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: proposalMessageId,
        trigger: "convert_to_issue",
      }),
      expect.objectContaining({
        name: "chat:convert_to_issue",
        asType: "tool",
      }),
      expect.any(Function),
    );
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: proposalMessageId,
      }),
      expect.objectContaining({
        name: "chat.issue.created",
        metadata: expect.objectContaining({
          issueId: "issue-1",
          issueIdentifier: "ISS-1",
        }),
      }),
    );
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

  it("traces operation proposal resolution as a chat action", async () => {
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
    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: "message-op",
        trigger: "resolve_operation_proposal",
      }),
      expect.objectContaining({
        name: "chat:resolve_operation_proposal",
        asType: "tool",
      }),
      expect.any(Function),
    );
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "chat_action",
        rootExecutionId: "message-op",
      }),
      expect.objectContaining({
        name: "chat.operation_proposal.resolved",
        metadata: expect.objectContaining({
          action: "approve",
          messageId: "message-op",
          systemMessageId: "message-system-op",
        }),
      }),
    );
  });
});
