import type { Db } from "@rudderhq/db";
import {
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  instanceUserRoles,
  organizationMemberships,
} from "@rudderhq/db";
import { getTableColumns, getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import express, { type Request } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { accountSessionRequired } from "../middleware/account-session-required.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/index.js";
import {
  PUBLIC_INGRESS_AUTH_ENDPOINT,
  publicIngressAuthRoutes,
} from "../routes/public-ingress-auth.js";
import { hashBearerToken } from "../services/board-auth.js";

const organizationId = "10000000-0000-0000-0000-000000000001";
const otherOrganizationId = "20000000-0000-0000-0000-000000000002";
const boardUserId = "board-user-1";
const sessionUserId = "session-user-1";
const agentId = "agent-1";
const boardToken = "legacy_board_test_public_ingress_token";
const revokedBoardToken = "legacy_board_revoked_public_ingress_token";
const expiredBoardToken = "legacy_board_expired_public_ingress_token";
const revokedAgentToken = "legacy_agent_revoked_public_ingress_token";
const agentToken = "legacy_agent_test_public_ingress_token";
const sessionCookie = "rudder-session=test-session-token";
const sessionId = "better-auth-session-1";
const ingressAuthKey = "11".repeat(32);
const actorEnvelopeKey = "22".repeat(32);
const forgedActorEnvelope = "forged-client-actor-envelope";
const forgedRequestId = "forged-client-request-id";
const forgedIngressKey = "forged-client-ingress-key";
const startupTimeoutMs = 15_000;
const serverExitTimeoutMs = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type CredentialFixture = "none" | "board-key" | "session" | "agent";
type MembershipFixture = "active" | "missing" | "inactive";

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

const credentialFixture: { current: CredentialFixture } = { current: "none" };
const membershipFixture: { current: MembershipFixture } = { current: "active" };
const authorizationObservations: AuthorizationObservation[] = [];
let authServer: Server | undefined;
let rustChild: ChildProcess | undefined;
let rustStdout: Interface | undefined;
let rustStderr = "";
let publicPort: number | undefined;

const agentKeyHash = createHash("sha256").update(agentToken).digest("hex");
const revokedAgentKeyHash = createHash("sha256").update(revokedAgentToken).digest("hex");
const dialect = new PgDialect();

// Compile the candidate source in this checkout. CI reuses its native:build
// release cache; local checks reuse debug. Arbitrary executable overrides are
// deliberately unsupported, so a stale or unrelated binary cannot satisfy it.
async function buildSourceBinary(): Promise<string> {
  const args = ["build", "--locked", "--manifest-path", resolve(repositoryRoot, "native/Cargo.toml"),
    "--bin", "rudder-server-foundation", "--message-format=json"];
  if (process.env.CI) args.push("--release");
  const child = spawn(process.platform === "win32" ? "cargo.exe" : "cargo", args, {
    cwd: repositoryRoot,
    env: process.env,
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

type SqlPredicate = { column: string; kind: "eq"; value: unknown } | { column: string; kind: "is-null" };

function predicatesFromDrizzleCondition(condition: Parameters<typeof dialect.sqlToQuery>[0]): SqlPredicate[] {
  const query = dialect.sqlToQuery(condition);
  const predicates: SqlPredicate[] = [];
  const equalityPattern = /"([^"]+)"\."([^"]+)"\s*=\s*\$(\d+)/giu;
  const nullPattern = /"([^"]+)"\."([^"]+)"\s+is\s+null/giu;
  let remainder = query.sql.replace(equalityPattern, (_match, table: string, column: string, index: string) => {
    predicates.push({ column: `${table}.${column}`, kind: "eq", value: query.params[Number(index) - 1] });
    return "";
  });
  remainder = remainder.replace(nullPattern, (_match, table: string, column: string) => {
    predicates.push({ column: `${table}.${column}`, kind: "is-null" });
    return "";
  });
  remainder = remainder.replace(/\band\b/giu, "").replace(/[()\s]/gu, "");
  if (remainder !== "" || predicates.length === 0) {
    throw new Error(`Unsupported Drizzle auth predicate: ${query.sql}`);
  }
  return predicates;
}

function rowsForTable(table: unknown): Record<string, unknown>[] {
  if (table === boardApiKeys) {
    const future = new Date(Date.now() + 60_000);
    return [
      {
        id: "board-key-1",
        userId: boardUserId,
        keyHash: hashBearerToken(boardToken),
        revokedAt: null,
        expiresAt: future,
      },
      {
        id: "board-key-revoked",
        userId: boardUserId,
        keyHash: hashBearerToken(revokedBoardToken),
        revokedAt: new Date(),
        expiresAt: future,
      },
      {
        id: "board-key-expired",
        userId: boardUserId,
        keyHash: hashBearerToken(expiredBoardToken),
        revokedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      },
    ];
  }
  if (table === agentApiKeys) {
    return [
      { id: "agent-key-1", keyHash: agentKeyHash, agentId, orgId: organizationId, revokedAt: null },
      { id: "agent-key-revoked", keyHash: revokedAgentKeyHash, agentId, orgId: organizationId, revokedAt: new Date() },
    ];
  }
  if (table === agents) return [{ id: agentId, orgId: organizationId, status: "active" }];
  if (table === authUsers) {
    return [
      { id: boardUserId, name: "Board fixture", email: null },
      { id: sessionUserId, name: "Session fixture", email: null },
    ];
  }
  if (table === organizationMemberships) {
    const rows: Record<string, unknown>[] = [
      { orgId: organizationId, principalType: "user", principalId: sessionUserId, status: "active" },
    ];
    if (membershipFixture.current !== "missing") {
      rows.push({
        orgId: organizationId,
        principalType: "user",
        principalId: boardUserId,
        status: membershipFixture.current === "active" ? "active" : "inactive",
      });
    }
    return rows;
  }
  if (table === instanceUserRoles) return [];
  return [];
}

function filterRowsByDrizzleCondition(
  table: unknown,
  rows: Record<string, unknown>[],
  predicates: SqlPredicate[],
) {
  const schemaTable = table as never;
  const tableName = getTableName(schemaTable);
  const columns = Object.entries(getTableColumns(schemaTable));
  return rows.filter((row) => predicates.every((predicate) => {
    const [predicateTable, columnName] = predicate.column.split(".");
    if (predicateTable !== tableName) {
      throw new Error(`Drizzle predicate table ${predicateTable} does not match ${tableName}`);
    }
    const property = columns.find(([, column]) => column.name === columnName)?.[0];
    if (!property) throw new Error(`No ${tableName} schema column named ${columnName}`);
    const value = row[property];
    return predicate.kind === "eq" ? value === predicate.value : value === null;
  }));
}

function createAuthLookupDb(): Db {
  const db = {
    select() {
      let table: unknown;
      let predicates: SqlPredicate[] = [];
      const query = {
        from(selectedTable: unknown) {
          table = selectedTable;
          return query;
        },
        where(condition: Parameters<typeof dialect.sqlToQuery>[0]) {
          predicates = predicatesFromDrizzleCondition(condition);
          return query;
        },
        then(
          onfulfilled: (rows: unknown[]) => unknown,
          onrejected?: (error: unknown) => unknown,
        ) {
          const rows = rowsForTable(table);
          return Promise.resolve(filterRowsByDrizzleCondition(table, rows, predicates)).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
    update() {
      return {
        set() {
          return { where: () => Promise.resolve([]) };
        },
      };
    },
  };
  return db as unknown as Db;
}

function createPrivateAuthApp() {
  const app = express();
  app.use(express.json({
    limit: "32kb",
    verify: (req, _res, body) => {
      (req as Request).rawBody = Buffer.from(body);
    },
  }));
  app.use(actorMiddleware(createAuthLookupDb(), {
    deploymentMode: "authenticated",
    authRequirement: "required",
    resolveSession: async (req) => {
      if (credentialFixture.current !== "session" || req.get("cookie") !== sessionCookie) {
        return null;
      }
      return {
        session: { id: sessionId, userId: sessionUserId },
        user: { id: sessionUserId },
      };
    },
  }));
  app.use((req, res, next) => {
    if (req.originalUrl === PUBLIC_INGRESS_AUTH_ENDPOINT) {
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
  return new Promise<{ status: number; body: string }>((resolveResponse, rejectResponse) => {
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
      res.on("end", () => resolveResponse({ status: res.statusCode ?? 0, body }));
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

describe("source-binary public Actix to private Node auth workflow", () => {
  beforeAll(async () => {
    const binaryPath = await buildSourceBinary();
    authServer = createPrivateAuthApp().listen(0, "127.0.0.1");
    await once(authServer, "listening");
    const upstreamAddress = authServer.address() as AddressInfo;

    rustChild = spawn(binaryPath, [], {
      env: {
        PATH: process.env.PATH ?? "",
        RUST_LOG: "error",
        RUDDER_NATIVE_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_DATABASE_REQUIRED: "false",
        RUDDER_NATIVE_ACTOR_ENVELOPE_KEY: actorEnvelopeKey,
        RUDDER_NATIVE_PUBLIC_LISTEN: "127.0.0.1:0",
        RUDDER_NATIVE_NODE_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        RUDDER_NATIVE_INGRESS_AUTH_KEY: ingressAuthKey,
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
  }, 600_000);

  beforeEach(() => {
    credentialFixture.current = "none";
    membershipFixture.current = "active";
    authorizationObservations.length = 0;
  });

  afterAll(async () => {
    await stopRustChild();
    if (authServer) {
      await new Promise<void>((resolveClose, rejectClose) => {
        authServer?.close((error) => error ? rejectClose(error) : resolveClose());
      });
      authServer = undefined;
    }
  });

  it("resolves predicate-checked Board keys and injected sessions through the public Actix request", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const publicPath = `/api/orgs/${organizationId}/members/directory?type=agent&limit=25&query=R%26D+team&unused=1`;

    for (const scenario of [
      {
        fixture: "board-key" as const,
        headers: { authorization: `Bearer ${boardToken}` },
        actor: { type: "board", source: "board_key", userId: boardUserId },
      },
      {
        fixture: "session" as const,
        headers: { cookie: sessionCookie },
        actor: { type: "board", source: "session", userId: sessionUserId, sessionId },
      },
    ]) {
      credentialFixture.current = scenario.fixture;
      const response = await getPublicIngress(publicPath, {
        host,
        origin: "https://public.example",
        ...forgedForwardingHeaders,
        ...scenario.headers,
      });
      const observation = lastObservation();

      expect(response.status).toBe(503);
      expect(response.body).toContain("database_disabled");
      expect(observation.actor).toMatchObject(scenario.actor);
      expect(observation.responseStatus).toBe(200);
      expect(observation.body).toMatchObject({ organizationId, publicPath });
      expectOriginalRequestContext(observation, host);
      expectSocketForwardingContext(observation);
      expect(observation.headers.authorization).toBe(scenario.headers.authorization);
      expect(observation.headers.cookie).toBe(scenario.headers.cookie);
    }
  }, 20_000);

  it.each([
    ["board-key", { authorization: `Bearer ${boardToken}` }, "board", "board_key"],
    ["session", { cookie: sessionCookie }, "board", "session"],
    ["agent", { authorization: `Bearer ${agentToken}` }, "agent", "agent_key"],
  ] as const)("preserves public GET semantics for %s with a different CLI agent context", async (fixture, credentials, type, source) => {
    credentialFixture.current = fixture;
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      ...credentials,
      "x-rudder-agent-id": "different-cli-agent",
    });
    expect(response.status).toBe(503);
    expect(response.body).toContain("database_disabled");
    expect(lastObservation().actor).toMatchObject({ type, source });
    expect(lastObservation().responseStatus).toBe(200);
    expect(lastObservation().headers.agentId).toBe("different-cli-agent");
  }, 10_000);

  it.each([
    [boardToken, 401],
    [agentToken, 403],
  ] as const)("retains mutation-only agent-context fences for token %s", async (token, status) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${token}`,
      "x-rudder-agent-id": "different-cli-agent",
    }, "POST");
    expect(response.status).toBe(status);
    expect(response.body).toContain(token === boardToken ? "agent_auth_required" : "agent_context_mismatch");
    expect(authorizationObservations).toHaveLength(0);
  });

  it("resolves a predicate-checked same-organization agent and preserves its CLI context", async () => {
    credentialFixture.current = "agent";
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
    const observation = lastObservation();

    expect(response.status).toBe(503);
    expect(response.body).toContain("database_disabled");
    expect(observation.actor).toMatchObject({
      type: "agent",
      source: "agent_key",
      orgId: organizationId,
      agentId,
      runId: "run-agent-1",
    });
    expect(observation.responseStatus).toBe(200);
    expect(observation.body).toMatchObject({ organizationId, publicPath });
    expectOriginalRequestContext(observation, host);
    expectSocketForwardingContext(observation);
    expect(observation.headers.authorization).toBe(`Bearer ${agentToken}`);
    expect(observation.headers.agentId).toBe(agentId);
    expect(observation.headers.runId).toBe("run-agent-1");
  }, 10_000);

  it.each([
    ["Board-style", "pcp_board_unknown_public_ingress_token"],
    ["agent-style", "pcp_agent_unknown_public_ingress_token"],
  ])("fails closed for an unknown native %s key without a Node grant request", async (_label, token) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${token}`,
    });

    expect(response.status).toBe(503);
    expect(response.body).toContain("database_disabled");
    expect(authorizationObservations).toHaveLength(0);
  });

  it.each([
    ["wrong Board token", "legacy_board_wrong_token"],
    ["wrong agent token", "legacy_agent_wrong_token"],
    ["revoked Board key", revokedBoardToken],
    ["expired Board key", expiredBoardToken],
    ["revoked agent key", revokedAgentToken],
  ])("rejects %s despite other valid seeded credentials", async (_label, token) => {
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${token}`,
    });
    const observation = lastObservation();
    expect(response.status).toBe(401);
    expect(observation.actor.type).toBe("none");
    expect(observation.responseStatus).toBe(401);
  });

  it.each(["missing", "inactive"] as const)("rejects a Board key with %s membership", async (membership) => {
    membershipFixture.current = membership;
    const response = await getPublicIngress(`/api/orgs/${organizationId}/members/directory`, {
      authorization: `Bearer ${boardToken}`,
    });
    const observation = lastObservation();
    expect(observation.actor).toMatchObject({ type: "board", source: "board_key", orgIds: [] });
    expect(response.status).toBe(403);
    expect(observation.responseStatus).toBe(403);
  });

  it("rejects a scoped session and an agent when the public organization differs", async () => {
    const port = publicPort;
    if (port === undefined) throw new Error("Public Actix listener is not started");
    const host = `public.example:${port}`;
    const publicPath = `/api/orgs/${otherOrganizationId}/members/directory`;

    credentialFixture.current = "session";
    const sessionResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      cookie: sessionCookie,
    });
    const sessionObservation = lastObservation();
    expect(sessionResponse.status).toBe(403);
    expect(sessionObservation.actor).toMatchObject({ type: "board", source: "session" });
    expect(sessionObservation.responseStatus).toBe(403);
    expect(sessionResponse.body).toContain("ingress_authorization_rejected");

    credentialFixture.current = "agent";
    const agentResponse = await getPublicIngress(publicPath, {
      host,
      origin: "https://public.example",
      authorization: `Bearer ${agentToken}`,
      "x-rudder-agent-id": agentId,
    });
    const agentObservation = lastObservation();
    expect(agentResponse.status).toBe(403);
    expect(agentObservation.actor).toMatchObject({ type: "agent", orgId: organizationId, agentId });
    expect(agentObservation.responseStatus).toBe(403);
    expect(agentResponse.body).toContain("ingress_authorization_rejected");
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
    const observation = lastObservation();

    expect(response.status).toBe(401);
    expect(response.body).toContain("ingress_authorization_rejected");
    expect(observation.actor.type).toBe("none");
    expect(observation.responseStatus).toBe(401);
    expectOriginalRequestContext(observation, host);
    expectSocketForwardingContext(observation);
    expect(observation.headers.ingressAuth).not.toBe(forgedIngressKey);
  }, 10_000);
});
