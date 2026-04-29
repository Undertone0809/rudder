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

const mockChatService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  markRead: vi.fn(),
  setPinned: vi.fn(),
  listMessages: vi.fn(),
  addMessage: vi.fn(),
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
}));

const mockProjectService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
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
  agentService: () => mockAgentService,
  chatService: () => mockChatService,
  organizationService: () => mockCompanyService,
  goalService: () => mockGoalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  operatorProfileService: () => mockOperatorProfileService,
  projectService: () => mockProjectService,
}));

vi.mock("../services/chat-assistant.js", () => ({
  chatAssistantService: () => mockChatAssistantService,
}));

vi.mock("../langfuse.js", () => ({
  withExecutionObservation: mockWithExecutionObservation,
  observeExecutionEvent: mockObserveExecutionEvent,
  updateExecutionObservation: mockUpdateExecutionObservation,
  updateExecutionTraceIO: mockUpdateExecutionTraceIO,
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
    preferredAgentId: null,
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
      sourceType: "copilot",
      sourceLabel: "Rudder Copilot",
      runtimeAgentId: "copilot-agent",
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
      sourceType: "copilot",
      sourceLabel: "Rudder Copilot",
      runtimeAgentId: "copilot-agent",
      agentRuntimeType: "codex_local",
      model: "gpt-5",
      error: null,
    });
    mockLogActivity.mockResolvedValue(undefined);
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
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "issue_proposal",
        body: "This should become an issue.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "copilot-agent",
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

  it("auto-creates an issue from a plan-mode proposal without approval", async () => {
    const conversation = createConversation({ planMode: true });
    const userMessage = createMessage("message-user", "user", "message", "Plan the auth rollout");
    const proposalMessage = {
      ...createMessage("message-proposal", "assistant", "issue_proposal", "I mapped the rollout plan."),
      structuredPayload: {
        issueProposal: {
          title: "Implement auth flow",
          description: "Track the auth rollout plan in an issue.",
          priority: "high",
        },
        planDocument: {
          title: "Auth rollout plan",
          body: "## Scope\n- Login\n- Session management",
        },
      },
    };
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
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(proposalMessage);
    mockChatService.addMessage.mockResolvedValueOnce(systemMessage);
    mockChatService.convertToIssue.mockResolvedValue(issue);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "I mapped the rollout plan.",
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "issue_proposal",
        body: "I mapped the rollout plan.",
        structuredPayload: proposalMessage.structuredPayload,
        replyingAgentId: "copilot-agent",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Plan the auth rollout" });

    expect(res.status).toBe(201);
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
    expect(mockChatService.convertToIssue).toHaveBeenCalledWith("chat-1", {
      actorUserId: "user-1",
      messageId: "message-proposal",
    });
    expect(mockChatService.addMessage).toHaveBeenNthCalledWith(
      1,
      "chat-1",
      expect.objectContaining({
        role: "assistant",
        kind: "issue_proposal",
      }),
    );
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
        details: expect.objectContaining({
          issueId: "issue-1",
          issueIdentifier: "ISS-1",
          source: "plan_mode",
        }),
      }),
    );
    expect(res.body.messages).toHaveLength(3);
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
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "message",
        body: "Working on it",
        structuredPayload: null,
        replyingAgentId: "copilot-agent",
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

  it("persists plan-mode user input requests without creating approvals", async () => {
    const conversation = createConversation({ planMode: true });
    const userMessage = createMessage("message-user", "user", "message", "Need a plan");
    const structuredPayload = {
      requestUserInput: {
        questions: [{
          id: "scope",
          header: "Scope",
          question: "Which scope should the plan use?",
          options: [
            { id: "minimal", label: "Minimal", description: "Smallest useful change." },
            { id: "complete", label: "Complete", description: "Cover the whole workflow." },
          ],
        }],
      },
    };
    const requestMessage = {
      ...createMessage("message-request", "assistant", "user_input_request", "Choose the planning scope."),
      structuredPayload,
    };

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(requestMessage);
    mockChatAssistantService.streamChatAssistantReply.mockResolvedValue({
      outcome: "completed",
      partialBody: "Choose the planning scope.",
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "user_input_request",
        body: "Choose the planning scope.",
        structuredPayload,
        replyingAgentId: "copilot-agent",
      },
    });

    const res = await request(createApp())
      .post("/api/chats/chat-1/messages")
      .send({ body: "Need a plan" });

    expect(res.status).toBe(201);
    expect(mockChatService.addMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({
        kind: "user_input_request",
        body: "Choose the planning scope.",
        structuredPayload,
      }),
    );
    expect(mockChatService.createProposalApproval).not.toHaveBeenCalled();
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
        prompt: "You are Rudder Copilot, the system-managed chat copilot for this Rudder organization.\n\nConversation input:\n{}",
        promptMetrics: {
          promptChars: 64,
        },
        context: {},
      });
      return {
        outcome: "completed",
        partialBody: "Working on it",
        replyingAgentId: "copilot-agent",
        reply: {
          kind: "message",
          body: "Working on it",
          structuredPayload: null,
          replyingAgentId: "copilot-agent",
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
          instruction: "You are Rudder Copilot, the system-managed chat copilot for this Rudder organization.\n\nConversation input:\n{}",
          promptMetrics: {
            promptChars: 64,
          },
        }),
      }),
    );
  });

  it("streams ack, transcript entries, deltas, and final persisted messages", async () => {
    const conversation = createConversation();
    const userMessage = createMessage("message-user", "user", "message", "Need help");
    const assistantMessage = createMessage("message-assistant", "assistant", "message", "Streaming reply");

    mockChatService.getById.mockResolvedValue(conversation);
    mockChatService.listMessages.mockResolvedValue([userMessage]);
    mockChatService.addUserChatMessage.mockResolvedValueOnce(userMessage);
    mockChatService.addMessage.mockResolvedValueOnce(assistantMessage);
    mockChatAssistantService.streamChatAssistantReply.mockImplementation(async (input) => {
      await input.onAssistantState?.("streaming");
      await input.onTranscriptEntry?.({
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
      await input.onAssistantDelta?.("Streaming ");
      await input.onAssistantDelta?.("reply");
      await input.onAssistantState?.("finalizing");
      return {
        outcome: "completed",
        partialBody: "Streaming reply",
        replyingAgentId: "copilot-agent",
        reply: {
          kind: "message",
          body: "Streaming reply",
          structuredPayload: null,
          replyingAgentId: "copilot-agent",
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
        replyingAgentId: "copilot-agent",
        transcript: [
          expect.objectContaining({ kind: "thinking", text: "Inspecting current request" }),
          expect.objectContaining({ kind: "tool_call", name: "read_file" }),
        ],
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
      replyingAgentId: "copilot-agent",
      reply: {
        kind: "message",
        body: "Yes.",
        structuredPayload: null,
        replyingAgentId: "copilot-agent",
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
      replyingAgentId: "copilot-agent",
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
        replyingAgentId: "copilot-agent",
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
          replyingAgentId: "copilot-agent",
          reply: {
            kind: "message",
            body: "Completed after disconnect",
            structuredPayload: null,
            replyingAgentId: "copilot-agent",
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
        expect(mockChatService.addMessage).toHaveBeenCalledWith(
          "chat-1",
          expect.objectContaining({
            role: "assistant",
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
          replyingAgentId: "copilot-agent",
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
