import { agentApiKeys, agents, applyPendingMigrations, authUsers, boardApiKeys, chatConversations, createDb, ensurePostgresDatabase, organizationMemberships, organizations } from "@rudderhq/db";
import { sql } from "drizzle-orm";
import express from "express";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// Real credentials, public transport, candidate Rust and disposable PostgreSQL.
// No production profiles, provider calls, mocked bridge or DB business writer.
type Pg = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type PgConstructor = new (options: { databaseDir: string; user: string; password: string; port: number; persistent: boolean; initdbFlags: string[]; postgresFlags: string[]; onLog: () => void; onError: () => void }) => Pg;
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function buildCandidate() {
  const args = ["build", "--locked", "--manifest-path", path.join(root, "native/Cargo.toml"), "--bin", "rudder-server-foundation", "--message-format=json"];
  if (process.env.CI) args.push("--release");
  const child = spawn("cargo", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let binary = "";
  let diagnostics = "";
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const artifact = JSON.parse(line);
    if (artifact.reason === "compiler-artifact" && artifact.target?.name === "rudder-server-foundation" && artifact.executable) binary = artifact.executable;
  });
  child.stderr.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
  try {
    const [code] = await once(child, "exit");
    if (code !== 0 || !binary) throw new Error(`Native binding candidate build failed: ${diagnostics}`);
    console.info("Native binding candidate", { binary, sha256: createHash("sha256").update(fs.readFileSync(binary)).digest("hex") });
    return binary;
  } finally { lines.close(); }
}
async function freePort() {
  const listener = net.createServer().listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function closeServer(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

describe("Native binding public reads through Rust", () => {
  let db: ReturnType<typeof createDb>;
  let pg: Pg | undefined;
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let rust: ReturnType<typeof spawn> | undefined;
  let publicUrl = "";
  let binary = "";
  let databaseUrl = "";
  let upstreamCalls = 0;
  let temporary = "";
  const previousHome = process.env.RUDDER_HOME;
  const orgId = randomUUID(), foreignOrgId = randomUUID(), agentId = randomUUID(), chatId = randomUUID(), sideId = randomUUID();
  const user = `binding-owner-${randomUUID()}`, other = `binding-reader-${randomUUID()}`;
  const token = `pcp_board_${randomUUID()}`, otherToken = `pcp_board_${randomUUID()}`;
  const agentToken = `pcp_agent_${randomUUID()}`;
  const prefix = `/api/orgs/${orgId}`;
  const actor = { type: "board" as const, userId: user, source: "board_key" as const, sessionId: "native-binding-fixture", authEpoch: 1 };
  let binding: { binding: { id: string }; segment: { id: string } };
  let publicBinding: unknown;
  let sideBindingId: string;
  async function startPublic(withSessionAuth = false) {
    const address = server!.address();
    if (!address || typeof address === "string") throw new Error("Missing Node upstream");
    rust = spawn(binary, [], {
      env: {
        PATH: process.env.PATH ?? "", RUST_LOG: "error",
        RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_DATABASE_URL: databaseUrl,
        RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: "22".repeat(32),
        RUDDER_NATIVE_PUBLIC_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_NODE_UPSTREAM: `http://127.0.0.1:${address.port}`,
        RUDDER_NATIVE_INGRESS_AUTH_KEY: "11".repeat(32),
        ...(withSessionAuth ? {
          RUDDER_NATIVE_SESSION_AUTH_MODE: "required",
          RUDDER_NATIVE_SESSION_AUTH_KIND: "better_auth",
          RUDDER_NATIVE_SESSION_AUTH_SECRET: "binding-session-fixture-secret",
          RUDDER_NATIVE_SESSION_COOKIE_SECURE: "false",
          RUDDER_NATIVE_SESSION_ASSERTION_KEY: "33".repeat(32),
        } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    rust.stderr!.on("data", (chunk: Buffer) => { diagnostics = `${diagnostics}${chunk}`.slice(-4000); });
    const lines = createInterface({ input: rust.stdout! });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Rust public startup timeout: ${diagnostics}`)), 15_000);
        lines.once("line", (value) => { clearTimeout(timer); resolve(value); });
        rust!.once("exit", () => { clearTimeout(timer); reject(new Error(`Rust public exited: ${diagnostics}`)); });
        rust!.once("error", (error) => { clearTimeout(timer); reject(error); });
      });
      const startup = JSON.parse(line);
      expect(startup.publicIngress?.boundAddr).toMatch(/^127\.0\.0\.1:\d+$/);
      publicUrl = `http://${startup.publicIngress.boundAddr}`;
    } finally { lines.close(); }
  }
  async function stopPublic() {
    if (!rust || rust.exitCode !== null) return;
    const exited = once(rust, "exit");
    rust.kill("SIGTERM");
    await exited;
    rust = undefined;
  }
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ["runtime_bindings", "native_segments", "activity_log", "organization_mutation_outbox"]) {
      result[table] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY id`));
    }
    return JSON.parse(JSON.stringify(result));
  }
  async function ensure(targetId: string, profileId?: string) {
    const response = await bridge!.runtimeBinding!(actor, orgId, { operation: "ensure", target: { targetType: "chat_conversation", targetId }, identity: { agentId, profileId } });
    return { status: response.status, body: JSON.parse(response.body.toString()) };
  }
  beforeAll(async () => {
    binary = await buildCandidate();
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-native-binding-public-"));
    process.env.RUDDER_HOME = path.join(temporary, "home");
    const port = await freePort();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as PgConstructor;
    pg = new EmbeddedPostgres({ databaseDir: path.join(temporary, "pg"), user: "rudder", password: "rudder", port, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-k", ""], onLog: () => {}, onError: () => {} });
    await pg.initialise(); await pg.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
    await db.insert(organizations).values([{ id: orgId, name: "Binding", urlKey: `binding-${orgId}`, issuePrefix: "BND" }, { id: foreignOrgId, name: "Foreign", urlKey: `foreign-${foreignOrgId}`, issuePrefix: "FOR" }]);
    await db.insert(authUsers).values([user, other].map((id) => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
    await db.insert(organizationMemberships).values([user, other].map((id) => ({ orgId, principalId: id, principalType: "user", status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values([{ userId: user, name: "Owner", keyHash: createHash("sha256").update(token).digest("hex") }, { userId: other, name: "Reader", keyHash: createHash("sha256").update(otherToken).digest("hex") }]);
    await db.insert(agents).values({ id: agentId, orgId, name: "Binding Agent", role: "general", status: "idle", agentRuntimeType: "codex_local" });
    await db.insert(agentApiKeys).values({ agentId, orgId, name: "Native Agent", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(chatConversations).values([{ id: chatId, orgId, title: "Shared chat", preferredAgentId: agentId, createdByUserId: null }, { id: sideId, orgId, title: "Private side chat", preferredAgentId: agentId, createdByUserId: user, conversationKind: "side_chat", sideChatState: "active", sideChatExpiresAt: new Date(Date.now() + 60_000) }]);
    bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off" });
    const created = await ensure(chatId);
    expect(created.status).toBe(200); binding = created.body;
    const sideBinding = await ensure(sideId);
    expect(sideBinding.status).toBe(200);
    sideBindingId = sideBinding.body.binding.id;
    const fixture = await db.execute(sql`SELECT conversation_kind, created_by_user_id FROM chat_conversations WHERE id=${sideId}::uuid`);
    expect(fixture[0]).toMatchObject({ conversation_kind: "side_chat", created_by_user_id: user });
    // Deliberately non-null private locators and future provider fields must not leak.
    await db.execute(sql`UPDATE native_segments SET native_session_id='  synthetic-private-native-id  ', root_session_id='synthetic-private-root', leaf_id='synthetic-private-leaf', source_boundary_ref='synthetic-private-boundary', provider_state_json='{"credential":"synthetic-secret-value"}'::jsonb WHERE id=${binding.segment.id}::uuid`);
    binding = (await ensure(chatId)).body;
    const projected = await bridge.runtimeBinding!(actor, orgId, { operation: "public_current", target: { targetType: "chat_conversation", targetId: chatId } });
    expect(projected.status).toBe(200);
    publicBinding = JSON.parse(projected.body.toString());
    const application = express();
    application.use((_req, res) => { upstreamCalls += 1; res.status(418).json({ error: "Unexpected Node fallback" }); });
    server = application.listen(0, "127.0.0.1");
    await once(server, "listening");
    await startPublic();
  }, 120_000);
  afterAll(async () => {
    try { await stopPublic(); await closeServer(server); await bridge?.close(); await db?.$client.end({ timeout: 5 }); await pg?.stop(); }
    finally {
      if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
      if (previousHome === undefined) delete process.env.RUDDER_HOME; else process.env.RUDDER_HOME = previousHome;
    }
  }, 30_000);
  it("reads one durable identity for both org members, including null creator, without business-state writes", async () => {
    const before = await snapshot();
    for (const credential of [token, otherToken, agentToken]) {
      const current = await request(publicUrl).get(`${prefix}/chats/${chatId}/runtime-binding`).auth(credential, { type: "bearer" });
      expect(current.status).toBe(200); expect(current.body).toEqual(publicBinding);
      const historical = await request(publicUrl).get(`${prefix}/runtime-bindings/${binding.binding.id}`).auth(credential, { type: "bearer" });
      expect(historical.status).toBe(200); expect(historical.body).toEqual(publicBinding);
    }
    const serialized = JSON.stringify(publicBinding);
    for (const field of ["nativeSessionId", "rootSessionId", "leafId", "sourceBoundaryRef", "providerState", "principalScopeRef", "hostId", "profileId", "workspaceBindingId", "instructionsRevision", "capabilityRevision", "synthetic-private", "synthetic-secret"]) expect(serialized).not.toContain(field);
    expect(await snapshot()).toEqual(before);
  });
  it("denies anonymous, foreign organization and Side Chat non-owner reads", async () => {
    const before = await snapshot();
    expect((await request(publicUrl).get(`${prefix}/chats/${chatId}/runtime-binding`)).status).toBe(401);
    expect((await request(publicUrl).get(`/api/orgs/${foreignOrgId}/runtime-bindings/${binding.binding.id}`).auth(token, { type: "bearer" })).status).toBe(403);
    expect((await request(publicUrl).get(`${prefix}/chats/${sideId}/runtime-binding`).auth(otherToken, { type: "bearer" })).status).toBe(404);
    expect((await request(publicUrl).get(`${prefix}/runtime-bindings/${sideBindingId}`).auth(otherToken, { type: "bearer" })).status).toBe(404);
    expect((await request(publicUrl).get(`${prefix}/chats/${sideId}/runtime-binding`).auth(token, { type: "bearer" })).status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });
  it("revalidates credential revocation and Agent scope on every public read", async () => {
    const before = await snapshot();
    expect((await request(publicUrl).get(`${prefix}/chats/${sideId}/runtime-binding`).auth(agentToken, { type: "bearer" })).status).toBe(403);
    expect((await request(publicUrl).get(`/api/orgs/${foreignOrgId}/runtime-bindings/${binding.binding.id}`).auth(agentToken, { type: "bearer" })).status).toBe(403);
    await db.execute(sql`UPDATE board_api_keys SET revoked_at=now() WHERE user_id=${other}`);
    expect((await request(publicUrl).get(`${prefix}/chats/${chatId}/runtime-binding`).auth(otherToken, { type: "bearer" })).status).toBe(401);
    await db.execute(sql`UPDATE board_api_keys SET revoked_at=NULL, expires_at=now()-interval '1 second' WHERE user_id=${other}`);
    expect((await request(publicUrl).get(`${prefix}/runtime-bindings/${binding.binding.id}`).auth(otherToken, { type: "bearer" })).status).toBe(401);
    await db.execute(sql`UPDATE board_api_keys SET expires_at=NULL WHERE user_id=${other}`);
    expect(await snapshot()).toEqual(before);
    expect(upstreamCalls).toBe(0);
  });
  it("keeps identity on duplicate/conflicting creation and Rust process restart", async () => {
    const before = await snapshot();
    expect(await ensure(chatId)).toEqual({ status: 200, body: binding });
    expect((await ensure(chatId, "different-profile")).status).toBe(409);
    await bridge!.close();
    await stopPublic();
    await startPublic();
    const response = await request(publicUrl).get(`${prefix}/chats/${chatId}/runtime-binding`).auth(token, { type: "bearer" });
    expect(response.status).toBe(200); expect(response.body).toEqual(publicBinding);
    expect(await snapshot()).toEqual(before);
  });
  it("rejects unsupported credentials, wrong methods and namespace variants without Node fallback", async () => {
    const url = `${prefix}/chats/${chatId}/runtime-binding`;
    expect((await request(publicUrl).get(url).set("Cookie", "session=untrusted")).status).toBe(401);
    expect((await request(publicUrl).get(url).auth("local-jwt", { type: "bearer" })).status).toBe(401);
    expect((await request(publicUrl).get(url).auth(token, { type: "bearer" }).set("x-rudder-actor-envelope", "forged")).status).toBe(200);
    expect((await request(publicUrl).get(url).query({ bindingId: binding.binding.id }).auth(token, { type: "bearer" })).status).toBe(400);
    expect((await request(publicUrl).post(url).auth(token, { type: "bearer" })).status).toBe(404);
    for (const suffix of ["runtime-binding/", "RUNTIME-BINDING", "%72untime-binding", "runtime-binding/extra"]) {
      const response = await request(publicUrl).get(`${prefix}/chats/${chatId}/${suffix}`).auth(token, { type: "bearer" });
      expect(response.status).toBe(404);
    }
    for (const variant of [
      `/api//orgs/${orgId}/runtime-bindings/${binding.binding.id}`,
      `/api/orgs/${orgId}//runtime-bindings/${binding.binding.id}`,
      `/api/orgs/${orgId}/chats//${chatId}/runtime-binding`,
    ]) {
      expect((await request(publicUrl).get(variant).auth(token, { type: "bearer" })).status).toBe(404);
    }
    expect(upstreamCalls).toBe(0);
  });
  it("keeps native Bearer authority when session authentication is also enabled", async () => {
    await stopPublic();
    await startPublic(true);
    try {
      for (const url of [
        `${prefix}/chats/${chatId}/runtime-binding`,
        `${prefix}/runtime-bindings/${binding.binding.id}`,
      ]) {
        expect((await request(publicUrl).get(url).auth(token, { type: "bearer" })).status).toBe(200);
        expect((await request(publicUrl).get(url)
          .set("Cookie", "better-auth.session_token=untrusted")).status).toBe(401);
      }
      expect(upstreamCalls).toBe(0);
    } finally {
      await stopPublic();
      await startPublic();
    }
  });
  it("returns 503 when the database is unavailable without forwarding to live Node", async () => {
    const before = await snapshot();
    await pg!.stop();
    try {
      const response = await request(publicUrl).get(`${prefix}/chats/${chatId}/runtime-binding`).auth(token, { type: "bearer" });
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ error: "runtime_binding_authority_unavailable" });
      expect(upstreamCalls).toBe(0);
    } finally { await pg!.start(); }
    expect(await snapshot()).toEqual(before);
  }, 45_000);
});
