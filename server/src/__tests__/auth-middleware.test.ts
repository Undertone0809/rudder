import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@rudderhq/db";
import { actorMiddleware } from "../middleware/auth.js";

function createLocalTrustedApp() {
  const app = express();
  app.use(actorMiddleware({} as Db, { deploymentMode: "local_trusted" }));
  app.post("/mutate", (_req, res) => res.json({ ok: true }));
  app.get("/read", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("actorMiddleware agent context guard", () => {
  it("rejects unauthenticated mutating requests that carry an agent CLI context", async () => {
    const res = await request(createLocalTrustedApp())
      .post("/mutate")
      .set("x-rudder-agent-id", "agent-123")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      code: "agent_auth_required",
      details: {
        expectedAgentId: "agent-123",
        actorType: "board",
        actorSource: "local_implicit",
      },
    });
  });

  it("allows read requests that carry no mutating agent context", async () => {
    const res = await request(createLocalTrustedApp())
      .get("/read")
      .set("x-rudder-agent-id", "agent-123");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
