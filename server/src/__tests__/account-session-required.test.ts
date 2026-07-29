import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { accountSessionRequired } from "../middleware/account-session-required.js";

function app(actor: Express.Request["actor"]) {
  const server = express();
  server.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  server.use(accountSessionRequired("required"));
  server.all("*path", (_req, res) => res.json({ ok: true }));
  return server;
}

describe("required Rudder Account session gate", () => {
  it("denies anonymous HTTP APIs but keeps health and local exchange reachable", async () => {
    const anonymous = app({ type: "none", source: "none" });
    expect((await request(anonymous).get("/api/orgs")).status).toBe(401);
    expect((await request(anonymous).get("/api/health")).status).toBe(200);
    expect((await request(anonymous).post("/api/auth/local-exchange")).status).toBe(200);
    expect((await request(anonymous).post("/api/auth/local-offline")).status).toBe(200);
  });

  it("preserves board sessions and agent bearer actors", async () => {
    expect((await request(app({
      type: "board",
      userId: "user-1",
      source: "session",
    })).get("/api/orgs")).status).toBe(200);
    expect((await request(app({
      type: "agent",
      agentId: "agent-1",
      orgId: "org-1",
      source: "agent_key",
    })).get("/api/orgs")).status).toBe(200);
  });
});
