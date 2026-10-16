import type { Db } from "@rudderhq/db";
import { authUsers, boardApiKeys, instanceUserRoles, organizationMemberships } from "@rudderhq/db";
import express, { type Request } from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NativeSessionAssertionNonceRegistry,
  getVerifiedNativeSessionAssertion,
  nativeSessionAssertionMiddleware,
  signNativeSessionAssertion,
} from "../auth/native-session-assertion.js";
import { actorMiddleware } from "../middleware/auth.js";

const KEY = "0123456789abcdef0123456789abcdef";
const SESSION_ID = "better-auth-session-1";
const USER_ID = "session-user-1";
const BOARD_USER_ID = "native-board-user-1";

function createLookupDb() {
  const selectedTables: unknown[] = [];
  const db = {
    select() {
      let table: unknown;
      const query = {
        from(selected: unknown) {
          table = selected;
          selectedTables.push(selected);
          return query;
        },
        where() {
          if (table === instanceUserRoles) return Promise.resolve([{ id: "admin-role" }]);
          if (table === organizationMemberships) return Promise.resolve([{ orgId: "org-current" }]);
          throw new Error("unexpected authority query");
        },
      };
      return query;
    },
  };
  return { db: db as unknown as Db, selectedTables };
}

function createBoardKeyLookupDb() {
  const selectedTables: unknown[] = [];
  const state = {
    userExists: true,
    isInstanceAdmin: true,
    orgIds: ["org-before-revocation"],
  };
  let legacyCredentialLookups = 0;
  let keyTouches = 0;
  const db = {
    select() {
      let table: unknown;
      const query = {
        from(selected: unknown) {
          table = selected;
          selectedTables.push(selected);
          return query;
        },
        where() {
          if (table === authUsers) {
            return Promise.resolve(state.userExists
              ? [{ id: BOARD_USER_ID, name: "Board operator", email: "board@example.test" }]
              : []);
          }
          if (table === organizationMemberships) {
            return Promise.resolve(state.orgIds.map((orgId) => ({ orgId })));
          }
          if (table === instanceUserRoles) {
            return Promise.resolve(state.isInstanceAdmin ? [{ id: "native-admin-role" }] : []);
          }
          if (table === boardApiKeys) {
            legacyCredentialLookups += 1;
            return Promise.resolve([]);
          }
          throw new Error("unexpected native board-key authority query");
        },
      };
      return query;
    },
    update() {
      keyTouches += 1;
      return { set: () => ({ where: async () => [] }) };
    },
  };
  return {
    db: db as unknown as Db,
    selectedTables,
    state,
    get legacyCredentialLookups() { return legacyCredentialLookups; },
    get keyTouches() { return keyTouches; },
  };
}

async function listen(app: express.Express): Promise<{ server: Server; origin: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback HTTP listener");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function sendJson(
  origin: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string; proofHeader: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, {
      method: options.method ?? "POST",
      headers: { "content-type": "application/json", connection: "close", ...options.headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        body,
        proofHeader: res.headers["x-test-proof-header"] as string | undefined,
      }));
    });
    req.once("error", reject);
    req.end(options.body ?? "{}");
  });
}

function protectedApp(
  key = KEY,
  nowSeconds: () => number = () => 1_000,
  maxNonces?: number,
) {
  const resolver = vi.fn(async () => null);
  const { db, selectedTables } = createLookupDb();
  const app = express();
  app.use(nativeSessionAssertionMiddleware({ key, nowSeconds, maxNonces }));
  app.use(express.json());
  app.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    authRequirement: "required",
    resolveSession: resolver,
  }));
  app.post("/protected", (req, res) => {
    res.setHeader("x-test-proof-header", req.header("x-rudder-native-session-proof") ?? "removed");
    res.json({
      actor: req.actor,
      body: req.body,
      assertion: getVerifiedNativeSessionAssertion(req),
    });
  });
  return { app, resolver, selectedTables };
}

function proof(target = "/protected?view=current", overrides: Partial<Parameters<typeof signNativeSessionAssertion>[0]> = {}) {
  return signNativeSessionAssertion({
    key: KEY,
    method: "POST",
    target,
    identity: { kind: "session", session_id: SESSION_ID, user_id: USER_ID },
    nowSeconds: 1_000,
    ...overrides,
  });
}

function anonymousProof(nowSeconds: number, nonce: string) {
  return signNativeSessionAssertion({
    key: KEY,
    method: "POST",
    target: "/protected?view=current",
    identity: { kind: "none" },
    nowSeconds,
    requestId: `00000000-0000-4000-8000-${nonce.slice(-12)}`,
    nonce,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("native public-ingress session assertion", () => {
  it("builds the existing Board session actor and never calls the Node cookie resolver", async () => {
    const { app, resolver, selectedTables } = protectedApp();
    const listener = await listen(app);
    try {
      const response = await sendJson(listener.origin, "/protected?view=current", {
        headers: { "x-rudder-native-session-proof": proof() },
        body: JSON.stringify({ action: "read" }),
      });
      expect(response.status).toBe(200);
      expect(response.proofHeader).toBe("removed");
      const payload = JSON.parse(response.body) as {
        actor: Request["actor"];
        body: { action: string };
        assertion: { kind: string; session_id: string; user_id: string };
      };
      expect(payload.actor).toMatchObject({
        type: "board",
        source: "session",
        userId: USER_ID,
        sessionId: SESSION_ID,
        orgIds: ["org-current"],
        isInstanceAdmin: true,
      });
      expect(payload.body).toEqual({ action: "read" });
      expect(payload.assertion).toEqual({ kind: "session", session_id: SESSION_ID, user_id: USER_ID });
      expect(resolver).not.toHaveBeenCalled();
      expect(selectedTables).toEqual([instanceUserRoles, organizationMemberships]);
    } finally {
      await close(listener.server);
    }
  });

  it("uses the native Agent JWT identity for Bearer requests without resolving Node auth", async () => {
    const { app, resolver, selectedTables } = protectedApp();
    const listener = await listen(app);
    const agentProof = signNativeSessionAssertion({
      key: KEY,
      method: "POST",
      target: "/protected?view=current",
      identity: {
        kind: "agent_jwt",
        adapter_type: "codex_local",
        agent_id: "agent-native-1",
        expires_at: 2_000,
        org_id: "org-native-1",
        run_id: "run-native-1",
        session_id: "agent-jwt:agent-native-1",
      },
      nowSeconds: 1_000,
    });
    try {
      const response = await sendJson(listener.origin, "/protected?view=current", {
        headers: {
          authorization: "Bearer valid-legacy-agent-jwt",
          "x-rudder-native-session-proof": agentProof,
          // Rust has already compared this public header with the signed JWT.
          // The private actor mapper must consume that identity without making
          // a second run-context decision.
          "x-rudder-run-id": "run-mismatch-checked-at-rust",
        },
      });
      expect(response.status).toBe(200);
      const payload = JSON.parse(response.body) as { actor: Request["actor"] };
      expect(payload.actor).toMatchObject({
        type: "agent",
        source: "agent_jwt",
        agentId: "agent-native-1",
        orgId: "org-native-1",
        runId: "run-native-1",
        adapterType: "codex_local",
        sessionId: "agent-jwt:agent-native-1",
      });
      expect(resolver).not.toHaveBeenCalled();
      expect(selectedTables).toEqual([]);
    } finally {
      await close(listener.server);
    }
  });

  it("uses the shared current board-access mapping for native keys without legacy key lookup or touch", async () => {
    const lookup = createBoardKeyLookupDb();
    const resolver = vi.fn(async () => null);
    const app = express();
    app.use(nativeSessionAssertionMiddleware({ key: KEY, nowSeconds: () => 1_000 }));
    app.use(express.json());
    app.use(actorMiddleware(lookup.db, {
      deploymentMode: "local_trusted",
      resolveSession: resolver,
    }));
    app.post("/protected", (req, res) => {
      res.setHeader("x-test-proof-header", req.header("x-rudder-native-session-proof") ?? "removed");
      res.json(req.actor);
    });
    const listener = await listen(app);
    const sendBoardProof = () => sendJson(listener.origin, "/protected", {
      headers: {
        authorization: "Bearer pcp_board_must-not-be-looked-up-in-Node",
        "x-rudder-native-session-proof": signNativeSessionAssertion({
          key: KEY,
          method: "POST",
          target: "/protected",
          identity: {
            kind: "board_key",
            key_id: "native-board-key-1",
            session_id: "board-key:native-board-key-1",
            user_id: BOARD_USER_ID,
          },
          nowSeconds: 1_000,
        }),
      },
    });

    try {
      const initial = await sendBoardProof();
      expect(initial.status).toBe(200);
      expect(initial.proofHeader).toBe("removed");
      expect(JSON.parse(initial.body)).toMatchObject({
        type: "board",
        source: "board_key",
        userId: BOARD_USER_ID,
        keyId: "native-board-key-1",
        sessionId: "board-key:native-board-key-1",
        orgIds: ["org-before-revocation"],
        isInstanceAdmin: true,
      });

      lookup.state.orgIds = ["org-after-permission-change"];
      lookup.state.isInstanceAdmin = false;
      const updatedAccess = await sendBoardProof();
      expect(updatedAccess.status).toBe(200);
      expect(JSON.parse(updatedAccess.body)).toMatchObject({
        source: "board_key",
        orgIds: ["org-after-permission-change"],
        isInstanceAdmin: false,
      });

      // A user deletion/revocation fails closed, even when local_trusted would
      // otherwise start each request with an implicit local Board actor.
      lookup.state.userExists = false;
      const revokedUser = await sendBoardProof();
      expect(revokedUser.status).toBe(200);
      expect(JSON.parse(revokedUser.body)).toMatchObject({ type: "none", source: "none" });

      expect(lookup.selectedTables).toEqual([
        authUsers, organizationMemberships, instanceUserRoles,
        authUsers, organizationMemberships, instanceUserRoles,
        authUsers, organizationMemberships, instanceUserRoles,
      ]);
      expect(lookup.legacyCredentialLookups).toBe(0);
      expect(lookup.keyTouches).toBe(0);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("maps the explicit local implicit proof to the existing loopback Board actor", async () => {
    const { app, resolver } = protectedApp();
    const listener = await listen(app);
    try {
      const localProof = signNativeSessionAssertion({
        key: KEY,
        method: "POST",
        target: "/protected?view=current",
        identity: { kind: "local_implicit" },
        nowSeconds: 1_000,
      });
      const response = await sendJson(listener.origin, "/protected?view=current", {
        headers: { "x-rudder-native-session-proof": localProof },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).actor).toMatchObject({
        type: "board",
        userId: "local-board",
        source: "local_implicit",
        sessionId: "local-implicit",
        isInstanceAdmin: true,
      });
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("rejects forged, wrong-target, wrong-method, and replayed assertions before actor resolution", async () => {
    const { app, resolver } = protectedApp();
    const listener = await listen(app);
    try {
      const valid = proof();
      const wrongTarget = await sendJson(listener.origin, "/protected?view=other", {
        headers: { "x-rudder-native-session-proof": valid },
      });
      expect(wrongTarget.status).toBe(401);

      const wrongMethod = await sendJson(listener.origin, "/protected?view=current", {
        method: "PUT",
        headers: { "x-rudder-native-session-proof": valid },
      });
      expect(wrongMethod.status).toBe(401);

      const forged = await sendJson(listener.origin, "/protected?view=current", {
        headers: { "x-rudder-native-session-proof": "forged" },
      });
      expect(forged.status).toBe(401);

      const first = await sendJson(listener.origin, "/protected?view=current", {
        headers: { "x-rudder-native-session-proof": valid },
      });
      const replay = await sendJson(listener.origin, "/protected?view=current", {
        headers: { "x-rudder-native-session-proof": valid },
      });
      expect(first.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(JSON.parse(replay.body).code).toBe("native_session_proof_replayed");
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("validates the proof before a delayed chunked JSON body is parsed", async () => {
    let now = 1_000;
    const { app, resolver } = protectedApp(KEY, () => now);
    const listener = await listen(app);
    try {
      const responsePromise = new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = httpRequest(`${listener.origin}/protected?view=current`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "transfer-encoding": "chunked",
            "x-rudder-native-session-proof": proof(),
            connection: "close",
          },
        }, (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => { body += chunk; });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.once("error", reject);
        req.write('{"delayed":');
        setTimeout(() => {
          now = 1_030;
          req.end("true}");
        }, 30);
      });
      const response = await responsePromise;
      expect(response.status).toBe(200);
      expect(JSON.parse(response.body).body).toEqual({ delayed: true });
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("bounds anonymous proof admission and reclaims entries after their expiry bucket passes", async () => {
    let now = 1_000;
    const { app, resolver } = protectedApp(KEY, () => now, 2);
    const listener = await listen(app);
    try {
      for (const nonce of [
        "10000000-0000-4000-8000-000000000001",
        "10000000-0000-4000-8000-000000000002",
      ]) {
        const accepted = await sendJson(listener.origin, "/protected?view=current", {
          headers: { "x-rudder-native-session-proof": anonymousProof(now, nonce) },
        });
        expect(accepted.status).toBe(200);
        expect(JSON.parse(accepted.body).assertion).toEqual({ kind: "none" });
      }

      const full = await sendJson(listener.origin, "/protected?view=current", {
        headers: {
          "x-rudder-native-session-proof": anonymousProof(
            now,
            "10000000-0000-4000-8000-000000000003",
          ),
        },
      });
      expect(full.status).toBe(503);
      expect(JSON.parse(full.body).code).toBe("native_session_proof_capacity");

      now = 1_030;
      const afterExpiry = await sendJson(listener.origin, "/protected?view=current", {
        headers: {
          "x-rudder-native-session-proof": anonymousProof(
            now,
            "10000000-0000-4000-8000-000000000004",
          ),
        },
      });
      expect(afterExpiry.status).toBe(200);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("bounds the production replay registry under an anonymous proof flood and expires old entries", () => {
    const registry = new NativeSessionAssertionNonceRegistry();
    for (let index = 0; index < 50_000; index += 1) {
      expect(registry.consume(`anonymous-${index}`, 1_030, 1_000)).toBe("accepted");
    }
    expect(registry.consume("anonymous-overflow", 1_030, 1_000)).toBe("capacity");
    expect(registry.consume("anonymous-after-expiry", 1_060, 1_030)).toBe("accepted");
    expect(registry.consume("anonymous-after-expiry", 1_060, 1_030)).toBe("replayed");
  });

  it("reclaims entries accepted after a backward wall-clock jump", () => {
    const registry = new NativeSessionAssertionNonceRegistry(2);

    expect(registry.consume("old", 1_030, 1_000)).toBe("accepted");
    expect(registry.consume("new-after-rollback", 930, 900)).toBe("accepted");

    // At 931 the post-rollback nonce is expired. Capacity must recover even
    // though its expiry bucket lies behind the pre-rollback sweep watermark.
    expect(registry.consume("after-expiry", 961, 931)).toBe("accepted");
    expect(registry.consume("after-expiry", 961, 931)).toBe("replayed");
  });

  it("fails a direct private-listener business request closed when the assertion is missing", async () => {
    const { app, resolver } = protectedApp();
    const listener = await listen(app);
    try {
      const response = await sendJson(listener.origin, "/protected?view=current");
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body).code).toBe("native_session_proof_required");
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });

  it("requires a native proof for Bearer identity and preserves the auth-lifecycle bridge path", async () => {
    const app = express();
    app.use(nativeSessionAssertionMiddleware({ key: KEY, nowSeconds: () => 1_000 }));
    app.get("/api/auth/sign-out", (_req, res) => res.sendStatus(204));
    app.post("/protected", (_req, res) => res.sendStatus(204));
    const listener = await listen(app);
    try {
      const lifecycle = await sendJson(listener.origin, "/api/auth/sign-out", { method: "GET" });
      expect(lifecycle.status).toBe(204);
      const bearer = await sendJson(listener.origin, "/protected", {
        headers: { authorization: "Bearer legacy-token" },
      });
      expect(bearer.status).toBe(401);
      expect(JSON.parse(bearer.body).code).toBe("native_session_proof_required");
    } finally {
      await close(listener.server);
    }
  });

  it("does not let an Upgrade header bypass proof on ordinary business GETs", async () => {
    const { app, resolver } = protectedApp();
    app.get("/protected", (_req, res) => res.sendStatus(204));
    const listener = await listen(app);
    try {
      const response = await sendJson(listener.origin, "/protected", {
        method: "GET",
        headers: { upgrade: "websocket" },
      });
      expect(response.status).toBe(401);
      expect(JSON.parse(response.body).code).toBe("native_session_proof_required");
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await close(listener.server);
    }
  });
});
