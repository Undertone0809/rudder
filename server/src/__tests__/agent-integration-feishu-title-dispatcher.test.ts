import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  existingBinding: null as { conversationId: string; createdAt: Date } | null,
  select: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));

const mockChatSvc = vi.hoisted(() => ({
  create: vi.fn(),
  createWithInitialMessage: vi.fn(),
  addMessage: vi.fn(),
  getById: vi.fn(),
  getMessage: vi.fn(),
}));

const mockStartAutomaticGeneration = vi.hoisted(() => vi.fn());

vi.mock("@rudderhq/db", () => ({
  agentIntegrationBindingTokens: {},
  agentIntegrationChatBindings: {
    conversationId: "conversation_id",
    externalChatId: "external_chat_id",
    externalChatType: "external_chat_type",
    integrationId: "integration_id",
    orgId: "org_id",
  },
  agentIntegrationInboundAudit: {},
  agentIntegrationInboundDedup: {},
  agentIntegrationOutboundMessages: {},
  agentIntegrationUserBindings: {},
  agentIntegrations: {},
  chatConversations: {
    createdAt: "created_at",
    id: "id",
  },
  chatGenerations: {
    conversationId: "conversation_id",
    id: "id",
    status: "status",
  },
  organizationMemberships: {},
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({})),
  eq: vi.fn(() => ({})),
  inArray: vi.fn(() => ({})),
  isNull: vi.fn(() => ({})),
  or: vi.fn(() => ({})),
}));

vi.mock("../services/chats.js", () => ({
  chatService: vi.fn(() => mockChatSvc),
}));

vi.mock("../services/chat-agent-runs.js", () => ({
  chatAgentRunService: vi.fn(() => ({})),
}));

vi.mock("../services/issues.js", () => ({
  issueService: vi.fn(() => ({})),
}));

vi.mock("../services/product-intelligence.js", () => ({
  productIntelligenceService: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock("../services/chat-title-generation.js", () => ({
  chatTitleGenerationService: vi.fn(() => ({
    startAutomaticGeneration: mockStartAutomaticGeneration,
  })),
}));

const returningNewBinding = {
  returning: vi.fn(async () => [{ conversationId: "conversation-1" }]),
};
const insertNewBinding = {
  values: vi.fn(() => returningNewBinding),
};

function selectRows(rows: unknown[]) {
  const query = {
    from: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(() => query),
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

function selectExistingBinding(fields: Record<string, unknown>) {
  const isBindingLookup = Object.prototype.hasOwnProperty.call(fields, "conversationId");
  return selectRows(isBindingLookup && mockDb.existingBinding ? [mockDb.existingBinding] : []);
}

function integration() {
  return {
    id: "integration-1",
    orgId: "org-1",
    agentId: "agent-1",
    provider: "feishu" as const,
    status: "active" as const,
  };
}

function binding() {
  return {
    userId: "user-1",
    orgMember: true,
  };
}

function inboundEvent(overrides: Record<string, unknown> = {}) {
  return {
    provider: "feishu" as const,
    eventId: "event-1",
    appId: "app-1",
    botOpenId: "bot-1",
    chatId: "oc-chat",
    chatType: "p2p" as const,
    messageId: "message-1",
    senderOpenId: "sender-1",
    senderUnionId: "union-1",
    body: "hi, what skill do you have?",
    commandBody: "hi, what skill do you have?",
    addressedToBot: true,
    messageType: "text",
    ...overrides,
  };
}

describe("Feishu DB dispatcher chat title generation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.existingBinding = null;
    mockDb.select.mockImplementation(selectExistingBinding);
    mockDb.insert.mockReturnValue(insertNewBinding);
    mockDb.transaction.mockImplementation(async (callback: (tx: typeof mockDb) => unknown) => callback(mockDb));
    mockChatSvc.create.mockResolvedValue({
      id: "conversation-1",
      orgId: "org-1",
      title: "hi, what skill do you have?",
    });
    mockChatSvc.createWithInitialMessage.mockResolvedValue({
      conversation: {
        id: "conversation-1",
        orgId: "org-1",
        title: "hi, what skill do you have?",
      },
      message: {
        id: "message-row-1",
        role: "user",
        kind: "message",
        body: "hi, what skill do you have?",
      },
    });
    mockChatSvc.addMessage.mockResolvedValue({
      id: "message-row-1",
      role: "user",
      kind: "message",
      body: "hi, what skill do you have?",
    });
    mockChatSvc.getById.mockResolvedValue({
      id: "conversation-1",
      orgId: "org-1",
      title: "hi, what skill do you have?",
    });
    mockChatSvc.getMessage.mockResolvedValue({
      id: "message-row-1",
      role: "user",
      kind: "message",
      body: "hi, what skill do you have?",
    });
  });

  it("starts AI title generation after appending the first message for a newly created Feishu chat", async () => {
    const { createFeishuInboundDispatcherDbDeps } = await import(
      "../services/integrations/feishu/inbound-dispatcher-db.js"
    );
    const deps = createFeishuInboundDispatcherDbDeps(mockDb as never, {
      enqueueAgentRun: false,
      createOutboundPlaceholder: false,
      productIntelligence: { execute: vi.fn() },
    });

    const chat = await deps.ensureChatBinding(integration(), binding(), inboundEvent());
    const message = await deps.appendInboundMessage(integration(), binding(), chat, inboundEvent());

    expect(chat).toMatchObject({
      conversationId: "conversation-1",
      created: true,
      initialTitle: "hi, what skill do you have?",
    });
    expect(message).toEqual({ chatMessageId: "message-row-1" });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockChatSvc.createWithInitialMessage).toHaveBeenCalledTimes(1);
    expect(mockChatSvc.addMessage).not.toHaveBeenCalled();
    expect(mockStartAutomaticGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conversation-1" }),
      expect.objectContaining({ id: "message-row-1" }),
      { expectedCurrentTitle: "hi, what skill do you have?" },
    );
  }, 30_000);

  it("uses the normal chat title generation decision for existing Feishu chat bindings", async () => {
    const { createFeishuInboundDispatcherDbDeps } = await import(
      "../services/integrations/feishu/inbound-dispatcher-db.js"
    );
    mockDb.existingBinding = { conversationId: "conversation-1", createdAt: new Date() };
    const deps = createFeishuInboundDispatcherDbDeps(mockDb as never, {
      enqueueAgentRun: false,
      createOutboundPlaceholder: false,
      productIntelligence: { execute: vi.fn() },
    });

    const chat = await deps.ensureChatBinding(integration(), binding(), inboundEvent());
    await deps.appendInboundMessage(integration(), binding(), chat, inboundEvent({
      messageId: "message-2",
      body: "and what else?",
      commandBody: "and what else?",
    }));

    expect(chat).toMatchObject({ conversationId: "conversation-1" });
    expect(mockStartAutomaticGeneration).toHaveBeenCalledWith(
      expect.objectContaining({ id: "conversation-1" }),
      expect.objectContaining({ id: "message-row-1" }),
      { expectedCurrentTitle: undefined },
    );
  });
});
