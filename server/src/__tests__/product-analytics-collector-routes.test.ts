import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { productAnalyticsCollectorRoutes } from "../routes/product-analytics-collector.js";
import { createProductAnalyticsCollector, InMemoryProductAnalyticsCollectorStore } from "../services/product-analytics-collector.js";

const installationId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const activeServers = new Set<Server>();

async function startApp(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

async function app() {
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
  }), { consentSyncSecret: "identity-ledger-hook" }));
  server.use(errorHandler);
  return { server: await startApp(server), store };
}

afterEach(async () => {
  await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

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
  it("requires Identity consent synchronization before accepting an assertion batch", async () => {
    const store = new InMemoryProductAnalyticsCollectorStore();
    const collector = createProductAnalyticsCollector(store);
    const server = express();
    server.use(express.json());
    server.use(productAnalyticsCollectorRoutes(collector, () => ({
      installationId,
      mode: "anonymous",
      consentVersion: "v1",
      consentEpoch: 1,
    }), { consentSyncSecret: "identity-ledger-hook" }));
    const listening = await startApp(server);

    const beforeSync = await request(listening).post("/api/analytics/v1/events:batch").send({ events: [event()] });
    expect(beforeSync.body.rejected[0]).toMatchObject({ errorCode: "revoked" });

    const sync = await request(listening)
      .post("/api/analytics/v1/internal/consent/sync")
      .set("x-rudder-telemetry-consent-sync-secret", "identity-ledger-hook")
      .send({ installationId, consentVersion: "v1", consentEpoch: 1, revoked: false });
    expect(sync.status).toBe(200);

    const afterSync = await request(listening).post("/api/analytics/v1/events:batch").send({ events: [event()] });
    expect(afterSync.body.accepted).toBe(1);
  });

  it("supports an explicitly provisioned anonymous deployment credential", async () => {
    const store = new InMemoryProductAnalyticsCollectorStore();
    const collector = createProductAnalyticsCollector(store);
    const pseudonymousInstallationId = "a".repeat(64);
    const server = express();
    server.use(express.json());
    server.use(productAnalyticsCollectorRoutes(collector, () => ({
      installationId,
      mode: "anonymous",
      consentVersion: "v1",
      consentEpoch: 3,
      pseudonymousInstallationId,
    }), { anonymousAuthorization: "deployment-secret" }));
    const listening = await startApp(server);

    const unauthorized = await request(listening)
      .post("/api/analytics/v1/internal/anonymous/consent")
      .set("x-rudder-telemetry-anonymous-authorization", "wrong")
      .send({ installationId, pseudonymousInstallationId, consentVersion: "v1", consentEpoch: 3, revoked: false });
    expect(unauthorized.status).toBe(401);

    const registered = await request(listening)
      .post("/api/analytics/v1/internal/anonymous/consent")
      .set("x-rudder-telemetry-anonymous-authorization", "deployment-secret")
      .send({ installationId, pseudonymousInstallationId, consentVersion: "v1", consentEpoch: 3, revoked: false });
    expect(registered.status).toBe(200);
    expect(registered.body).toMatchObject({ installationId, pseudonymousInstallationId, consentEpoch: 3, revoked: false });

    const accepted = await request(listening)
      .post("/api/analytics/v1/events:batch")
      .set("authorization", "Bearer deployment-secret")
      .set("x-rudder-installation-id", installationId)
      .set("x-rudder-telemetry-consent-version", "v1")
      .set("x-rudder-telemetry-consent-epoch", "3")
      .set("x-rudder-telemetry-pseudonymous-installation-id", pseudonymousInstallationId)
      .send({ events: [{ ...event(), pseudonymousInstallationId }] });
    expect(accepted.body.accepted).toBe(1);
  });

  it("rejects consent synchronization without the private Identity hook secret", async () => {
    const { server } = await app();
    const response = await request(server).post("/api/analytics/v1/internal/consent/sync").send({
      installationId,
      consentVersion: "v1",
      consentEpoch: 2,
      revoked: false,
    });
    expect(response.status).toBe(401);
  });

  it("rejects an empty account-linked subject instead of falling back to installation state", async () => {
    const { server } = await app();
    const response = await request(server)
      .post("/api/analytics/v1/internal/consent/sync")
      .set("x-rudder-telemetry-consent-sync-secret", "identity-ledger-hook")
      .send({ installationId, analyticsSubject: "", consentVersion: "v1", consentEpoch: 2, revoked: false });
    expect(response.status).toBe(422);
  });

  it("rejects a non-string account-linked subject instead of falling back to installation state", async () => {
    const { server } = await app();
    const response = await request(server)
      .post("/api/analytics/v1/internal/consent/sync")
      .set("x-rudder-telemetry-consent-sync-secret", "identity-ledger-hook")
      .send({ installationId, analyticsSubject: 42, consentVersion: "v1", consentEpoch: 2, revoked: false });
    expect(response.status).toBe(422);
  });

  it("rejects an invalid subject on the revoke hook too", async () => {
    const store = new InMemoryProductAnalyticsCollectorStore();
    const collector = createProductAnalyticsCollector(store);
    const server = express();
    server.use(express.json());
    server.use(productAnalyticsCollectorRoutes(collector, () => ({
      installationId,
      mode: "anonymous",
      consentVersion: "v1",
      consentEpoch: 1,
    }), { revokeSecret: "revoke-secret" }));
    const listening = await startApp(server);

    const response = await request(listening)
      .post("/api/analytics/v1/internal/consent/revoke")
      .set("x-rudder-telemetry-revoke-secret", "revoke-secret")
      .send({ installationId, analyticsSubject: " ", consentVersion: "v1", consentEpoch: 2 });
    expect(response.status).toBe(422);
  });

  it("returns idempotent batch acknowledgements without exposing request logging", async () => {
    const { server, store } = await app();
    const payload = event();
    const first = await request(server).post("/api/analytics/v1/events:batch").send({ events: [payload] });
    const duplicate = await request(server).post("/api/analytics/v1/events:batch").send({ events: [payload] });

    expect(first.status).toBe(200);
    expect(first.body.accepted).toBe(1);
    expect(duplicate.body.duplicate).toBe(1);
    expect(store.listEvents()).toHaveLength(1);
  });

  it("rejects a missing event batch with a schema error", async () => {
    const { server } = await app();
    const response = await request(server).post("/api/analytics/v1/events:batch").send({});
    expect(response.status).toBe(422);
    expect(response.body.rejected[0]).toMatchObject({ errorCode: "invalid_schema" });
  });

  it("returns conflict for a reused event id with a different payload", async () => {
    const { server } = await app();
    const first = event();
    await request(server).post("/api/analytics/v1/events:batch").send({ events: [first] });
    const response = await request(server).post("/api/analytics/v1/events:batch").send({ events: [{ ...first, properties: { work_surface: "issue" } }] });
    expect(response.status).toBe(409);
    expect(response.body.rejected[0]).toMatchObject({ errorCode: "conflict" });
  });
});
