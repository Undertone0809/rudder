import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { integrationRoutes } from "../routes/integrations.js";
import { createFeishuCallbackSignature } from "../services/integrations/feishu/event-verifier.js";

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
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as any).rawBody = buf;
    },
  }));
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
      outbound: {
        provider: "feishu",
        externalChatId: "oc_group",
        externalMessageId: null,
        text: "已写入 Rudder Messenger，并开始处理。",
      },
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
        outbound: {
          provider: "feishu",
          externalChatId: "oc_group",
          externalMessageId: null,
          text: "已写入 Rudder Messenger，并开始处理。",
        },
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

  it("answers Feishu URL verification challenges without dispatching", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .send({
        type: "url_verification",
        token: "verification-token",
        challenge: "challenge-value",
        mockVerificationToken: "verification-token",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ challenge: "challenge-value" });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("rejects Feishu callbacks with a mismatched verification token", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .send({
        type: "url_verification",
        token: "wrong-token",
        challenge: "challenge-value",
        mockVerificationToken: "verification-token",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Feishu callback verification token");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("rejects Feishu callbacks with an invalid signature", async () => {
    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .set("X-Lark-Request-Timestamp", "1700000000")
      .set("X-Lark-Request-Nonce", "nonce-1")
      .set("X-Lark-Signature", "bad-signature")
      .send({
        eventId: "event-1",
        appId: "cli_a_app",
        messageId: "om_1",
        chatId: "oc_group",
        senderOpenId: "ou_sender",
        mockEncryptKey: "encrypt-key",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid Feishu callback signature");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("accepts Feishu callbacks with a valid signature", async () => {
    const payload = {
      eventId: "event-1",
      appId: "cli_a_app",
      messageId: "om_1",
      chatId: "oc_group",
      senderOpenId: "ou_sender",
      body: "signed hello",
      mockEncryptKey: "encrypt-key",
    };
    const rawBody = JSON.stringify(payload);
    const signature = createFeishuCallbackSignature({
      timestamp: "1700000000",
      nonce: "nonce-1",
      encryptKey: "encrypt-key",
      rawBody,
    });

    const res = await request(createApp(boardActor))
      .post("/api/orgs/org-1/integrations/feishu/mock-inbound")
      .set("Content-Type", "application/json")
      .set("X-Lark-Request-Timestamp", "1700000000")
      .set("X-Lark-Request-Nonce", "nonce-1")
      .set("X-Lark-Signature", signature)
      .send(rawBody);

    expect(res.status).toBe(201);
    expect(mockDispatch).toHaveBeenCalledWith(expect.objectContaining({ body: "signed hello" }), mockDeps);
  });
});
