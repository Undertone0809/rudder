import type { Db } from "@rudderhq/db";
import {
  agentApiKeys,
  applyPendingMigrations,
  boardApiKeys,
  createDb,
  ensurePostgresDatabase,
} from "@rudderhq/db";
import express, { type Request } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path, { dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalAgentJwt, localAgentJwtAuthSettings } from "../agent-auth-jwt.js";
import { accountSessionRequired } from "../middleware/account-session-required.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import {
  PUBLIC_INGRESS_AUTH_ENDPOINT,
  PUBLIC_INGRESS_LLM_REFLECTION_AUTH_ENDPOINT,
  publicIngressAuthRoutes,
} from "../routes/public-ingress-auth.js";
import { hashBearerToken } from "../services/board-auth.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";

const organizationId = "10000000-0000-0000-0000-000000000001";
const otherOrganizationId = "20000000-0000-0000-0000-000000000002";
const boardUserId = "board-user-rust-auth-workflow";
const sessionUserId = "session-user-rust-auth-workflow";
const agentId = "f5e8a1ca-8ed3-4ef4-9e3e-829191260f14";
const boardToken = "pcp_board_test_public_ingress_token";
const revokedBoardToken = "pcp_board_revoked_public_ingress_token";
const expiredBoardToken = "pcp_board_expired_public_ingress_token";
const revokedAgentToken = "pcp_agent_revoked_public_ingress_token";
const agentToken = "legacy_agent_test_public_ingress_token";
const sessionToken = "native-auth-workflow-session-token";
const sessionId = "better-auth-session-1";
const sessionSecret = "native-auth-workflow-session-secret-0123456789abcdef";
const ingressAuthKey = "11".repeat(32);
const actorEnvelopeKey = "22".repeat(32);
const agentJwtSettings = localAgentJwtAuthSettings();
const identityFixture = nativeIdentityIngressFixture();
const forgedActorEnvelope = "forged-client-actor-envelope";
const forgedRequestId = "forged-client-request-id";
const forgedIngressKey = "forged-client-ingress-key";
const startupTimeoutMs = 15_000;
const serverExitTimeoutMs = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type AuthorizationObservation = {
  actor: Request["actor"];
  body: Record<string, unknown>;
  headers: {
    authorization?: string;
    cookie?: string;
    host?: string;
    origin?: string;
    ingressAuth?: string;
    actorEnvelope?: string;
    requestId?: string;
    agentId?: string;
    runId?: string;
    forwardedFor?: string;
    forwardedProto?: string;
    forwardedHost?: string;
    realIp?: string;
  };
  responseStatus?: number;
};

type StartupReceipt = {
  boundAddr?: string;
  publicListener?: boolean;
  publicIngress?: { boundAddr?: string; publicListener?: boolean };
};

const authorizationObservations: AuthorizationObservation[] = [];
let authServer: Server | undefined;
let rustChild: ChildProcess | undefined;
let rustStdout: Interface | undefined;
let rustStderr = "";
let publicPort: number | undefined;
let fixtureRoot = "";
let embeddedPostgres: { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> } | undefined;
let databaseUrl = "";
let fixtureSql: ReturnType<typeof postgres> | undefined;
let db: Db | undefined;
let sessionResolverCalls = 0;
let boardKeyLookupCalls = 0;
let agentKeyLookupCalls = 0;
let privateRequestCalls = 0;

const agentKeyHash = createHash("sha256").update(agentToken).digest("hex");
const revokedAgentKeyHash = createHash("sha256").update(revokedAgentToken).digest("hex");
let localAgentJwt = "";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return rejectPort(new Error("No fixture port"));
      probe.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

async function startDisposableDatabase() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "rudder-jwt-auth-workflow-"));
  const port = await availablePort();
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const instance = new EmbeddedPostgres({
    databaseDir: path.join(directory, "postgres-data"),
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
  const dbName = `rudder_jwt_auth_workflow_test_${process.pid}_${Date.now()}`;
  await ensurePostgresDatabase(adminUrl, dbName);
  const url = `postgres://rudder:rudder@127.0.0.1:${port}/${dbName}`;
  await applyPendingMigrations(url);
  return { url, directory, instance };
}

function signedSessionCookie(token: string = sessionToken) {
  const signature = createHmac("sha256", sessionSecret).update(token).digest("base64");
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

function createObservedAuthDb(source: Db): Db {
  return new Proxy(source, {
    get(target, property, receiver) {
      if (property === "select") {
        return (...args: unknown[]) => {
          const select = Reflect.get(target, property, target) as (...values: unknown[]) => object;
          const query = select.apply(target, args);
          return new Proxy(query, {
            get(builder, method) {
              if (method === "from") {
                return (table: unknown) => {
                  if (table === boardApiKeys) boardKeyLookupCalls += 1;
                  if (table === agentApiKeys) agentKeyLookupCalls += 1;
                  const from = Reflect.get(builder, method, builder) as (value: unknown) => unknown;
                  return from.call(builder, table);
                };
              }
              const value = Reflect.get(builder, method, builder);
              return typeof value === "function" ? value.bind(builder) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Compile the candidate source in this checkout. CI reuses its native:build
// release cache; local checks reuse debug. Arbitrary executable overrides are
// deliberately unsupported, so a stale or unrelated binary cannot satisfy it.
async function buildSourceBinary(): Promise<string> {
  const args = ["build", "--locked", "--manifest-path", resolve(repositoryRoot, "native/Cargo.toml"),
    "--bin", "rudder-server-foundation", "--message-format=json"];
  if (process.env.CI) args.push("--release");
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
  try {
    const [code] = await once(child, "exit");
    if (code !== 0 || !executable) throw new Error(`Candidate Rust build failed (${code}): ${diagnostics}`);
    const sha256 = createHash("sha256").update(readFileSync(executable)).digest("hex");
    console.info("Source-built ingress test binary", { executable, sha256, manifest: args[3] });
    return executable;
  } finally {
    output.close();
  }
}

function createPrivateAuthApp(sourceDb: Db) {
  const app = express();
  const observedDb = createObservedAuthDb(sourceDb);
  app.use(identityFixture.middleware());
  app.use((_req, _res, next) => {
    privateRequestCalls += 1;
    next();
  });
  app.use(express.json({
    limit: "10mb",
    verify: (req, _res, body) => {
      (req as Request).rawBody = Buffer.from(body);
    },
  }));
  app.use(actorMiddleware(observedDb, {
    deploymentMode: "authenticated",
    authRequirement: "required",
    resolveSession: async () => {
      sessionResolverCalls += 1;
      return null;
    },
  }));
  app.use((req, res, next) => {
    if (req.originalUrl === PUBLIC_INGRESS_AUTH_ENDPOINT
      || req.originalUrl === PUBLIC_INGRESS_LLM_REFLECTION_AUTH_ENDPOINT) {
      const body = req.body && typeof req.body === "object"
        ? req.body as Record<string, unknown>
        : {};
      const observation: AuthorizationObservation = {
        actor: structuredClone(req.actor),
        body: { ...body },
        headers: {
          authorization: req.get("authorization"),
          cookie: req.get("cookie"),
          host: req.get("host"),
          origin: req.get("origin"),
          ingressAuth: req.get("x-rudder-ingress-auth"),
          actorEnvelope: req.get("x-rudder-actor-envelope"),
          requestId: req.get("x-rudder-request-id"),
          agentId: req.get("x-rudder-agent-id"),
          runId: req.get("x-rudder-run-id"),
          forwardedFor: req.get("x-forwarded-for"),
          forwardedProto: req.get("x-forwarded-proto"),
          forwardedHost: req.get("x-forwarded-host"),
          realIp: req.get("x-real-ip"),
        },
      };
      authorizationObservations.push(observation);
      res.once("finish", () => {
        observation.responseStatus = res.statusCode;
      });
    }
    next();
  });
  app.use(accountSessionRequired("required"));
  app.use("/api", publicIngressAuthRoutes({
    internalIngressAuthKey: ingressAuthKey,
    actorEnvelopeKey,
    db: sourceDb,
  }));
  app.get("/api/health", (_req, res) => res.status(200).json({ status: "ok" }));
  app.use(errorHandler);
  return app;
}

function readStartupLine(child: ChildProcess, output: Interface) {
  return new Promise<string>((resolveLine, rejectLine) => {
    const timeout = setTimeout(() => finish(new Error(
      `Rust public ingress did not emit startup receipt${rustStderr ? `: ${rustStderr.trim()}` : ""}`,
    )), startupTimeoutMs);
    const onLine = (line: string) => finish(undefined, line);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(
      `Rust public ingress exited before startup (${code ?? signal ?? "unknown"})${rustStderr ? `: ${rustStderr.trim()}` : ""}`,
    ));
    const onError = (error: Error) => finish(error);

    function finish(error?: Error, line?: string) {
      clearTimeout(timeout);
      output.off("line", onLine);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectLine(error);
      else resolveLine(line ?? "");
    }

    output.once("line", onLine);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function stopRustChild() {
  const child = rustChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolveExit) => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), serverExitTimeoutMs);
      const onExit = () => {
        clearTimeout(timeout);
        resolveExit();
      };
      child.once("exit", onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
      else child.kill("SIGTERM");
    });
  }
  rustStdout?.close();
  rustStdout = undefined;
  rustChild = undefined;
}

function getPublicIngress(path: string, headers: Record<string, string> = {}, method = "GET") {
  if (publicPort === undefined) throw new Error("Public Actix listener is not started");
  return new Promise<{
    status: number;
    body: string;
    headers: import("node:http").IncomingMessage["headers"];
  }>((resolveResponse, rejectResponse) => {
    const req = httpRequest({
      hostname: "127.0.0.1",
      port: publicPort,
      path,
      method,
      headers: { connection: "close", ...headers },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { body += chunk; });
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.setTimeout(5_000, () => req.destroy(new Error("Public Actix request timed out")));
    req.once("error", rejectResponse);
    req.end();
  });
}

function lastObservation() {
  const observation = authorizationObservations.at(-1);
  if (!observation) throw new Error("Private Node auth adapter did not receive the Actix request");
  return observation;
}

function expectOriginalRequestContext(observation: AuthorizationObservation, host: string) {
  expect(observation.headers.host).toBe(host);
  expect(observation.headers.origin).toBe("https://public.example");
  expect(observation.headers.ingressAuth).toBe(ingressAuthKey);
  expect(observation.headers.actorEnvelope).toBeUndefined();
  expect(observation.headers.requestId).toBeUndefined();
}

function expectSocketForwardingContext(observation: AuthorizationObservation) {
  expect(observation.headers.forwardedFor).toBe("127.0.0.1");
  expect(observation.headers.realIp).toBe("127.0.0.1");
  expect(observation.headers.forwardedProto).toBe("http");
  expect(observation.headers.forwardedHost).toBeUndefined();
}

const forgedForwardingHeaders = {
  "x-forwarded-for": "198.51.100.99",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "forged.example.test",
  "x-real-ip": "203.0.113.9",
};

async function seedAuthenticationRows() {
  const sql = fixtureSql!;
  const now = new Date();
  await sql`
    INSERT INTO organizations (id, url_key, name, issue_prefix)
    VALUES
      (${organizationId}::uuid, 'jwt-auth-workflow-main', 'JWT Auth Workflow', 'JAW'),
      (${otherOrganizationId}::uuid, 'jwt-auth-workflow-other', 'JWT Auth Workflow Other', 'JWO')
  `;
  await sql`
    INSERT INTO "user" (id, name, email, created_at, updated_at)
    VALUES
      (${boardUserId}, 'Board Workflow User', 'board-jwt-workflow@invalid.test', ${now}, ${now}),
      (${sessionUserId}, 'Session Workflow User', 'session-jwt-workflow@invalid.test', ${now}, ${now})
  `;
  await sql`
    INSERT INTO organization_memberships (org_id, principal_type, principal_id, status, membership_role)
    VALUES
      (${organizationId}::uuid, 'user', ${boardUserId}, 'active', 'owner'),
      (${organizationId}::uuid, 'user', ${sessionUserId}, 'active', 'member'),
      (${organizationId}::uuid, 'agent', ${agentId}, 'active', 'researcher')
  `;
  await sql`
    INSERT INTO agents (id, org_id, name, status, role, agent_runtime_type, permissions)
    VALUES (
      ${agentId}::uuid, ${organizationId}::uuid, 'Authorized fixture agent', 'idle',
      'researcher', 'fixture', '{"canCreateAgents":true,"canManageSkills":false}'::jsonb
    )
  `;
  await sql`
    INSERT INTO board_api_keys (user_id, name, key_hash, expires_at)
    VALUES
      (${boardUserId}, 'Native valid Board fixture', ${hashBearerToken(boardToken)}, now() + interval '2 days'),
      (${boardUserId}, 'Native revoked Board fixture', ${hashBearerToken(revokedBoardToken)}, now() + interval '2 days'),
      (${boardUserId}, 'Native expired Board fixture', ${hashBearerToken(expiredBoardToken)}, now() - interval '1 minute')
  `;
  await sql`
    UPDATE board_api_keys SET revoked_at = now()
    WHERE key_hash = ${hashBearerToken(revokedBoardToken)}
  `;
  await sql`
    INSERT INTO agent_api_keys (agent_id, org_id, name, key_hash)
    VALUES
      (${agentId}::uuid, ${organizationId}::uuid, 'Native valid Agent fixture', ${agentKeyHash}),
      (${agentId}::uuid, ${organizationId}::uuid, 'Native revoked Agent fixture', ${revokedAgentKeyHash})
  `;
  await sql`
    UPDATE agent_api_keys SET revoked_at = now()
    WHERE key_hash = ${revokedAgentKeyHash}
  `;
  await sql`
    INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
    VALUES (${sessionId}, ${sessionToken}, ${sessionUserId}, now() + interval '2 days', now(), now())
  `;
}

describe("source-binary public Actix authentication workflow", () => {
  beforeAll(async () => {
    const fixture = await startDisposableDatabase();
    fixtureRoot = fixture.directory;
    embeddedPostgres = fixture.instance;
    databaseUrl = fixture.url;
    fixtureSql = postgres(databaseUrl, { max: 4, onnotice: () => {} });
    db = createDb(databaseUrl);
    await seedAuthenticationRows();
    localAgentJwt = createLocalAgentJwt(agentId, organizationId, "fixture", "run-local-jwt") ?? "";
    if (!localAgentJwt) throw new Error("Local Agent JWT fixture could not be created");

    const binaryPath = await buildSourceBinary();
    authServer = createPrivateAuthApp(db).listen(0, "127.0.0.1");
    await once(authServer, "listening");
    const upstreamAddress = authServer.address() as AddressInfo;

    rustChild = spawn(binaryPath, [], {
      env: {
        PATH: process.env.PATH ?? "",
        RUST_LOG: "error",
        RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_DATABASE_URL: databaseUrl,
        RUDDER_NATIVE_DATABASE_REQUIRED: "true",
        RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: actorEnvelopeKey,
        RUDDER_NATIVE_PUBLIC_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_NODE_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        RUDDER_NATIVE_INGRESS_AUTH_KEY: ingressAuthKey,
        RUDDER_NATIVE_IDENTITY_AUTH_MODE: "required",
        RUDDER_NATIVE_IDENTITY_ASSERTION_KEY: identityFixture.identityAuth.assertionKey,
        RUDDER_NATIVE_LOCAL_IMPLICIT: "false",
        RUDDER_NATIVE_AGENT_JWT_SECRET: agentJwtSettings.secret,
        RUDDER_NATIVE_AGENT_JWT_ISSUER: agentJwtSettings.issuer,
        RUDDER_NATIVE_AGENT_JWT_AUDIENCE: agentJwtSettings.audience,
        RUDDER_NATIVE_SESSION_AUTH_MODE: "required",
        RUDDER_NATIVE_SESSION_AUTH_KIND: "better_auth",
        RUDDER_NATIVE_SESSION_AUTH_SECRET: sessionSecret,
        RUDDER_NATIVE_SESSION_COOKIE_SECURE: "false",
        RUDDER_NATIVE_SESSION_ASSERTION_KEY: identityFixture.identityAuth.assertionKey,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    rustChild.stderr?.on("data", (chunk: Buffer) => {
      rustStderr = `${rustStderr}${chunk.toString("utf8")}`.slice(-4_000);
    });
    if (!rustChild.stdout) throw new Error("Rust child stdout pipe is unavailable");
    rustStdout = createInterface({ input: rustChild.stdout });

    const startup = JSON.parse(await readStartupLine(rustChild, rustStdout)) as StartupReceipt;
    expect(startup.publicListener).toBe(false);
    expect(startup.publicIngress?.publicListener).toBe(true);
    const publicAddress = startup.publicIngress?.boundAddr;
    if (!publicAddress?.startsWith("127.0.0.1:")) {
      throw new Error(`Unexpected public listener address: ${String(publicAddress)}`);
    }
    publicPort = Number(publicAddress.slice(publicAddress.lastIndexOf(":") + 1));
    expect(Number.isInteger(publicPort) && publicPort > 0).toBe(true);
    console.info("Native auth workflow disposable fixture", {
      tempRoot: fixtureRoot,
      database: new URL(databaseUrl).pathname.slice(1),
      publicPort,
      privateNodePort: upstreamAddress.port,
    });
  }, 600_000);

  beforeEach(async () => {
    await fixtureSql!`
      UPDATE organization_memberships SET status = 'active'
      WHERE org_id = ${organizationId}::uuid AND principal_type = 'user' AND principal_id = ${sessionUserId}
    `;
    await fixtureSql!`
      INSERT INTO organization_memberships (org_id, principal_type, principal_id, status, membership_role)
      VALUES (${organizationId}::uuid, 'user', ${sessionUserId}, 'active', 'member')
      ON CONFLICT (org_id, principal_type, principal_id)
      DO UPDATE SET status = 'active', membership_role = 'member'
    `;
    await fixtureSql!`
      UPDATE agents SET permissions = '{"canCreateAgents":true,"canManageSkills":false}'::jsonb
      WHERE id = ${agentId}::uuid
    `;
    authorizationObservations.length = 0;
    sessionResolverCalls = 0;
    boardKeyLookupCalls = 0;
    agentKeyLookupCalls = 0;
    privateRequestCalls = 0;
  });

  afterAll(async () => {
    await stopRustChild();
    if (authServer) {
      await new Promise<void>((resolveClose, rejectClose) => {
        authServer?.close((error) => error ? rejectClose(error) : resolveClose());
      });
      authServer = undefined;
    }
    await fixtureSql?.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    if (embeddedPostgres) await embeddedPostgres.stop();
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("authenticates persisted Board keys and session cookies on the native public listener", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const publicPath = `/api/orgs/${organizationId}/members/directory?type=agent&limit=25&query=Authorized+fixture&unused=1`;

    const nativeResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      ...forgedForwardingHeaders,
      authorization: `Bearer ${boardToken}`,
    });
    expect(nativeResponse.status).toBe(200);
    expect(JSON.parse(nativeResponse.body)).toMatchObject({
      total: 1,
      items: [{ name: "Authorized fixture agent", type: "agent", role: "researcher" }],
    });
    expect(authorizationObservations).toHaveLength(0);

    const sessionStatus = await getPublicIngress("/api/auth/get-session", {
      host,
      origin: "https://public.example",
      ...forgedForwardingHeaders,
      cookie: signedSessionCookie(),
    });
    expect(sessionStatus.status).toBe(200);
    expect(JSON.parse(sessionStatus.body)).toEqual({
      session: { id: `rudder:session:${sessionUserId}`, userId: sessionUserId },
      user: { id: sessionUserId, email: null, name: null },
    });
    const sessionLlm = await getPublicIngress("/llms/agent-icons.txt", {
      cookie: signedSessionCookie(),
    });
    expect(sessionLlm.status).toBe(200);
    expect(lastObservation().actor).toMatchObject({
      type: "board", source: "session", userId: sessionUserId, sessionId,
    });
    expect(privateRequestCalls).toBe(1);
    authorizationObservations.length = 0;
    privateRequestCalls = 0;

    const sessionResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      ...forgedForwardingHeaders,
      cookie: signedSessionCookie(),
    });
    expect(sessionResponse.status).toBe(200);
    expect(JSON.parse(sessionResponse.body).total).toBe(1);
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 20_000);

  it("serves root LLM documents through Rust and the private Node actor/registry adapter", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const headers = {
      host,
      origin: "https://public.example",
      authorization: `Bearer ${boardToken}`,
      "x-rudder-actor-envelope": forgedActorEnvelope,
      "x-rudder-request-id": forgedRequestId,
      ...forgedForwardingHeaders,
    };
    const indexPath = "/llms/agent-configuration.txt?source=rust&source=board";
    const index = await getPublicIngress(indexPath, headers);
    const indexObservation = lastObservation();
    expect(index.status, index.body).toBe(200);
    expect(index.headers["content-type"]).toContain("text/plain");
    expect(index.body).toContain("# Rudder Agent Configuration Index");
    expect(index.body).toContain("Installed adapters:");
    expect(indexObservation.body).toMatchObject({ publicMethod: "GET", publicPath: indexPath });
    expect(indexObservation.actor).toMatchObject({ type: "board", source: "board_key" });
    expect(indexObservation.responseStatus).toBe(200);
    expectOriginalRequestContext(indexObservation, host);
    expectSocketForwardingContext(indexObservation);

    const iconsPath = "/llms/agent-icons.txt?raw=a%2Bb";
    const icons = await getPublicIngress(iconsPath, headers);
    const iconsObservation = lastObservation();
    expect(icons.status).toBe(200);
    expect(icons.body).toContain("# Rudder Legacy Agent Icon Names");
    expect(icons.body).toContain("- search");
    expect(iconsObservation.body).toMatchObject({ publicMethod: "GET", publicPath: iconsPath });

    const adapterPath = "/llms/agent-configuration/missing-runtime.txt";
    const adapter = await getPublicIngress(adapterPath, headers);
    const adapterObservation = lastObservation();
    expect(adapter.status).toBe(404);
    expect(adapter.body).toBe("Unknown adapter type: missing-runtime");
    expect(adapterObservation.body).toMatchObject({ publicMethod: "GET", publicPath: adapterPath });
    expect(adapterObservation.responseStatus).toBe(200);
    expect(adapterObservation.headers.actorEnvelope).toBeUndefined();
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 30_000);

  it("requires stored canCreateAgents permission for root LLM documents through Rust ingress", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const headers = {
      host,
      origin: "https://public.example",
      authorization: `Bearer ${agentToken}`,
      "x-rudder-agent-id": agentId,
      ...forgedForwardingHeaders,
    };

    await fixtureSql!`
      UPDATE agents SET permissions = '{"canCreateAgents":false,"canManageSkills":false}'::jsonb
      WHERE id = ${agentId}::uuid
    `;
    const denied = await getPublicIngress("/llms/agent-icons.txt", headers);
    expect(lastObservation().actor).toMatchObject({ type: "agent", agentId });
    expect(lastObservation().responseStatus).toBe(403);
    expect(denied.status, denied.body).toBe(403);
    expect(denied.body).toContain("ingress_authorization_rejected");

    await fixtureSql!`
      UPDATE agents SET permissions = '{"canCreateAgents":true,"canManageSkills":false}'::jsonb
      WHERE id = ${agentId}::uuid
    `;
    const allowed = await getPublicIngress("/llms/agent-icons.txt", headers);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toContain("# Rudder Legacy Agent Icon Names");
    expect(lastObservation().actor).toMatchObject({ type: "agent", agentId });
    expect(lastObservation().responseStatus).toBe(200);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 30_000);

  it.each([
    ["session", { cookie: signedSessionCookie() }, "board", "session"],
    ["non-pcp agent key", { authorization: `Bearer ${agentToken}` }, "agent", "agent_key"],
  ] as const)("keeps public GET identity native for %s despite a different CLI agent context", async (_fixture, credentials, type, source) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      ...credentials,
      "x-rudder-agent-id": "different-cli-agent",
    });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).total).toBe(3);
    expect(privateRequestCalls).toBe(0);
    expect(authorizationObservations).toHaveLength(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
    expect(source).toMatch(type === "board" ? "session" : "agent_key");
  }, 10_000);

  it.each([
    ["session", { cookie: signedSessionCookie() }, 401],
    ["non-pcp agent key", { authorization: `Bearer ${agentToken}` }, 403],
  ] as const)("retains mutation-only agent-context fence for %s", async (_fixture, credentials, status) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      ...credentials,
      "x-rudder-agent-id": "different-cli-agent",
    }, "POST");
    expect(response.status).toBe(status);
    expect(response.body).toContain(status === 401 ? "agent_auth_required" : "agent_context_mismatch");
    expect(authorizationObservations).toHaveLength(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });

  it("resolves a persisted same-organization Agent key directly and preserves its CLI context", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const publicPath = `/api/orgs/${organizationId}/members/directory?type=agent`;
    const response = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      authorization: `Bearer ${agentToken}`,
      "x-rudder-agent-id": agentId,
      "x-rudder-run-id": "run-agent-1",
      ...forgedForwardingHeaders,
    });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).items).toEqual([
      expect.objectContaining({ name: "Authorized fixture agent", type: "agent", role: "researcher" }),
    ]);
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 10_000);

  it("preserves local Agent JWT compatibility through the native public listener", async () => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${localAgentJwt}`,
      "x-rudder-agent-id": agentId,
      "x-rudder-run-id": "run-local-jwt",
    });
    expect(response.status, response.body).toBe(200);
    expect(JSON.parse(response.body).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Authorized fixture agent", type: "agent" }),
    ]));
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 10_000);

  it.each([
    ["unknown Board key", "pcp_board_wrong_token"],
    ["revoked Board key", revokedBoardToken],
    ["expired Board key", expiredBoardToken],
    ["unknown agent key", "pcp_agent_wrong_token"],
    ["revoked agent key", revokedAgentToken],
  ])("fails closed without Node fallback for invalid native %s", async (_label, token) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${token}`,
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("unauthorized");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });

  it("rejects an unknown non-pcp bearer without falling back to Node", async () => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: "Bearer legacy_unknown_public_ingress_token",
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("unauthorized");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });

  it.each(["missing", "inactive"] as const)("rejects a scoped session with %s membership", async (membership) => {
    if (membership === "missing") {
      await fixtureSql!`
        DELETE FROM organization_memberships
        WHERE org_id = ${organizationId}::uuid AND principal_type = 'user' AND principal_id = ${sessionUserId}
      `;
    } else {
      await fixtureSql!`
        UPDATE organization_memberships SET status = 'inactive'
        WHERE org_id = ${organizationId}::uuid AND principal_type = 'user' AND principal_id = ${sessionUserId}
      `;
    }
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      cookie: signedSessionCookie(),
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("forbidden");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });

  it("rejects session, Board key, and Agent identity when the public organization differs", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const publicPath = `/api/orgs/${otherOrganizationId}/members/directory`;

    const sessionResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      cookie: signedSessionCookie(),
    });
    expect(sessionResponse.status).toBe(403);
    expect(sessionResponse.body).toContain("forbidden");

    const agentResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      authorization: `Bearer ${agentToken}`,
      "x-rudder-agent-id": agentId,
    });
    expect(agentResponse.status).toBe(403);
    expect(agentResponse.body).toContain("forbidden");

    const boardResponse = await getPublicIngress(publicPath, {
      authorization: `Bearer ${boardToken}`,
    });
    expect(boardResponse.status).toBe(403);
    expect(boardResponse.body).toContain("forbidden");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 15_000);

  it("does not trust client envelope, request-id, or ingress-key headers", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const response = await getPublicIngress(
      `/api/orgs/${organizationId}/members/directory`,
      {
        host,
        origin: "https://public.example",
        "x-rudder-actor-envelope": forgedActorEnvelope,
        "x-rudder-request-id": forgedRequestId,
        "x-rudder-ingress-auth": forgedIngressKey,
        ...forgedForwardingHeaders,
      },
    );
    expect(response.status).toBe(401);
    expect(response.body).toContain("unauthorized");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  }, 10_000);

  it("gives a supplied invalid Bearer credential precedence over a valid session cookie", async () => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: "Bearer pcp_invalid_over_valid_session",
      cookie: signedSessionCookie(),
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("unauthorized");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });

  it("rejects a mismatched signed Agent JWT run header before Node", async () => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${localAgentJwt}`,
      "x-rudder-run-id": "different-signed-run",
    });
    expect(response.status).toBe(403);
    expect(response.body).toContain("agent_run_context_mismatch");
    expect(authorizationObservations).toHaveLength(0);
    expect(privateRequestCalls).toBe(0);
    expect(sessionResolverCalls).toBe(0);
    expect(boardKeyLookupCalls).toBe(0);
    expect(agentKeyLookupCalls).toBe(0);
  });
});
