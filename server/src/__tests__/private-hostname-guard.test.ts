import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { isSameOriginHost, privateHostnameGuard } from "../middleware/private-hostname-guard.js";

function createApp(opts: { enabled: boolean; allowedHostnames?: string[]; bindHost?: string }) {
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
  return app;
}

describe("privateHostnameGuard", () => {
  it("accepts only matching HTTP(S) websocket origins", () => {
    expect(isSameOriginHost("http://localhost:3100", "localhost:3100")).toBe(true);
    expect(isSameOriginHost("https://rudder.example", "rudder.example")).toBe(true);
    expect(isSameOriginHost("https://attacker.example", "localhost:3100")).toBe(false);
    expect(isSameOriginHost("null", "localhost:3100")).toBe(false);
    expect(isSameOriginHost(undefined, "localhost:3100")).toBe(false);
  });

  it("allows requests when disabled", async () => {
    const app = createApp({ enabled: false });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("allows loopback hostnames", async () => {
    const app = createApp({ enabled: true });
    const [localhost, ipv6] = await Promise.all([
      request(app).get("/api/health").set("Host", "localhost:3100"),
      request(app).get("/api/health").set("Host", "[::1]:3100"),
    ]);
    expect(localhost.status).toBe(200);
    expect(ipv6.status).toBe(200);
  });

  it("allows explicitly configured hostnames", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["dotta-macbook-pro"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(200);
  });

  it("blocks unknown hostnames with remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/api/health").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.body?.error).toContain("please run pnpm rudder allowed-hostname dotta-macbook-pro");
  });

  it("does not trust a spoofed X-Forwarded-Host header", async () => {
    const app = createApp({ enabled: true });
    const res = await request(app)
      .get("/api/health")
      .set("Host", "attacker.example:3100")
      .set("X-Forwarded-Host", "localhost:3100");

    expect(res.status).toBe(403);
  });

  it("blocks unknown hostnames on page routes with plain-text remediation command", async () => {
    const app = createApp({ enabled: true, allowedHostnames: ["some-other-host"] });
    const res = await request(app).get("/dashboard").set("Host", "dotta-macbook-pro:3100");
    expect(res.status).toBe(403);
    expect(res.text).toContain("please run pnpm rudder allowed-hostname dotta-macbook-pro");
  }, 20_000);
});
