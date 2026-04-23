import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { healthRoutes } from "../routes/health.js";
import { serverVersion } from "../version.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /health", () => {
  it("returns 200 with status ok and inferred local runtime metadata", async () => {
    delete process.env.RUDDER_INSTANCE_ID;
    delete process.env.RUDDER_LOCAL_ENV;
    delete process.env.RUDDER_RUNTIME_OWNER_KIND;

    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      version: serverVersion,
      instanceId: "default",
      localEnv: "prod_local",
      runtimeOwnerKind: null,
      uiLocale: "en",
    });
  });

  it("surfaces runtime owner metadata from the process environment", async () => {
    process.env.RUDDER_INSTANCE_ID = "dev";
    process.env.RUDDER_LOCAL_ENV = "dev";
    process.env.RUDDER_RUNTIME_OWNER_KIND = "desktop";

    const app = express();
    app.use("/health", healthRoutes());

    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      version: serverVersion,
      instanceId: "dev",
      localEnv: "dev",
      runtimeOwnerKind: "desktop",
      uiLocale: "en",
    });
  });
});
