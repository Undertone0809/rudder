import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { integrationRoutes } from "../routes/integrations.js";

const mockDeps = { kind: "feishu-dispatcher-deps" };
const mockCreateDeps = vi.hoisted(() => vi.fn(() => mockDeps));
const mockDispatch = vi.hoisted(() => vi.fn());

vi.mock("../services/integrations/feishu/inbound-dispatcher-db.js", () => ({
  createFeishuInboundDispatcherDbDeps: mockCreateDeps,
}));

vi.mock("../services/integrations/feishu/inbound-dispatcher.js", () => ({
  dispatchFeishuInboundMessage: mockDispatch,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", integrationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const boardActor = {
  type: "board",
  userId: "user-1",
  orgIds: ["org-1"],
  source: "session",
  isInstanceAdmin: false,
};

describe("integration routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatch.mockResolvedValue({
      status: "accepted",
      conversationId: "conversation-1",
      chatMessageId: "message-1",
      issueId: null,
      runId: "run-1",
    });
  });

  it("normalizes mock Feishu inbound events and dispatches through org-scoped deps", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .send({
        botOpenId: "ou_bot",
        header: { event_id: "event-1", app_id: "cli_a_app" },
        event: {
          sender: { sender_id: { open_id: "ou_sender", union_id: "on_sender" } },
          message: {
            message_id: "om_1",
            chat_id: "oc_group",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@Rudder hello" }),
            mentions: [{ id: { open_id: "ou_bot" } }],
          },
        },
      });

    expect(res.status).toBe(201);
    expect(mockCreateDeps).toHaveBeenCalledWith(expect.anything(), { orgId: "org-1" });
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "feishu",
        eventId: "event-1",
        appId: "cli_a_app",
        messageId: "om_1",
        chatId: "oc_group",
        chatType: "group",
        senderOpenId: "ou_sender",
        addressedToBot: true,
        body: "@Rudder hello",
      }),
      mockDeps,
    );
    expect(res.body).toEqual({
      result: {
        status: "accepted",
        conversationId: "conversation-1",
        chatMessageId: "message-1",
        issueId: null,
        runId: "run-1",
      },
      normalized: {
        eventId: "event-1",
        messageId: "om_1",
        chatId: "oc_group",
        chatType: "group",
        messageType: "text",
        addressedToBot: true,
      },
    });
  });

  it("returns dropped dispatcher results without creating a business response status", async () => {
    mockDispatch.mockResolvedValueOnce({ status: "dropped", reason: "not_addressed_in_group" });

    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .send({
        eventId: "event-1",
        appId: "cli_a_app",
        messageId: "om_1",
        chatId: "oc_group",
        chatType: "group",
        senderOpenId: "ou_sender",
        body: "group chatter",
        addressedToBot: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.result).toEqual({ status: "dropped", reason: "not_addressed_in_group" });
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ addressedToBot: false }), mockDeps);
  });

  it("keeps the mock inbound hook board-only and organization-scoped", async () => {
    const agentRes = await request(createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "org-1",
      source: "agent_key",
    }))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .send({
        eventId: "event-1",
        appId: "cli_a_app",
        messageId: "om_1",
        chatId: "oc_group",
        senderOpenId: "ou_sender",
      });
    expect(agentRes.status).toBe(403);

    const crossOrgRes = await request(createApp(boardActor))
      .post("/api/orgs/org-2/integrations/feishu/mock-inbound")
      .send({
        eventId: "event-1",
        appId: "cli_a_app",
        messageId: "om_1",
        chatId: "oc_group",
        senderOpenId: "ou_sender",
      });
    expect(crossOrgRes.status).toBe(403);
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
