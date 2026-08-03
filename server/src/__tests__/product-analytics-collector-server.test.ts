import type { Db } from "@rudderhq/db";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseProductAnalyticsCollectorConfig } from "../product-analytics-collector-config.js";
import { createProductAnalyticsCollectorApp } from "../product-analytics-collector-server.js";

const baseEnv = {
  RUDDER_TELEMETRY_COLLECTOR_DATABASE_URL: "postgres://collector:secret@localhost/analytics",
  RUDDER_TELEMETRY_COLLECTOR_MAINTENANCE_DATABASE_URL: "postgres://rollup:secret@localhost/analytics",
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

  it("exposes a liveness endpoint without touching the database", async () => {
    const app = createProductAnalyticsCollectorApp({ config: parseProductAnalyticsCollectorConfig(baseEnv), db: {} as Db, maintenance: false });
    const response = await request(app).get("/healthz");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, service: "product-analytics-collector", schema: "rudder_analytics" });
  });
});
