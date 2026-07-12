import type { Db } from "@rudderhq/db";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { actorMiddleware } from "../middleware/auth.js";

function createLocalTrustedApp(db: Db = {} as Db) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
  app.post("/mutate", (_req, res) => res.json({ ok: true }));
  app.get("/read", (_req, res) => res.json({ ok: true }));
  app.get("/actor", (req, res) => res.json(req.actor));
  return app;
}

function createJwtAuthDb(agent: { id: string; orgId: string; status: string }) {
  const results = [[], [], [agent]];
  let index = 0;
  return {
    select: vi.fn(() => {
      const chain = {
        from: () => chain,
        where: () => chain,
        then: (resolve: (rows: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
          Promise.resolve(results[index++] ?? []).then(resolve, reject),
      };
      return chain;
    }),
  } as unknown as Db;
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

  it("rejects a run header that does not match the signed Agent JWT run", async () => {
    const token = createLocalAgentJwt("agent-1", "org-1", "codex_local", "run-a");
    expect(token).toBeTruthy();

    const res = await request(createLocalTrustedApp(createJwtAuthDb({
      id: "agent-1",
      orgId: "org-1",
      status: "active",
    })))
      .post("/mutate")
      .set("authorization", `Bearer ${token}`)
      .set("x-rudder-run-id", "run-b")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "agent_run_context_mismatch",
      details: { signedRunId: "run-a", requestedRunId: "run-b" },
    });
  });

  it.each([
    ["without a header", undefined],
    ["with a matching header", "run-a"],
  ])("derives the run from the signed Agent JWT %s", async (_label, runIdHeader) => {
    const token = createLocalAgentJwt("agent-1", "org-1", "codex_local", "run-a");
    expect(token).toBeTruthy();
    let pending = request(createLocalTrustedApp(createJwtAuthDb({
      id: "agent-1",
      orgId: "org-1",
      status: "active",
    })))
      .get("/actor")
      .set("authorization", `Bearer ${token}`);
    if (runIdHeader) pending = pending.set("x-rudder-run-id", runIdHeader);

    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      source: "agent_jwt",
      agentId: "agent-1",
      orgId: "org-1",
      runId: "run-a",
      adapterType: "codex_local",
    });
  });
});
