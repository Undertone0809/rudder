import type { Db } from "@rudderhq/db";
import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { parseProductAnalyticsCollectorConfig } from "../product-analytics-collector-config.js";
import { createProductAnalyticsCollectorApp } from "../product-analytics-collector-server.js";
import { createProductAnalyticsAssertionAuthorizer } from "../routes/product-analytics-collector.js";

const activeServers = new Set<Server>();

async function startApp(app: express.Express) {
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

afterEach(async () => {
  await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

const baseEnv = {
  RUDDER_TELEMETRY_COLLECTOR_DATABASE_URL: "postgres://collector:secret@localhost/analytics",
  RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_URL: "postgres://rollup:secret@localhost/analytics",
  RUDDER_TELEMETRY_COLLECTOR_REPORT_DATABASE_URL: "postgres://reader:secret@localhost/analytics",
  RUDDER_TELEMETRY_COLLECTOR_IDENTITY_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----",
  RUDDER_TELEMETRY_COLLECTOR_IDENTITY_ISSUER: "https://identity.example.test",
  RUDDER_TELEMETRY_COLLECTOR_IDENTITY_KEY_ID: "telemetry-key-1",
} as NodeJS.ProcessEnv;

describe("product analytics collector deployment", () => {
  it("fails closed when central database or identity settings are absent", () => {
    expect(() => parseProductAnalyticsCollectorConfig({})).toThrow("missing_rudder_telemetry_collector_database_url");
    expect(() => parseProductAnalyticsCollectorConfig({ ...baseEnv, RUDDER_TELEMETRY_COLLECTOR_IDENTITY_KEY_ID: "" })).toThrow("missing_rudder_telemetry_collector_identity_key_id");
  });

  it("parses bounded defaults and rejects a public schema override", () => {
    const config = parseProductAnalyticsCollectorConfig(baseEnv);
    expect(config).toMatchObject({ host: "127.0.0.1", port: 4318, schema: "rudder_analytics", retentionDays: 90, privacyThreshold: 10 });
    expect(() => parseProductAnalyticsCollectorConfig({ ...baseEnv, RUDDER_TELEMETRY_COLLECTOR_SCHEMA: "public" })).toThrow("invalid_rudder_telemetry_collector_schema");
  });

  it("keeps the consent synchronization secret separate from report/revoke secrets", () => {
    const config = parseProductAnalyticsCollectorConfig({
      ...baseEnv,
      RUDDER_TELEMETRY_COLLECTOR_ANONYMOUS_AUTHORIZATION: "anonymous-deployment-secret",
      RUDDER_TELEMETRY_COLLECTOR_CONSENT_SYNC_SECRET: "identity-ledger-hook",
    });
    expect(config.anonymousAuthorization).toBe("anonymous-deployment-secret");
    expect(config.consentSyncSecret).toBe("identity-ledger-hook");
  });

  it("exposes a liveness endpoint without touching the database", async () => {
    const app = await startApp(createProductAnalyticsCollectorApp({ config: parseProductAnalyticsCollectorConfig(baseEnv), db: {} as Db, reportDb: {} as Db, maintenance: false }));
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: "product-analytics-collector", schema: "rudder_analytics" });
  });

  it("binds anonymous deployment authorization to explicit consent headers", async () => {
    const authorize = createProductAnalyticsAssertionAuthorizer({
      identityPublicKey: "unused-for-anonymous",
      expectedKeyId: "unused",
      expectedIssuer: "unused",
      anonymousAuthorization: "anonymous-deployment-secret",
    });
    const app = express();
    app.get("/authorize", (req, res) => {
      try {
        res.json(authorize(req));
      } catch {
        res.status(401).json({ errorCode: "unauthorized" });
      }
    });
    const server = await startApp(app);
    const installationId = "11111111-1111-4111-8111-111111111111";
    const pseudonymousInstallationId = "a".repeat(64);
    const accepted = await request(server)
      .get("/authorize")
      .set("authorization", "Bearer anonymous-deployment-secret")
      .set("x-rudder-installation-id", installationId)
      .set("x-rudder-telemetry-consent-version", "v1")
      .set("x-rudder-telemetry-consent-epoch", "2")
      .set("x-rudder-telemetry-pseudonymous-installation-id", pseudonymousInstallationId);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ installationId, mode: "anonymous", consentVersion: "v1", consentEpoch: 2, pseudonymousInstallationId });

    const missingHeaders = await request(server)
      .get("/authorize")
      .set("authorization", "Bearer anonymous-deployment-secret")
      .set("x-rudder-installation-id", installationId);
    expect(missingHeaders.status).toBe(401);
  });
});
