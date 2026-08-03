import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { productAnalyticsCollectorRoutes } from "../routes/product-analytics-collector.js";
import { createProductAnalyticsCollector, InMemoryProductAnalyticsCollectorStore } from "../services/product-analytics-collector.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";

function app() {
  const store = new InMemoryProductAnalyticsCollectorStore();
  store.setInstallationState(installationId, { consentVersion: "v1", consentEpoch: 1, revoked: false });
  const collector = createProductAnalyticsCollector(store);
  const server = express();
  server.use(express.json());
  server.use(productAnalyticsCollectorRoutes(collector, () => ({
    installationId,
    mode: "anonymous",
    consentVersion: "v1",
    consentEpoch: 1,
  })));
  server.use(errorHandler);
  return { server, store };
}

function event() {
  return {
    eventId,
    eventName: "human_work_started",
    schemaVersion: 1,
    occurredAt: new Date().toISOString(),
    environment: "production",
    appVersion: "0.6.6",
    releaseChannel: "stable",
    deploymentMode: "desktop_local",
    actorKind: "user",
    origin: "human",
    pseudonymousInstallationId: "install-hash",
    pseudonymousOrgId: null,
    pseudonymousWorkId: "work-hash",
    pseudonymousWorkCycleId: "cycle-hash",
    pseudonymousRootRunId: null,
    pseudonymousRunId: null,
    completionRevision: null,
    properties: { work_surface: "chat", origin: "human" },
    confidence: "exact",
    isBackfill: false,
  };
}

describe("product analytics collector routes", () => {
  it("returns idempotent batch acknowledgements without exposing request logging", async () => {
    const { server, store } = app();
    const payload = event();
    const first = await request(server).post("/api/analytics/v1/events:batch").send({ events: [payload] });
    const duplicate = await request(server).post("/api/analytics/v1/events:batch").send({ events: [payload] });

    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(1);
    expect(duplicate.body.duplicate).toBe(1);
    expect(store.listEvents()).toHaveLength(1);
  });

  it("rejects a missing event batch with a schema error", async () => {
    const { server } = app();
    const response = await request(server).post("/api/analytics/v1/events:batch").send({});
    expect(response.status).toBe(422);
    expect(response.body.rejected[0]).toMatchObject({ errorCode: "invalid_schema" });
  });

  it("returns conflict for a reused event id with a different payload", async () => {
    const { server } = app();
    const first = event();
    await request(server).post("/api/analytics/v1/events:batch").send({ events: [first] });
    const response = await request(server).post("/api/analytics/v1/events:batch").send({ events: [{ ...first, properties: { work_surface: "issue" } }] });
    expect(response.status).toBe(409);
    expect(response.body.rejected[0]).toMatchObject({ errorCode: "conflict" });
  });
});
