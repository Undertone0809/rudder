import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { privateHostnameGuard } from "../middleware/private-hostname-guard.js";

const activeServers = new Set<Server>();

async function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
  const app = express();
  app.use(
    privateHostnameGuard({
      enabled: opts.enabled,
      allowedHostnames: opts.allowedHostnames ?? [],
      bindHost: opts.bindHost ?? "0.0.0.0",
    }),
  );
  app.get("/api/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/dashboard", (_req, res) => {
    res.status(200).send("ok");
  });
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("privateHostnameGuard", () => {
  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("allows requests when disabled", async () => {
    const app = await createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = await createApp({ enabled: true });
    const res = await request(app).get("/api/health").set("Host", "localhost:3100");
    expect(res.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("please run pnpm rudder allowed-hostname dotta-macbook-pro");
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = await createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/dashboard").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.text).toContain("please run pnpm rudder allowed-hostname dotta-macbook-pro");
  }, 20_000);
});
