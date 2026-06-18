import { describe, expect, it, vi } from "vitest";
import {
  dispatchFeishuInboundMessage,
  parseIntegrationIssueCommand,
  type AgentIntegrationInboundDispatcherDeps,
  type FeishuInboundMessage,
  type ResolvedAgentIntegration,
  type ResolvedIntegrationUserBinding,
} from "../services/integrations/feishu/inbound-dispatcher.js";

const integration: ResolvedAgentIntegration = {
  id: "integration-1",
  orgId: "org-1",
  agentId: "agent-1",
  provider: "feishu",
  status: "active",
};

const boundMember: ResolvedIntegrationUserBinding = {
  userId: "user-1",
  orgMember: true,
};

function inboundEvent(overrides: Partial<FeishuInboundMessage> = {}): FeishuInboundMessage {
  return {
    provider: "feishu",
    eventId: "event-1",
    appId: "app-1",
    botOpenId: "bot-1",
    chatId: "chat-1",
    chatType: "p2p",
    messageId: "message-1",
    senderOpenId: "sender-1",
    senderUnionId: "union-1",
    body: "hello",
    commandBody: "hello",
    addressedToBot: true,
    messageType: "text",
    ...overrides,
  };
}

function dispatcherDeps(order: string[] = []): AgentIntegrationInboundDispatcherDeps {
  return {
    resolveActiveIntegration: vi.fn(async () => {
      order.push("resolveIntegration");
      return integration;
    }),
    auditDrop: vi.fn(async () => {
      order.push("auditDrop");
    }),
    resolveUserBinding: vi.fn(async () => {
      order.push("resolveUserBinding");
      return boundMember;
    }),
    mintBindingToken: vi.fn(async () => {
      order.push("mintBindingToken");
    }),
    tryInsertDedup: vi.fn(async () => {
      order.push("tryInsertDedup");
      return true;
    }),
    ensureChatBinding: vi.fn(async () => {
      order.push("ensureChatBinding");
      return { conversationId: "conversation-1" };
    }),
    appendInboundMessage: vi.fn(async () => {
      order.push("appendInboundMessage");
      return { chatMessageId: "chat-message-1" };
    }),
    createIssueFromCommand: vi.fn(async () => {
      order.push("createIssueFromCommand");
      return { issueId: "issue-1" };
    }),
    enqueueAgentRun: vi.fn(async () => {
      order.push("enqueueAgentRun");
      return { runId: "run-1" };
    }),
    createOutboundPlaceholder: vi.fn(async () => {
      order.push("createOutboundPlaceholder");
    }),
  };
}

describe("Feishu inbound dispatcher", () => {
  it("drops non-addressed group messages before user lookup, dedup, or body persistence", async () => {
    const order: string[] = [];
    const deps = dispatcherDeps(order);

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({ chatType: "group", addressedToBot: false, body: "private group chatter" }),
      deps,
    );

    expect(result).toEqual({ status: "dropped", reason: "not_addressed_in_group" });
    expect(order).toEqual(["resolveIntegration", "auditDrop"]);
    expect(deps.auditDrop).toHaveBeenCalledWith(expect.objectContaining({
      dropReason: "not_addressed_in_group",
      bodyPersisted: false,
    }));
    expect(deps.auditDrop).not.toHaveBeenCalledWith(expect.objectContaining({ body: expect.anything() }));
    expect(deps.resolveUserBinding).not.toHaveBeenCalled();
    expect(deps.tryInsertDedup).not.toHaveBeenCalled();
    expect(deps.appendInboundMessage).not.toHaveBeenCalled();
  });

  it("requests identity binding for unbound users without persisting message body", async () => {
    const order: string[] = [];
    const deps = dispatcherDeps(order);
    vi.mocked(deps.resolveUserBinding).mockImplementationOnce(async () => {
      order.push("resolveUserBinding");
      return null;
    });

    const result = await dispatchFeishuInboundMessage(inboundEvent(), deps);

    expect(result).toEqual({ status: "binding_required" });
    expect(order).toEqual(["resolveIntegration", "resolveUserBinding", "mintBindingToken", "auditDrop"]);
    expect(deps.auditDrop).toHaveBeenCalledWith(expect.objectContaining({
      dropReason: "unbound_user",
      bodyPersisted: false,
    }));
    expect(deps.tryInsertDedup).not.toHaveBeenCalled();
    expect(deps.appendInboundMessage).not.toHaveBeenCalled();
  });

  it("dedupes before chat binding, append, issue creation, run enqueue, and outbound placeholder", async () => {
    const order: string[] = [];
    const deps = dispatcherDeps(order);
    vi.mocked(deps.tryInsertDedup).mockImplementationOnce(async () => {
      order.push("tryInsertDedup");
      return false;
    });

    const result = await dispatchFeishuInboundMessage(inboundEvent(), deps);

    expect(result).toEqual({ status: "dropped", reason: "duplicate" });
    expect(order).toEqual(["resolveIntegration", "resolveUserBinding", "tryInsertDedup", "auditDrop"]);
    expect(deps.auditDrop).toHaveBeenCalledWith(expect.objectContaining({
      dropReason: "duplicate",
      bodyPersisted: false,
    }));
    expect(deps.ensureChatBinding).not.toHaveBeenCalled();
    expect(deps.appendInboundMessage).not.toHaveBeenCalled();
    expect(deps.createIssueFromCommand).not.toHaveBeenCalled();
    expect(deps.enqueueAgentRun).not.toHaveBeenCalled();
    expect(deps.createOutboundPlaceholder).not.toHaveBeenCalled();
  });

  it("accepts addressed messages in dispatcher order and parses /issue before run enqueue", async () => {
    const order: string[] = [];
    const deps = dispatcherDeps(order);

    const result = await dispatchFeishuInboundMessage(
      inboundEvent({ commandBody: "/issue Fix Feishu login\nThe QR flow expires too early." }),
      deps,
    );

    expect(result).toEqual({
      status: "accepted",
      conversationId: "conversation-1",
      chatMessageId: "chat-message-1",
      issueId: "issue-1",
      runId: "run-1",
    });
    expect(order).toEqual([
      "resolveIntegration",
      "resolveUserBinding",
      "tryInsertDedup",
      "ensureChatBinding",
      "appendInboundMessage",
      "createIssueFromCommand",
      "enqueueAgentRun",
      "createOutboundPlaceholder",
    ]);
    expect(deps.createIssueFromCommand).toHaveBeenCalledWith(
      integration,
      boundMember,
      { conversationId: "conversation-1" },
      { chatMessageId: "chat-message-1" },
      { title: "Fix Feishu login", body: "The QR flow expires too early." },
      expect.any(Object),
    );
  });
});

describe("parseIntegrationIssueCommand", () => {
  it("parses title and optional body from /issue commands", () => {
    expect(parseIntegrationIssueCommand("/issue Ship Feishu bridge\nUse long connection.")).toEqual({
      title: "Ship Feishu bridge",
      body: "Use long connection.",
    });
    expect(parseIntegrationIssueCommand("/issue Ship Feishu bridge")).toEqual({
      title: "Ship Feishu bridge",
      body: null,
    });
    expect(parseIntegrationIssueCommand("hello")).toBeNull();
    expect(parseIntegrationIssueCommand("/issue")).toBeNull();
  });
});
