import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { productAnalyticsRoutes } from "../routes/product-analytics.js";

const mockService = vi.hoisted(() => ({
  summary: vi.fn(),
  listEvents: vi.fn(),
}));
const mockOutbox = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  assertSecret: vi.fn(),
  claim: vi.fn(),
  getState: vi.fn(),
}));

vi.mock("../services/product-analytics.js", () => ({
  acknowledgeProductAnalyticsOutboxClaim: mockOutbox.acknowledge,
  assertProductAnalyticsInstallationSecret: mockOutbox.assertSecret,
  claimProductAnalyticsOutboxBatch: mockOutbox.claim,
  getProductAnalyticsInstallationState: mockOutbox.getState,
  PRODUCT_ANALYTICS_EVENT_NAMES: [
    "organization_created",
    "human_work_started",
    "run_started",
    "run_succeeded",
    "run_failed",
    "output_ready",
    "review_decision_recorded",
  ],
  productAnalyticsService: () => mockService,
  reconcileProductAnalyticsInstallationMode: vi.fn(),
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = actor;
    next();
  });
  app.use("/api", productAnalyticsRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockService.summary.mockResolvedValue({ metrics: { ledger_event_count: 0 } });
  mockService.listEvents.mockResolvedValue([]);
  mockOutbox.acknowledge.mockResolvedValue({ updatedCount: 1, state: "delivered" });
  mockOutbox.assertSecret.mockResolvedValue(undefined);
  mockOutbox.claim.mockResolvedValue(null);
  mockOutbox.getState.mockResolvedValue(null);
});

describe("product analytics routes", () => {
  it("returns an organization-scoped summary", async () => {
    const response = await request(createApp({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
    })).get(`/api/orgs/${ORG_ID}/analytics/product?windowDays=7`);

    expect(response.status).toBe(200);
    expect(mockService.summary).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ windowDays: 7 }));
  });

  it("rejects malformed dates, event names, limits, and organization ids", async () => {
    const app = createApp({ type: "board", source: "local_implicit", isInstanceAdmin: true });

    await expect(request(app).get(`/api/orgs/${ORG_ID}/analytics/product?from=not-a-date`)).resolves.toMatchObject({ status: 422 });
    await expect(request(app).get(`/api/orgs/${ORG_ID}/analytics/product/events?eventName=unknown`)).resolves.toMatchObject({ status: 422 });
    await expect(request(app).get(`/api/orgs/${ORG_ID}/analytics/product?windowDays=7foo`)).resolves.toMatchObject({ status: 422 });
    await expect(request(app).get(`/api/orgs/${ORG_ID}/analytics/product/events?limit=1.5`)).resolves.toMatchObject({ status: 422 });
    await expect(request(app).get("/api/orgs/not-an-org/analytics/product")).resolves.toMatchObject({ status: 422 });
  });

  it("does not allow an agent key to read another organization", async () => {
    const response = await request(createApp({ type: "agent", orgId: ORG_ID, agentId: "agent-1" }))
      .get("/api/orgs/22222222-2222-4222-8222-222222222222/analytics/product");

    expect(response.status).toBe(403);
    expect(mockService.summary).not.toHaveBeenCalled();
  });

  it("does not expose installation payload previews through the organization API", async () => {
    mockOutbox.getState.mockResolvedValue({
      installation: {
        installationId: "installation-1",
        mode: "account_linked",
        state: {
          pendingCount: 1,
          lastPayloadAt: "2026-08-04T09:00:00.000Z",
          lastPayload: [{ eventName: "work_loop_completed", pseudonymousOrgId: "org-hash-a" }],
        },
      },
      consent: null,
      pendingCount: 1,
    });

    const response = await request(createApp({
      type: "board",
      source: "session",
      userId: "user-b",
      orgIds: [ORG_ID],
    })).get(`/api/orgs/${ORG_ID}/analytics/product/installation/installation-1`);

    expect(response.status).toBe(200);
    expect(response.body.installation.state).toEqual({ pendingCount: 1 });
  });

  it("forwards the installation secret when acknowledging an outbox claim", async () => {
    const installationId = "installation-1";
    const eventId = "22222222-2222-4222-8222-222222222222";
    const response = await request(createApp({
      type: "board",
      source: "local_implicit",
      isInstanceAdmin: true,
    })).post(`/api/orgs/${ORG_ID}/analytics/product/installation/${installationId}/outbox/ack`).send({
      installationSecret: "secret-1",
      deliveryMode: "anonymous",
      eventIds: [eventId],
      claimToken: "claim-1",
      delivered: true,
    });

    expect(response.status).toBe(200);
    expect(mockOutbox.acknowledge).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      installationId,
      installationSecret: "secret-1",
      eventIds: [eventId],
      claimToken: "claim-1",
      consentedLocalUserId: null,
    }));
  });

  it("binds account-linked outbox claims to the signed-in local user", async () => {
    const installationId = "installation-1";
    const response = await request(createApp({
      type: "board",
      source: "session",
      userId: "user-a",
      orgIds: [ORG_ID],
    })).post(`/api/orgs/${ORG_ID}/analytics/product/installation/${installationId}/outbox/claim`).send({
      installationSecret: "secret-1",
      deliveryMode: "account_linked",
      limit: 100,
    });

    expect(response.status).toBe(200);
    expect(mockOutbox.claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      installationId,
      deliveryMode: "account_linked",
      consentedLocalUserId: "user-a",
    }));
  });

  it("rejects account-linked claims from the synthetic local actor", async () => {
    const response = await request(createApp({
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      isInstanceAdmin: true,
    })).post(`/api/orgs/${ORG_ID}/analytics/product/installation/installation-1/outbox/claim`).send({
      installationSecret: "secret-1",
      deliveryMode: "account_linked",
    });

    expect(response.status).toBe(422);
    expect(mockOutbox.claim).not.toHaveBeenCalled();
  });
});
