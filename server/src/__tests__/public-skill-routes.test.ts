import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { accessRoutes } from "../routes/access.js";

const activeServers = new Set<Server>();

async function createApp() {
  const app = express();
  app.use("/api", accessRoutes({} as never, {
    deploymentMode: "local_trusted",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use(errorHandler);
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

describe("public skill bootstrap routes", () => {
  it("advertises only the canonical Rudder Docs identity", async () => {
    const response = await request(await createApp()).get("/api/skills/index");

    expect(response.status).toBe(200);
    expect(response.body.skills).toContainEqual({
      name: "rudder-docs",
      path: "/api/skills/rudder-docs",
    });
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ name: "rudder" }));
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ path: "/api/skills/rudder" }));
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ name: "rudder-create-agent" }));
    expect(response.body.skills).not.toContainEqual(expect.objectContaining({ name: "rudder-create-plugin" }));
  });

  it("serves the canonical body from both canonical and compatibility routes", async () => {
    const app = await createApp();
    const canonical = await request(app).get("/api/skills/rudder-docs");
    const legacy = await request(app).get("/api/skills/rudder");

    expect(canonical.status).toBe(200);
    expect(canonical.type).toMatch(/text\/markdown/);
    expect(canonical.text).toMatch(/^---\nname: rudder-docs\n/);
    expect(legacy.status).toBe(200);
    expect(legacy.text).toBe(canonical.text);
  });

  it("hard-deletes both retired creation skill download routes", async () => {
    const app = await createApp();

    for (const retiredSlug of ["rudder-create-agent", "rudder-create-plugin"]) {
      const response = await request(app).get(`/api/skills/${retiredSlug}`);
      expect(response.status, retiredSlug).toBe(404);
    }
  });
});
