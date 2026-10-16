import type { Db } from "@rudderhq/db";
import { applyPendingMigrations, createDb, ensurePostgresDatabase } from "@rudderhq/db";
import express from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RudderAppHandle } from "../app.js";
import { nativeSessionAssertionMiddleware } from "../auth/native-session-assertion.js";
import { preparePublicIngressStartup } from "../bootstrap/public-ingress-startup.js";
import type { Config } from "../config.js";
import { accountSessionRequired } from "../middleware/account-session-required.js";
import { actorMiddleware } from "../middleware/auth.js";

const SESSION_SECRET = "native-session-e2e-secret";
const LOCAL_SESSION_SECRET = "desktop-local-session-e2e-secret";
const ASSERTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const INGRESS_KEY = "fedcba9876543210fedcba9876543210";
const ACTOR_KEY = "1023456789abcdef0123456789abcdef";
const AGENT_JWT_SECRET = "native-agent-jwt-e2e-secret";
const organizationUrlKey = "native-session-e2e";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type StartupReceipt = {
  boundAddr?: string;
  publicListener?: boolean;
  publicIngress?: {
    boundAddr?: string;
    publicListener?: boolean;
    directAuthorities?: string[];
    nativeAuthentication?: {
      authority?: string;
      directRoutes?: string[];
      supportedCredentialStores?: string[];
      sessionCookieAuthority?: { kind?: string; unmigrated?: string[] };
      localImplicitEnabled?: boolean;
      localImplicitConstraint?: string;
    };
  };
};

let fixtureRoot = "";
let embedded: EmbeddedPostgresInstance | null = null;
let connectionString = "";
let fixtureSql: ReturnType<typeof postgres> | null = null;
let db: Db | null = null;
let orgId = "";
let otherOrgId = "";
let userId = "";
let agentId = "";
let sessionToken = "";
let sessionId = "";
let boardKeyToken = "";
let agentKeyToken = "";
let nodeServer: Server | undefined;
let privateNodePort = 0;
let nativeChild: ChildProcess | undefined;
let nativeStdout: Interface | undefined;
let nativeStderr = "";
let publicPort = 0;
let nativeBinaryPath = "";
let sessionResolverCalls = 0;
let nodeRouteCalls = 0;
let healthStatus = 200;
let corruptHealthProof = false;

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No test port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startDisposableDatabase() {
  const external = process.env.RUDDER_NATIVE_SESSION_TEST_DATABASE_URL?.trim();
  if (external) {
    const parsed = new URL(external);
    if (!parsed.pathname.toLowerCase().includes("test")) {
      throw new Error("Session workflow tests require a database name containing 'test'");
    }
    await applyPendingMigrations(external);
    return { url: external, dir: "", instance: null as EmbeddedPostgresInstance | null };
  }

  const dir = mkdtempSync(path.join(os.tmpdir(), "rudder-native-session-workflow-"));
  const port = await availablePort();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const instance = new EmbeddedPostgres({
    databaseDir: path.join(dir, "db"),
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: (message: unknown) => {
      if (process.env.RUDDER_TEST_POSTGRES_DEBUG === "true") console.error(message);
    },
  }) as EmbeddedPostgresInstance;
  await instance.initialise();
  await instance.start();
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  const dbName = "rudder_native_session_workflow_test";
  await ensurePostgresDatabase(adminUrl, dbName);
  const url = `postgres://rudder:rudder@127.0.0.1:${port}/${dbName}`;
  await applyPendingMigrations(url);
  return { url, dir, instance };
}

function signCookieValue(value: string, secret = SESSION_SECRET): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return encodeURIComponent(`${value}.${signature}`);
}

function sessionCookie(token = sessionToken, dontRemember?: string, secret = SESSION_SECRET): string {
  const cookies = [`better-auth.session_token=${signCookieValue(token, secret)}`];
  if (dontRemember !== undefined) {
    cookies.push(`better-auth.dont_remember=${signCookieValue(dontRemember, secret)}`);
  }
  return cookies.join("; ");
}

function signAgentJwt(input: {
  agentId: string;
  orgId: string;
  runId?: string;
  adapterType?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    sub: input.agentId,
    org_id: input.orgId,
    adapter_type: input.adapterType ?? "claude_local",
    run_id: input.runId ?? "native-agent-jwt-run",
    iat: now,
    exp: now + 3_600,
    iss: "rudder",
    aud: "rudder-api",
  })}`;
  return `${signingInput}.${createHmac("sha256", AGENT_JWT_SECRET).update(signingInput).digest("base64url")}`;
}

function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function forgeAgentJwt(): string {
  const token = signAgentJwt({ agentId, orgId });
  return `${token.slice(0, token.lastIndexOf(".") + 1)}${"x".repeat(43)}`;
}

async function verifySessionTokenIndexUpgradeWithExistingRows(): Promise<void> {
  if (!embedded || !fixtureSql) return;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeUser = `native-session-migration-user-${suffix}`;
  const probeSession = `native-session-migration-id-${suffix}`;
  try {
    await fixtureSql`
      INSERT INTO "user" (id, name, email, created_at, updated_at)
      VALUES (${probeUser}, 'Migration Probe', ${`${probeUser}@invalid.test`}, now(), now())
    `;
    await fixtureSql`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${probeSession}, ${`migration-token-${suffix}`}, ${probeUser}, now() + interval '2 days', now(), now())
    `;

    const migrationPath = path.join(repositoryRoot, "packages/db/src/migrations/0179_reflective_wallow.sql");
    const migrationHash = createHash("sha256").update(readFileSync(migrationPath)).digest("hex");
    await fixtureSql`DROP INDEX public.session_token_idx`;
    const [removedHistory] = await fixtureSql`
      DELETE FROM drizzle.__drizzle_migrations WHERE hash = ${migrationHash} RETURNING id
    `;
    if (!removedHistory) throw new Error("Could not create the previous-migration-state fixture");

    await applyPendingMigrations(connectionString);
    const [index] = await fixtureSql`
      SELECT EXISTS (
        SELECT 1 FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'session_token_idx'
      ) AS exists
    `;
    const [preservedSession] = await fixtureSql`
      SELECT EXISTS (SELECT 1 FROM session WHERE id = ${probeSession}) AS exists
    `;
    if (!index.exists || !preservedSession.exists) {
      throw new Error("Session-token index upgrade did not preserve the existing session row");
    }
  } finally {
    await fixtureSql`DELETE FROM session WHERE id = ${probeSession}`;
    await fixtureSql`DELETE FROM "user" WHERE id = ${probeUser}`;
  }
}

async function waitForSessionRowLock(): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [waiting] = await fixtureSql!`
      SELECT count(*)::int AS count
      FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query ILIKE '%FROM session AS s%'
    `;
    if (waiting.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Native session lookup did not wait on the synchronized session-row lock");
}

function getSessionFromPublic(
  pathname: string,
  headers: Record<string, string> = {},
  method = "GET",
) {
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${publicPort}${pathname}`, {
      method,
      headers: { connection: "close", ...headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.once("error", reject);
    req.end();
  });
}

async function buildSourceBinary(): Promise<string> {
  const args = ["build", "--locked", "--manifest-path", path.join(repositoryRoot, "native/Cargo.toml"),
    "--bin", "rudder-server-foundation", "--message-format=json"];
  const child = spawn(process.platform === "win32" ? "cargo.exe" : "cargo", args, {
    cwd: repositoryRoot,
    env: { ...process.env, CARGO_TARGET_DIR: "/private/tmp/rudder-agent-auth-target" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let executable: string | undefined;
  let diagnostics = "";
  const output = createInterface({ input: child.stdout! });
  output.on("line", (line) => {
    const artifact = JSON.parse(line) as { reason?: string; target?: { name?: string }; executable?: string };
    if (artifact.reason === "compiler-artifact" && artifact.target?.name === "rudder-server-foundation"
      && artifact.executable) executable = artifact.executable;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostics = `${diagnostics}${chunk.toString("utf8")}`.slice(-4_000);
  });
  const [code] = await once(child, "exit");
  output.close();
  if (code !== 0 || !executable) throw new Error(`Candidate Rust build failed (${code}): ${diagnostics}`);
  console.info("Native session workflow binary", {
    path: executable,
    sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
  });
  return executable;
}

function readStartup(child: ChildProcess, output: Interface): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Native session listener did not start: ${nativeStderr}`)), 20_000);
    const onLine = (line: string) => finish(undefined, line);
    const onExit = (code: number | null) => finish(new Error(`Native session server exited (${code}): ${nativeStderr}`));
    const onError = (error: Error) => finish(error);
    function finish(error?: Error, line?: string) {
      clearTimeout(timeout);
      output.off("line", onLine);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(line ?? "");
    }
    output.once("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopNative(): Promise<void> {
  const child = nativeChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
      child.kill("SIGTERM");
    });
  }
  nativeStdout?.close();
  nativeStdout = undefined;
  nativeChild = undefined;
}

async function startNative(
  kind: "better_auth" | "local_account" | null,
  secret: string | undefined,
  localImplicitEnabled = false,
): Promise<StartupReceipt> {
  nativeStderr = "";
  nativeChild = spawn(nativeBinaryPath, [], {
    env: {
      PATH: process.env.PATH ?? "",
      RUST_LOG: "error",
      RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
      RUDDER_NATIVE_DATABASE_URL: connectionString,
      RUDDER_NATIVE_DATABASE_REQUIRED: "true",
      RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: ACTOR_KEY,
      RUDDER_NATIVE_PUBLIC_LISTEN: "127.0.0.1:0",
      RUDDER_NATIVE_NODE_UPSTREAM: `http://127.0.0.1:${privateNodePort}`,
      RUDDER_NATIVE_INGRESS_AUTH_KEY: INGRESS_KEY,
      RUDDER_NATIVE_IDENTITY_AUTH_MODE: "required",
      RUDDER_NATIVE_IDENTITY_ASSERTION_KEY: ASSERTION_KEY,
      RUDDER_NATIVE_AGENT_JWT_SECRET: AGENT_JWT_SECRET,
      RUDDER_NATIVE_AGENT_JWT_ISSUER: "rudder",
      RUDDER_NATIVE_AGENT_JWT_AUDIENCE: "rudder-api",
      RUDDER_NATIVE_LOCAL_IMPLICIT: String(localImplicitEnabled),
      ...(kind && secret ? {
        RUDDER_NATIVE_SESSION_AUTH_MODE: "required",
        RUDDER_NATIVE_SESSION_AUTH_KIND: kind,
        RUDDER_NATIVE_SESSION_AUTH_SECRET: secret,
        RUDDER_NATIVE_SESSION_COOKIE_SECURE: "false",
        RUDDER_NATIVE_SESSION_ASSERTION_KEY: ASSERTION_KEY,
      } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  nativeChild.stderr?.on("data", (chunk: Buffer) => {
    nativeStderr = `${nativeStderr}${chunk.toString("utf8")}`.slice(-4_000);
  });
  nativeStdout = createInterface({ input: nativeChild.stdout! });
  const receipt = JSON.parse(await readStartup(nativeChild, nativeStdout)) as StartupReceipt;
  const address = receipt.publicIngress?.boundAddr;
  if (!address?.startsWith("127.0.0.1:")) throw new Error(`Unexpected public listener address: ${String(address)}`);
  publicPort = Number(address.slice(address.lastIndexOf(":") + 1));
  return receipt;
}

describe("source-built Rust public native session workflow", () => {
  beforeAll(async () => {
    fixtureRoot = "";
    const fixture = await startDisposableDatabase();
    connectionString = fixture.url;
    fixtureRoot = fixture.dir;
    embedded = fixture.instance;
    fixtureSql = postgres(connectionString, { max: 2, onnotice: () => {} });
    db = createDb(connectionString);
    await verifySessionTokenIndexUpgradeWithExistingRows();

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    userId = `native-session-e2e-user-${suffix}`;
    const [organization] = await fixtureSql`
      INSERT INTO organizations (url_key, name, issue_prefix)
      VALUES (${`${organizationUrlKey}-${suffix}`}, 'Native Session E2E', ${`E${suffix.slice(0, 7).toUpperCase()}`})
      RETURNING id::text
    `;
    orgId = organization.id;
    const [otherOrganization] = await fixtureSql`
      INSERT INTO organizations (url_key, name, issue_prefix)
      VALUES (${`native-session-other-${suffix}`}, 'Other Native Session E2E', ${`O${suffix.slice(0, 7).toUpperCase()}`})
      RETURNING id::text
    `;
    otherOrgId = otherOrganization.id;
    sessionToken = `native-session-e2e-${suffix}`;
    sessionId = `native-session-id-${suffix}`;
    agentId = randomUUID();
    boardKeyToken = `pcp_native_board_${suffix}`;
    agentKeyToken = `pcp_native_agent_${suffix}`;
    await fixtureSql`
      INSERT INTO "user" (id, name, email, created_at, updated_at)
      VALUES (${userId}, 'Native Session E2E User', ${`${userId}@invalid.test`}, now(), now())
    `;
    await fixtureSql`
      INSERT INTO organization_memberships (org_id, principal_type, principal_id, status)
      VALUES (${orgId}::uuid, 'user', ${userId}, 'active')
    `;
    await fixtureSql`
      INSERT INTO agents (id, org_id, name, status, agent_runtime_type)
      VALUES (${agentId}::uuid, ${orgId}::uuid, 'Native JWT E2E Agent', 'idle', 'claude_local')
    `;
    await fixtureSql`
      INSERT INTO board_api_keys (user_id, name, key_hash)
      VALUES (${userId}, 'Native public ingress E2E', ${hashApiToken(boardKeyToken)})
    `;
    await fixtureSql`
      INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash)
      VALUES (${agentId}::uuid, ${orgId}::uuid, 'Native public ingress E2E', ${hashApiToken(agentKeyToken)})
    `;
    await fixtureSql`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${sessionId}, ${sessionToken}, ${userId}, now() + interval '2 days', now(), now())
    `;

    const resolver = vi.fn(async () => {
      sessionResolverCalls += 1;
      return null;
    });
    const app = express();
    app.use((req, _res, next) => {
      if (req.path === "/api/health" && corruptHealthProof) {
        req.headers["x-rudder-native-session-proof"] = "corrupted-proof";
      }
      next();
    });
    app.use(nativeSessionAssertionMiddleware({ key: ASSERTION_KEY }));
    app.use(express.json({ limit: "10mb" }));
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      authRequirement: "required",
      resolveSession: resolver,
    }));
    app.use(accountSessionRequired("required"));
    app.get("/api/health", (_req, res) => res.status(healthStatus).json({ status: "ok" }));
    app.get("/api/auth/get-session", (req, res) => {
      if (req.actor.type !== "board" || !req.actor.userId) return res.sendStatus(401);
      res.json({
        session: { id: `rudder:${req.actor.source}:${req.actor.userId}`, userId: req.actor.userId },
        user: { id: req.actor.userId, email: null, name: null },
      });
    });
    app.post("/api/native-session-echo", (req, res) => {
      nodeRouteCalls += 1;
      res.json({
        actor: req.actor,
        bodyLength: typeof req.body?.payload === "string" ? req.body.payload.length : 0,
        cookieForwarded: Boolean(req.header("cookie")),
        proofForwarded: Boolean(req.header("x-rudder-native-session-proof")),
      });
    });
    nodeServer = createServer(app);
    await new Promise<void>((resolve, reject) => {
      nodeServer!.once("error", reject);
      nodeServer!.listen(0, "127.0.0.1", resolve);
    });
    privateNodePort = (nodeServer.address() as AddressInfo).port;

    nativeBinaryPath = await buildSourceBinary();
    const startup = await startNative("better_auth", SESSION_SECRET);
    expect(startup.publicListener).toBe(false);
    expect(startup.publicIngress?.publicListener).toBe(true);
    expect(startup.publicIngress?.nativeAuthentication?.sessionCookieAuthority).toMatchObject({
      kind: "better_auth",
      unmigrated: ["auth_lifecycle_routes", "websocket_session_resolution"],
    });
    expect(startup.publicIngress?.nativeAuthentication).toMatchObject({
      authority: "native-managed-http-identity-resolver",
      supportedCredentialStores: ["board_api_keys", "agent_api_keys", "agent_jwt"],
    });
    expect(startup.publicIngress?.nativeAuthentication?.directRoutes).toContain("/api/auth/get-session");
    expect(startup.publicIngress?.nativeAuthentication).toMatchObject({
      localImplicitEnabled: false,
      localImplicitConstraint: "disabled",
    });
    console.info("Native session workflow disposable fixture", {
      tempRoot: fixtureRoot || "external-test-database",
      database: new URL(connectionString).pathname.slice(1),
      publicPort,
      privateNodePort,
    });
  }, 600_000);

  it("completes the startup readiness handshake through the real private proof guard", async () => {
    const resolverCallsBefore = sessionResolverCalls;
    const startup = await preparePublicIngressStartup({
      host: "127.0.0.1", deploymentMode: "local_trusted", rustPublicIngressMode: "required",
    } as Config, publicPort, { sessionSecret: SESSION_SECRET });
    const ready = vi.fn();
    const reject = vi.fn();
    const app = {
      publicIngressBaseUrl: `http://127.0.0.1:${publicPort}`,
      async waitForPublicIngressReady() {
        const response = await getSessionFromPublic("/readyz");
        if (response.status !== 200) throw new Error(`readiness: ${response.status} ${response.body}`);
      },
    } as RudderAppHandle;
    try {
      const unsigned = await fetch(`http://127.0.0.1:${privateNodePort}/api/health`);
      expect(unsigned.status).toBe(401);
      await startup.onListening(app, reject, ready)();
      // Each probe needs a new nonce; a repeated proof must not make readiness sticky.
      await startup.onListening(app, reject, ready)();
      expect(ready).toHaveBeenCalledTimes(2);
      expect(reject).not.toHaveBeenCalled();
      corruptHealthProof = true;
      await startup.onListening(app, reject, ready)();
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("private_node_not_ready") }));
      expect(ready).toHaveBeenCalledTimes(2);
      corruptHealthProof = false;
      healthStatus = 503;
      const unavailable = await getSessionFromPublic("/readyz");
      expect(unavailable.status).toBe(503);
      expect(JSON.parse(unavailable.body).reason).toBe("private_node_not_ready");
      expect(sessionResolverCalls).toBe(resolverCallsBefore);
    } finally {
      healthStatus = 200;
      corruptHealthProof = false;
    }
  });

  afterAll(async () => {
    await stopNative();
    if (nodeServer) {
      await new Promise<void>((resolve, reject) => nodeServer!.close((error) => error ? reject(error) : resolve()));
      nodeServer = undefined;
    }
    try {
      if (fixtureSql && userId) {
        await fixtureSql`DELETE FROM organization_memberships WHERE org_id = ${orgId}::uuid`;
        await fixtureSql`DELETE FROM board_api_keys WHERE user_id = ${userId}`;
        await fixtureSql`DELETE FROM agent_api_keys WHERE agent_id = ${agentId}::uuid`;
        await fixtureSql`DELETE FROM agents WHERE id = ${agentId}::uuid`;
        await fixtureSql`DELETE FROM "user" WHERE id = ${userId}`;
        await fixtureSql`DELETE FROM organizations WHERE id = ${orgId}::uuid`;
        await fixtureSql`DELETE FROM organizations WHERE id = ${otherOrgId}::uuid`;
      }
    } finally {
      if (db) {
        await (db as Db & { $client?: { end(): Promise<void> } }).$client?.end();
        db = null;
      }
      await fixtureSql?.end();
      fixtureSql = null;
      if (embedded) {
        await embedded.stop();
        embedded = null;
      }
      if (fixtureRoot) {
        rmSync(fixtureRoot, { recursive: true, force: true });
        fixtureRoot = "";
      }
    }
  });

  it("serves get-session natively and delegates proxied business identity without Node cookie resolution", async () => {
    const valid = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(),
      "x-rudder-native-session-proof": "forged-client-proof",
    });
    expect(valid.status).toBe(200);
    expect(valid.headers["set-cookie"]).toBeUndefined();
    expect(JSON.parse(valid.body)).toEqual({
      session: { id: `rudder:session:${userId}`, userId },
      user: { id: userId, email: null, name: null },
    });
    const [refreshed] = await fixtureSql!`
      SELECT expires_at > now() + interval '6 days' AS refreshed
      FROM session WHERE id = ${sessionId}
    `;
    expect(refreshed.refreshed).toBe(true);

    const duplicateCookie = await getSessionFromPublic("/api/auth/get-session", {
      cookie: `better-auth.session_token=forged; ${sessionCookie()}`,
    });
    expect(duplicateCookie.status).toBe(401);

    const rememberToken = `native-session-dont-remember-${Date.now()}`;
    const rememberId = `native-session-dont-remember-id-${Date.now()}`;
    await fixtureSql!`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${rememberId}, ${rememberToken}, ${userId}, now() + interval '2 days', now() - interval '1 day', now() - interval '1 day')
    `;
    const remembered = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(rememberToken, "false"),
    });
    expect(remembered.status).toBe(200);
    const [notRefreshed] = await fixtureSql!`
      SELECT expires_at BETWEEN now() + interval '1 day' AND now() + interval '3 days' AS unchanged,
             updated_at < now() - interval '12 hours' AS updated_at_unchanged
      FROM session WHERE id = ${rememberId}
    `;
    expect(notRefreshed).toEqual({ unchanged: true, updated_at_unchanged: true });

    const expiredToken = `native-session-expired-${Date.now()}`;
    const expiredId = `native-session-expired-id-${Date.now()}`;
    await fixtureSql!`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${expiredId}, ${expiredToken}, ${userId}, now() - interval '1 second', now() - interval '1 day', now() - interval '1 day')
    `;
    const expired = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(expiredToken),
    });
    expect(expired.status).toBe(401);
    const [expiredStillExists] = await fixtureSql!`
      SELECT EXISTS (SELECT 1 FROM session WHERE id = ${expiredId}) AS exists
    `;
    expect(expiredStillExists.exists).toBe(false);

    const body = JSON.stringify({ payload: "x".repeat(2 * 1024 * 1024) });
    const proxied = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(`http://127.0.0.1:${publicPort}/api/native-session-echo?raw=a%2Bb`, {
        method: "POST",
        headers: {
          cookie: sessionCookie(),
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-rudder-native-session-proof": "forged-client-proof",
          connection: "close",
        },
      }, (response) => {
        let result = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { result += chunk; });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: result }));
      });
      request.once("error", reject);
      request.end(body);
    });
    expect(proxied.status).toBe(200);
    expect(JSON.parse(proxied.body)).toMatchObject({
      actor: {
        type: "board",
        source: "session",
        userId,
        sessionId,
        orgIds: [orgId],
      },
      bodyLength: 2 * 1024 * 1024,
      cookieForwarded: false,
      proofForwarded: false,
    });
    expect(nodeRouteCalls).toBe(1);
    expect(sessionResolverCalls).toBe(0);

    const agentRunId = `native-agent-jwt-run-${Date.now()}`;
    const jwt = signAgentJwt({ agentId, orgId, runId: agentRunId });
    const jwtResponse = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${jwt}`,
      "x-rudder-run-id": agentRunId,
      "x-rudder-agent-id": agentId,
    }, "POST");
    expect(jwtResponse.status).toBe(200);
    expect(JSON.parse(jwtResponse.body).actor).toMatchObject({
      type: "agent",
      source: "agent_jwt",
      agentId,
      orgId,
      runId: agentRunId,
      adapterType: "claude_local",
    });
    const nodeCallsBeforeMismatchedRunId = nodeRouteCalls;
    const mismatchedProxyRunId = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${jwt}`,
      "x-rudder-run-id": `${agentRunId}-different`,
    }, "POST");
    expect(mismatchedProxyRunId.status).toBe(403);
    expect(JSON.parse(mismatchedProxyRunId.body).code).toBe("agent_run_context_mismatch");
    expect(nodeRouteCalls).toBe(nodeCallsBeforeMismatchedRunId);
    expect(sessionResolverCalls).toBe(0);

    const boardKeyResponse = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${boardKeyToken}`,
    }, "POST");
    expect(boardKeyResponse.status).toBe(200);
    expect(JSON.parse(boardKeyResponse.body).actor).toMatchObject({
      type: "board",
      source: "board_key",
      userId,
    });

    const agentKeyResponse = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${agentKeyToken}`,
    }, "POST");
    expect(agentKeyResponse.status).toBe(200);
    expect(JSON.parse(agentKeyResponse.body).actor).toMatchObject({
      type: "agent",
      source: "agent_key",
      agentId,
      orgId,
    });
    expect(sessionResolverCalls).toBe(0);

    const jwtDirectory = await getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
      authorization: `Bearer ${jwt}`,
    });
    // The direct GET keeps the legacy run-context contract: no optional
    // run-id header and the matching signed run id are accepted.
    expect(jwtDirectory.status).toBe(200);
    const matchingRunIdDirectory = await getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
      authorization: `Bearer ${jwt}`,
      "x-rudder-run-id": agentRunId,
    });
    expect(matchingRunIdDirectory.status).toBe(200);
    const whitespaceRunIdDirectory = await getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
      authorization: `Bearer ${jwt}`,
      "x-rudder-run-id": "   ",
    });
    expect(whitespaceRunIdDirectory.status).toBe(200);
    const mismatchedRunIdDirectory = await getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
      authorization: `Bearer ${jwt}`,
      "x-rudder-run-id": `${agentRunId}-different`,
    });
    expect(mismatchedRunIdDirectory.status).toBe(403);
    expect(JSON.parse(mismatchedRunIdDirectory.body).code).toBe("agent_run_context_mismatch");
    const wrongOrgDirectory = await getSessionFromPublic(`/api/orgs/${otherOrgId}/members/directory`, {
      authorization: `Bearer ${jwt}`,
    });
    expect(wrongOrgDirectory.status).toBe(403);

    const beforeRejectedJwt = nodeRouteCalls;
    const forged = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${forgeAgentJwt()}`,
    }, "POST");
    expect(forged.status).toBe(401);
    expect(nodeRouteCalls).toBe(beforeRejectedJwt);

    await fixtureSql!`UPDATE agents SET status = 'terminated' WHERE id = ${agentId}::uuid`;
    const terminated = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${jwt}`,
    }, "POST");
    expect(terminated.status).toBe(401);
    expect(nodeRouteCalls).toBe(beforeRejectedJwt);
    await fixtureSql!`UPDATE agents SET status = 'pending_approval' WHERE id = ${agentId}::uuid`;
    const pending = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${jwt}`,
    }, "POST");
    expect(pending.status).toBe(401);
    expect(nodeRouteCalls).toBe(beforeRejectedJwt);
    await fixtureSql!`UPDATE agents SET status = 'idle' WHERE id = ${agentId}::uuid`;

    const invalidCookie = await getSessionFromPublic("/api/native-session-echo", {
      cookie: "better-auth.session_token=forged",
    });
    expect(invalidCookie.status).toBe(401);
    expect(sessionResolverCalls).toBe(0);
  }, 60_000);

  it("rejects direct private-listener cookie fallback and keeps invalid Bearer ahead of a valid cookie", async () => {
    const direct = await getSessionFromPrivate("/api/native-session-echo", {
      cookie: sessionCookie(),
    });
    expect(direct.status).toBe(401);
    expect(JSON.parse(direct.body).code).toBe("native_session_proof_required");

    const directGetSession = await getSessionFromPrivate("/api/auth/get-session", {
      cookie: sessionCookie(),
    }, "GET");
    expect(directGetSession.status).toBe(401);
    expect(JSON.parse(directGetSession.body).code).toBe("native_session_proof_required");
    expect(sessionResolverCalls).toBe(0);

    const bearer = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(),
      authorization: "Bearer pcp_invalid_native_session_e2e",
    });
    expect(bearer.status).toBe(401);
    expect(sessionResolverCalls).toBe(0);
  }, 20_000);

  it("fails closed on unsupported get-session methods at public and private listeners", async () => {
    const nodeCallsBefore = nodeRouteCalls;
    const publicPost = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(),
      "x-rudder-native-session-proof": "forged-client-proof",
    }, "POST");
    expect(publicPost.status).toBe(405);
    expect(publicPost.headers.allow).toBe("GET, HEAD");
    expect(nodeRouteCalls).toBe(nodeCallsBefore);
    expect(sessionResolverCalls).toBe(0);

    const privatePost = await getSessionFromPrivate(
      "/api/auth/get-session",
      { cookie: sessionCookie() },
      "POST",
    );
    expect(privatePost.status).toBe(405);
    expect(JSON.parse(privatePost.body).code).toBe("native_get_session_method_not_allowed");
    expect(sessionResolverCalls).toBe(0);
  }, 20_000);

  it("fails closed on ambiguous duplicate session-token rows through the real public listener", async () => {
    const token = `native-session-duplicate-token-${Date.now()}`;
    const firstId = `native-session-duplicate-first-${Date.now()}`;
    const secondId = `native-session-duplicate-second-${Date.now()}`;
    await fixtureSql!`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES
        (${firstId}, ${token}, ${userId}, now() + interval '2 days', now(), now()),
        (${secondId}, ${token}, ${userId}, now() + interval '2 days', now(), now())
    `;

    try {
      const response = await getSessionFromPublic("/api/auth/get-session", {
        cookie: sessionCookie(token),
      });
      expect(response.status).toBe(401);
      expect(sessionResolverCalls).toBe(0);
    } finally {
      await fixtureSql!`DELETE FROM session WHERE id IN (${firstId}, ${secondId})`;
    }
  }, 20_000);

  it("rechecks live membership on the direct native member-directory route", async () => {
    let pending!: ReturnType<typeof getSessionFromPublic>;
    await fixtureSql!.begin(async (tx) => {
      await tx`UPDATE session SET updated_at = updated_at WHERE id = ${sessionId}`;
      pending = getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
        cookie: sessionCookie(),
      });
      await waitForSessionRowLock();
      await tx`
        UPDATE organization_memberships SET status = 'inactive'
        WHERE org_id = ${orgId}::uuid AND principal_id = ${userId}
      `;
    });
    const response = await pending;
    expect(response.status).toBe(403);

    const subsequent = await getSessionFromPublic(`/api/orgs/${orgId}/members/directory`, {
      cookie: sessionCookie(),
    });
    expect(subsequent.status).toBe(403);
    expect(sessionResolverCalls).toBe(0);
  }, 20_000);

  it("uses the separate Desktop cookie secret with read-only local expiry semantics", async () => {
    await stopNative();
    const startup = await startNative("local_account", LOCAL_SESSION_SECRET);
    expect(startup.publicIngress?.nativeAuthentication?.sessionCookieAuthority).toMatchObject({
      kind: "local_account",
      unmigrated: ["auth_lifecycle_routes", "websocket_session_resolution"],
    });

    const localToken = `native-local-session-${Date.now()}`;
    const localId = `native-local-session-id-${Date.now()}`;
    await fixtureSql!`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${localId}, ${localToken}, ${userId}, now() + interval '29 days', now() - interval '1 day', now() - interval '1 day')
    `;
    const local = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(localToken, undefined, LOCAL_SESSION_SECRET),
    });
    expect(local.status).toBe(200);
    expect(local.headers["set-cookie"]).toBeUndefined();
    const [localUnchanged] = await fixtureSql!`
      SELECT expires_at BETWEEN now() + interval '28 days' AND now() + interval '30 days' AS expiry_unchanged,
             updated_at < now() - interval '12 hours' AS updated_at_unchanged
      FROM session WHERE id = ${localId}
    `;
    expect(localUnchanged).toEqual({ expiry_unchanged: true, updated_at_unchanged: true });

    const wrongSecret = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(localToken),
    });
    expect(wrongSecret.status).toBe(401);

    await fixtureSql!`UPDATE session SET expires_at = now() WHERE id = ${localId}`;
    const expired = await getSessionFromPublic("/api/auth/get-session", {
      cookie: sessionCookie(localToken, undefined, LOCAL_SESSION_SECRET),
    });
    expect(expired.status).toBe(401);
    const [localStillExists] = await fixtureSql!`
      SELECT EXISTS (SELECT 1 FROM session WHERE id = ${localId}) AS exists
    `;
    expect(localStillExists.exists).toBe(true);
  }, 20_000);

  it("fails closed when session revocation commits while cookie lookup is waiting", async () => {
    const revokedToken = `native-session-revoke-race-${Date.now()}`;
    const revokedId = `native-session-revoke-race-id-${Date.now()}`;
    await fixtureSql!`
      INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
      VALUES (${revokedId}, ${revokedToken}, ${userId}, now() + interval '2 days', now(), now())
    `;

    let pending!: ReturnType<typeof getSessionFromPublic>;
    await fixtureSql!.begin(async (tx) => {
      await tx`UPDATE session SET updated_at = updated_at WHERE id = ${revokedId}`;
      pending = getSessionFromPublic("/api/auth/get-session", {
        cookie: sessionCookie(revokedToken, undefined, LOCAL_SESSION_SECRET),
      });
      await waitForSessionRowLock();
      await tx`DELETE FROM session WHERE id = ${revokedId}`;
    });
    const response = await pending;
    expect(response.status).toBe(401);
    expect(sessionResolverCalls).toBe(0);
  }, 20_000);

  it("allows local implicit only for absent credentials on the loopback public listener", async () => {
    await stopNative();
    const startup = await startNative(null, undefined, true);
    expect(startup.publicIngress?.nativeAuthentication).toMatchObject({
      localImplicitEnabled: true,
      localImplicitConstraint: "numeric_loopback_listener_and_actual_peer",
    });

    const before = nodeRouteCalls;
    const local = await getSessionFromPublic("/api/native-session-echo", {}, "POST");
    expect(local.status).toBe(200);
    expect(JSON.parse(local.body).actor).toMatchObject({
      type: "board",
      userId: "local-board",
      source: "local_implicit",
    });

    const forged = await getSessionFromPublic("/api/native-session-echo", {
      authorization: `Bearer ${forgeAgentJwt()}`,
    }, "POST");
    expect(forged.status).toBe(401);
    const invalidCookie = await getSessionFromPublic("/api/native-session-echo", {
      cookie: "better-auth.session_token=forged",
    }, "POST");
    expect(invalidCookie.status).toBe(401);
    const invalidPcp = await getSessionFromPublic("/api/native-session-echo", {
      authorization: "Bearer pcp_invalid_local_implicit_e2e",
    }, "POST");
    expect(invalidPcp.status).toBe(401);
    const malformedAuthorization = await getSessionFromPublic("/api/native-session-echo", {
      authorization: "Basic supplied-credential",
    }, "POST");
    expect(malformedAuthorization.status).toBe(401);
    expect(nodeRouteCalls).toBe(before + 1);
    expect(sessionResolverCalls).toBe(0);
  }, 30_000);
});

function getSessionFromPrivate(
  pathname: string,
  headers: Record<string, string>,
  method = "POST",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${privateNodePort}${pathname}`, {
      method,
      headers: { ...headers, "content-type": "application/json", connection: "close" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.once("error", reject);
    req.end("{}");
  });
}
