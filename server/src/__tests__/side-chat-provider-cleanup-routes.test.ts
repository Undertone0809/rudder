import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { sideChatProviderCleanupRoutes } from "../routes/side-chat-provider-cleanup.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const timestamp = new Date("2026-09-24T00:00:00.000Z");

const service = {
  listReviewRequired: vi.fn(),
  retryReviewRequired: vi.fn(),
};
const writeActivity = vi.fn(async () => undefined);

const intent = {
  id: INTENT_ID,
  orgId: ORG_ID,
  conversationId: CONVERSATION_ID,
  state: "review_required",
  stateReason: "provider_resource_has_an_active_source_alias",
  attemptCount: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  nativeSessionId: "private-provider-session-id",
  sessionParamsJson: { token: "private-session-parameter" },
  profileSnapshotJson: { exportEnv: { TOKEN: "private-profile-secret" } },
};

function createApp(actor: Record<string, unknown> = {
  type: "board",
  source: "board_key",
  userId: "operator-1",
  orgIds: [ORG_ID],
  isInstanceAdmin: true,
}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", sideChatProviderCleanupRoutes({} as never, {
    service: service as never,
    writeActivity: writeActivity as never,
  }));
  app.use(errorHandler);
  return app;
}

describe("Side Chat Provider cleanup routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    service.listReviewRequired.mockResolvedValue([intent]);
    service.retryReviewRequired.mockImplementation(async (_input, writeAudit) => {
      await writeAudit?.({} as never);
      return {
        id: INTENT_ID,
        orgId: ORG_ID,
        conversationId: CONVERSATION_ID,
        state: "pending",
        stateReason: null,
        nextAttemptAt: timestamp,
        updatedAt: timestamp,
      };
    });
    writeActivity.mockResolvedValue(undefined);
  });

  it("lists only organization-scoped, non-secret review summaries for an instance admin", async () => {
    const response = await request(createApp())
      .get(`/api/orgs/${ORG_ID}/side-chat-provider-cleanups/review-required?limit=999`)
      .expect(200);

    expect(service.listReviewRequired).toHaveBeenCalledWith(200, ORG_ID);
    expect(response.body).toEqual([{
      id: INTENT_ID,
      conversationId: CONVERSATION_ID,
      state: "review_required",
      stateReason: "provider_resource_has_an_active_source_alias",
      attemptCount: 1,
      createdAt: timestamp.toISOString(),
      updatedAt: timestamp.toISOString(),
    }]);
    expect(JSON.stringify(response.body)).not.toContain("private-provider-session-id");
    expect(JSON.stringify(response.body)).not.toContain("private-profile-secret");
  });

  it("reopens a review-required cleanup and records the operator action", async () => {
    const response = await request(createApp())
      .post(`/api/orgs/${ORG_ID}/side-chat-provider-cleanups/${INTENT_ID}/retry`)
      .expect(202);

    expect(service.retryReviewRequired).toHaveBeenCalledWith(
      { orgId: ORG_ID, intentId: INTENT_ID },
      expect.any(Function),
    );
    expect(writeActivity).toHaveBeenCalledWith({}, expect.objectContaining({
      orgId: ORG_ID,
      actorType: "user",
      actorId: "operator-1",
      action: "side_chat.provider_cleanup_retry_requested",
      entityType: "side_chat_provider_cleanup_intent",
      entityId: INTENT_ID,
    }));
    expect(response.body).toEqual({
      id: INTENT_ID,
      state: "pending",
      nextAttemptAt: timestamp.toISOString(),
    });
  });

  it("does not accept a retry when its audit write fails", async () => {
    writeActivity.mockRejectedValueOnce(new Error("audit store unavailable"));

    await request(createApp())
      .post(`/api/orgs/${ORG_ID}/side-chat-provider-cleanups/${INTENT_ID}/retry`)
      .expect(500);
  });

  it("requires instance-admin authority for cleanup review and retry", async () => {
    const app = createApp({
      type: "board",
      source: "board_key",
      userId: "member-1",
      orgIds: [ORG_ID],
      isInstanceAdmin: false,
    });

    await request(app)
      .post(`/api/orgs/${ORG_ID}/side-chat-provider-cleanups/${INTENT_ID}/retry`)
      .expect(403);
    expect(service.retryReviewRequired).not.toHaveBeenCalled();
    expect(writeActivity).not.toHaveBeenCalled();
  });
});
