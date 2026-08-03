import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { productAnalyticsRoutes } from "../routes/product-analytics.js";

const mockService = vi.hoisted(() => ({
  summary: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("../services/product-analytics.js", () => ({
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
}));

const ORG_ID = "11111111-1111-4111-8111-111111111111";

function createApp(actor: Record<string, unknown>) {
  const app = express();
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
});
