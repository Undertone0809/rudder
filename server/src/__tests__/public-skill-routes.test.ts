import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";

function createApp() {
  const app = express();
  app.use("/api", accessRoutes({} as never, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
  return app;
}

describe("public skill bootstrap routes", () => {
  it("advertises only the canonical Rudder Docs identity", async () => {
    const response = await request(createApp()).get("/api/skills/index");

    expect(response.status).toBe(200);
    expect(response.body.skills).toContainEqual({
      name: "rudder-docs",
      path: "/api/skills/rudder-docs",
    });
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ name: "rudder" }));
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ path: "/api/skills/rudder" }));
  });

  it("serves the canonical body from both canonical and compatibility routes", async () => {
    const app = createApp();
    const canonical = await request(app).get("/api/skills/rudder-docs");
    const legacy = await request(app).get("/api/skills/rudder");

    expect(canonical.status).toBe(200);
    expect(canonical.type).toMatch(/text\/markdown/);
    expect(canonical.text).toMatch(/^---\nname: rudder-docs\n/);
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(canonical.text);
  });
});
