import express, { type Request } from "express";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import {
  PUBLIC_INGRESS_AUTH_ENDPOINT,
  publicIngressAuthRoutes,
} from "../routes/public-ingress-auth.js";
import { createRustActorEnvelope } from "../services/rust-foundation-bridge.js";

const organizationId = "22222222-2222-4222-8222-222222222222";
const otherOrganizationId = "99999999-9999-4999-8999-999999999999";
const ingressAuthKey = "ingress-auth-test-key-0123456789abcdef";
const actorEnvelopeKey = "actor-envelope-test-key-0123456789abcd";
const requestId = "11111111-1111-4111-8111-111111111111";
const nonce = "33333333-3333-4333-8333-333333333333";
const memberPath = `/api/orgs/${organizationId}/members/directory`;

const localBoardActor: Request["actor"] = {
  type: "board",
  source: "local_implicit",
  userId: "local-board",
  sessionId: "local-implicit",
  authEpoch: 1,
};
const scopedUserActor: Request["actor"] = {
  type: "board",
  source: "session",
  userId: "user-1",
  orgIds: [organizationId],
  sessionId: "session-1",
  authEpoch: 2,
};
const sameOrganizationAgent: Request["actor"] = {
  type: "agent",
  source: "agent_key",
  orgId: organizationId,
  agentId: "agent-1",
  sessionId: "agent-key:key-1",
  authEpoch: 3,
};

const activeServers = new Set<Server>();

async function createApp(options: {
  actor?: Request["actor"] | null;
  remoteAddress?: string;
} = {}) {
  const app = express();
  app.use(express.json({
    limit: "32kb",
    verify: (req, _res, body) => {
      (req as Request).rawBody = Buffer.from(body);
    },
  }));
  app.use((req, _res, next) => {
    if (options.actor) req.actor = options.actor;
    if (options.remoteAddress) {
      Object.defineProperty(req.socket, "remoteAddress", {
        configurable: true,
        value: options.remoteAddress,
      });
    }
    next();
  });
  app.use("/api", publicIngressAuthRoutes({
    internalIngressAuthKey: ingressAuthKey,
    actorEnvelopeKey,
  }));
  app.use(errorHandler);

  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

function authorizationBody(overrides: Record<string, unknown> = {}) {
  return {
    organizationId,
    publicPath: memberPath,
    requestId,
    nonce,
    ...overrides,
  };
}

function postAuthorization(
  server: Server,
  body: unknown,
  key: string | null = ingressAuthKey,
) {
  let pending = request(server).post(PUBLIC_INGRESS_AUTH_ENDPOINT);
  if (key !== null) pending = pending.set("x-rudder-ingress-auth", key);
  return pending.send(body);
}

afterEach(async () => {
  await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

describe("private public-ingress auth adapter", () => {
  it.each([
    ["local board", localBoardActor],
    ["organization-scoped user", scopedUserActor],
    ["same-organization agent", sameOrganizationAgent],
  ] as Array<[string, Request["actor"]]>)("signs a fixed member-directory GET for %s", async (_label, actor) => {
    const server = await createApp({ actor });
    const response = await postAuthorization(server, authorizationBody());

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toMatchObject({
      organizationId,
      method: "GET",
      path: memberPath,
      action: "organization.members.directory.read",
      audience: "rudder-server-foundation",
      requestId,
      nonce,
      idempotencyKey: null,
      bodySha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    });
    expect(response.body.envelope).toBeUndefined();
    expect(response.body.signature).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ["none actor", { actor: { type: "none", source: "none" } as Request["actor"] }],
    ["missing actor", {}],
  ])("rejects an unauthenticated %s", async (_label, options) => {
    const server = await createApp(options);
    const response = await postAuthorization(server, authorizationBody());
    expect(response.status).toBe(401);
    expect(response.body.signature).toBeUndefined();
  });

  it.each([
    ["cross-organization agent", {
      type: "agent",
      source: "agent_key",
      orgId: otherOrganizationId,
      agentId: "agent-2",
      sessionId: "agent-key:key-2",
    } as Request["actor"]],
    ["user without organization scope", {
      type: "board",
      source: "session",
      userId: "user-2",
      orgIds: [],
      sessionId: "session-2",
    } as Request["actor"]],
  ])("denies %s", async (_label, actor) => {
    const server = await createApp({ actor });
    const response = await postAuthorization(server, authorizationBody());
    expect(response.status).toBe(403);
    expect(response.body.signature).toBeUndefined();
  });

  it("requires the independent internal key even when client cookie and bearer credentials are present", async () => {
    const server = await createApp({ actor: scopedUserActor });
    const response = await request(server)
      .post(PUBLIC_INGRESS_AUTH_ENDPOINT)
      .set("authorization", "Bearer client-agent-token")
      .set("cookie", "session=client-session")
      .set("x-rudder-ingress-auth", "wrong-internal-key")
      .send(authorizationBody());

    expect(response.status).toBe(401);
    expect(response.body.signature).toBeUndefined();
  });

  it("requires the socket peer itself to be loopback", async () => {
    const server = await createApp({ actor: localBoardActor, remoteAddress: "203.0.113.10" });
    const response = await postAuthorization(server, authorizationBody());
    expect(response.status).toBe(403);
    expect(response.body.signature).toBeUndefined();
  });

  it("binds the exact raw target with unused query data over 4 KiB into the v2 envelope", async () => {
    const server = await createApp({ actor: scopedUserActor });
    const unusedQueryValue = "x".repeat(5_000);
    const publicPath =
      `${memberPath}?type=agent&limit=25&query=R%26D+team&fullIds=1`
      + `&unused=${unusedQueryValue}&unused=again`;
    const response = await postAuthorization(server, authorizationBody({ publicPath }));
    const envelope = response.body;
    const fixedNow = envelope.expiresAt - 60;
    const signedInput = {
      actor: scopedUserActor,
      organizationId,
      method: "GET",
      path: publicPath,
      action: "organization.members.directory.read",
      body: Buffer.alloc(0),
      secret: actorEnvelopeKey,
      requestId,
      nonce,
      nowSeconds: fixedNow,
    } as const;

    expect(response.status).toBe(200);
    expect(envelope).toEqual(createRustActorEnvelope(signedInput));
    for (const changed of [
      { path: `${publicPath}&type=human` },
      { organizationId: otherOrganizationId },
      { requestId: "11111111-1111-4111-8111-111111111112" },
      { nonce: "33333333-3333-4333-8333-333333333334" },
    ]) {
      expect(createRustActorEnvelope({ ...signedInput, ...changed }).signature).not.toBe(envelope.signature);
    }
  });

  it.each([
    ["organization/path mismatch", authorizationBody({ publicPath: `/api/orgs/${otherOrganizationId}/members/directory` })],
    ["non-directory target", authorizationBody({ publicPath: `/api/orgs/${organizationId}/projects` })],
    ["raw fragment", authorizationBody({ publicPath: `${memberPath}?type=agent#fragment` })],
    ["over-8-KiB target", authorizationBody({ publicPath: `${memberPath}?query=${"x".repeat(8_193)}` })],
    ["split raw query field", authorizationBody({ rawQuery: "type=agent" })],
  ])("rejects %s without signing", async (_label, body) => {
    const server = await createApp({ actor: localBoardActor });
    const response = await postAuthorization(server, body);
    expect(response.status).toBe(400);
    expect(response.body.signature).toBeUndefined();
  });

  it("rejects body tampering and client-selected method, action, or audience", async () => {
    const server = await createApp({ actor: localBoardActor });
    for (const body of [
      authorizationBody({ body: { orgId: otherOrganizationId } }),
      authorizationBody({ method: "DELETE", action: "project.delete", audience: "other-service" }),
    ]) {
      const response = await postAuthorization(server, body);
      expect(response.status).toBe(400);
      expect(response.body.signature).toBeUndefined();
    }
  });

  it("rejects oversized request bodies before signing", async () => {
    const server = await createApp({ actor: localBoardActor });
    const response = await postAuthorization(server, authorizationBody({ padding: "x".repeat(13_000) }));
    expect(response.status).toBe(413);
    expect(response.body.signature).toBeUndefined();
  });

  it("rejects unsupported methods and endpoint paths without signing", async () => {
    const server = await createApp({ actor: localBoardActor });
    const unsupportedMethod = await request(server)
      .put(PUBLIC_INGRESS_AUTH_ENDPOINT)
      .set("x-rudder-ingress-auth", ingressAuthKey)
      .send(authorizationBody());
    const unsupportedPath = await request(server)
      .post(`${PUBLIC_INGRESS_AUTH_ENDPOINT}/other`)
      .set("x-rudder-ingress-auth", ingressAuthKey)
      .send(authorizationBody());

    expect(unsupportedMethod.status).toBe(405);
    expect(unsupportedMethod.headers.allow).toBe("POST");
    expect(unsupportedMethod.body.signature).toBeUndefined();
    expect(unsupportedPath.status).toBe(404);
    expect(unsupportedPath.body.signature).toBeUndefined();
  });

  it("requires distinct strong keys for internal auth and actor envelopes", () => {
    expect(() => publicIngressAuthRoutes({
      internalIngressAuthKey: "short",
      actorEnvelopeKey,
    })).toThrow(/between 32 and 4096 bytes/u);
    expect(() => publicIngressAuthRoutes({
      internalIngressAuthKey: ingressAuthKey,
      actorEnvelopeKey: ingressAuthKey,
    })).toThrow(/must be different/u);
  });
});
