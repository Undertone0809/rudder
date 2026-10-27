import {
  agentApiKeys, agents, applyPendingMigrations, approvals, authUsers, boardApiKeys, createDb,
  createLocalPostgresInstance, ensurePostgresDatabase, organizationMemberships, organizations, requests,
  type LocalPostgresInstance,
} from "@rudderhq/db";
import { listRequestsQuerySchema } from "@rudderhq/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import express from "express";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { redactApprovalPayload } from "../redaction.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { requestRoutes } from "../routes/requests.js";
import { requestRequestRead } from "../services/request-read-bridge.js";
import { requestService } from "../services/requests.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";

vi.mock("../services/index.js", async (original) => {
  const services = await original<typeof import("../services/index.js")>();
  const forbidden = () => { throw new Error("Node Request GET business reader must not execute"); };
  return { ...services, requestService: (...args: Parameters<typeof requestService>) => ({
    ...services.requestService(...args), getById: forbidden, list: forbidden, attemptsForRequest: forbidden,
  }) };
});

// Frozen Node GET oracle, copied from the three routes exercised before cutover.
// Its service and redactor remain the real unchanged implementations.
function legacyRoutes(db: ReturnType<typeof createDb>) {
  const router = express.Router(), svc = requestService(db);
  router.get("/orgs/:orgId/requests", async (req, res) => {
    const orgId = req.params.orgId as string;
    assertCompanyAccess(req, orgId);
    const query = listRequestsQuerySchema.parse(req.query);
    const result = await svc.list(orgId, query);
    res.json(result.map((row) => row.kind === "approval" ? redactApprovalPayload(row as typeof row & { payload: Record<string, unknown> }) : row));
  });
  router.get("/requests/:id", async (req, res) => {
    const row = await svc.getById(req.params.id as string);
    if (!row) { res.status(404).json({ error: "Request not found" }); return; }
    assertCompanyAccess(req, row.orgId as string);
    res.json(row.kind === "approval" ? redactApprovalPayload(row as typeof row & { payload: Record<string, unknown> }) : row);
  });
  router.get("/requests/:id/block-audit-attempts", async (req, res) => {
    const row = await svc.getById(req.params.id as string);
    if (!row) { res.status(404).json({ error: "Request not found" }); return; }
    assertCompanyAccess(req, row.orgId as string);
    if (row.kind !== "assistance") { res.status(422).json({ error: "Only Assistance Requests have Block Audit attempts" }); return; }
    res.json(await svc.attemptsForRequest(row.orgId as string, row.id as string));
  });
  return router;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function canonicalUtcMilliseconds(timestamp: string): number | null {
  if (timestamp === "infinity" || timestamp === "-infinity" || timestamp.endsWith(" BC")) return null;
  const match = timestamp.match(/^(\d+)-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/);
  if (!match) return null;
  const year = Number(match[1]);
  if (year < 1) return null;
  const yearText = year >= 10_000 ? `+${String(year).padStart(6, "0")}` : String(year).padStart(4, "0");
  const millisecond = (match[7] ?? "").slice(0, 3).padEnd(3, "0");
  const iso = `${yearText}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${millisecond}Z`;
  const value = Date.parse(iso);
  return Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000_000 ? value : null;
}

function canonicalUtcTimestamp(timestamp: string): string | null {
  const milliseconds = canonicalUtcMilliseconds(timestamp);
  return milliseconds === null ? null : new Date(milliseconds).toISOString();
}

// These cases first ran against the unchanged Node public route. They pin the
// ordering and authorization traps before the Rust implementation is exercised.
const modes = process.env.RUDDER_REQUEST_NODE_ORACLE_ONLY === "1" ? ["node"] as const : ["off", "required"] as const;
describe.each(modes)("Request read real public contract (ingress %s)", (mode) => {
  let db: ReturnType<typeof createDb>;
  let postgres: LocalPostgresInstance | undefined;
  let server: Server | undefined;
  let oracleServer: Server | undefined;
  let target: Server | string;
  let bridge: RustFoundationBridge | undefined;
  let directory = "";
  const org = randomUUID(), other = randomUUID(), orderingOrg = randomUUID(), payloadOrg = randomUUID();
  const agent = randomUUID(), orderingAgent = randomUUID(), payloadAgent = randomUUID();
  const token = `request-reader-${randomUUID()}`, orderingToken = `request-order-${randomUUID()}`;
  const collision = randomUUID(), mixed = randomUUID(), mixedApproval = randomUUID();
  const nativeIdentity = nativeIdentityIngressFixture();
  const auditedRequest = randomUUID(), userId = randomUUID(), boardToken = `request-board-${randomUUID()}`;
  const payloadToken = `request-payload-${randomUUID()}`;
  const dates = [
    "10000-01-01 00:00:00Z", "0001-01-01 00:00:00Z", "0032-01-01 00:00:00Z", "0099-01-01 00:00:00Z",
    "0001-01-01 00:00:00Z BC", "1969-12-31 23:59:59.999999Z", "infinity",
    "275760-09-12 23:59:59.999999Z", "275760-09-13 00:00:00Z", "275760-09-13 00:00:00.000001Z",
    "275760-09-13 00:00:00.000999Z", "275760-09-13 00:00:00.001Z",
  ].map((timestamp) => ({ timestamp, id: randomUUID() }));
  const payloads = [
    ["root-array", '["a.b.c",{"password":"hide"}]'],
    ["root-string", '"literal"'], ["null", "null"], ["false", "false"], ["zero", "0"], ["empty", '\"\"'],
    ["overflow", "1e400"], ["underflow", "1e-400"],
    ["reparsed-object", JSON.stringify('{"password":"hide","safe":9007199254740993}')],
    ["reparsed-null", JSON.stringify("null")],
    ["bindings", '{"password":{"type":"secret_ref","secretId":"id","password":"keep"},"safe":{"type":"plain","value":{"password":"hide"},"extra":"drop"},"secret":{"type":"plain","value":"hide","extra":"drop"}}'],
    ["root-binding", '{"type":"secret_ref","secretId":"id","password":"hide"}'],
    ["jwt", '{"object":"a.b.c","array":["a.b.c",{"object":"a.b.c"}]}'],
    ["proto", '{"__proto__":{"x":1},"nested":{"__proto__":{"x":2},"safe":"ok"},"binding":{"type":"secret_ref","secretId":"id","__proto__":{}}}'],
    ["sentinels", '{"$serde_json::private::Number":"123","$serde_json::private::RawValue":"not parsed","big":9007199254740993}'],
    ["reparsed-deep", JSON.stringify('{"nested":'.repeat(600) + '{"password":"hide","big":9007199254740993}' + '}'.repeat(600))],
    ["deep", '{"nested":'.repeat(600) + '{"password":"hide","big":9007199254740993}' + '}'.repeat(600)],
  ].map(([name, raw]) => ({ name, raw: raw!, id: randomUUID() }));
  const low = "30000000-0000-4000-8000-000000000001";
  const high = "30000000-0000-4000-8000-000000000002";
  const get = (url: string, credential = token) => request(target).get(`/api${url}`).set("authorization", `Bearer ${credential}`);

  beforeAll(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-request-read-postgres-"));
    const port = await freePort();
    const selection = await createLocalPostgresInstance({
      databaseDir: directory, user: "rudder", password: "rudder", port,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => {}, onError: () => {},
    });
    postgres = selection.instance;
    await postgres.initialise();
    fs.appendFileSync(path.join(directory, "postgresql.conf"), "\nunix_socket_directories = ''\nlisten_addresses = '127.0.0.1'\nshared_buffers = '16MB'\n");
    await postgres.start();
    const url = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${port}/postgres`, "rudder");
    await applyPendingMigrations(url);
    db = createDb(url);
    await db.execute(sql.raw(`ALTER DATABASE rudder SET timezone TO '${process.env.RUDDER_REQUEST_ORACLE_TIMEZONE === "UTC" ? "UTC" : "Pacific/Honolulu"}'`));
    await db.$client.end({ timeout: 5 });
    db = createDb(url);
    await db.insert(organizations).values([org, other, orderingOrg, payloadOrg].map((id, index) => ({ id, name: `Requests ${index}`, urlKey: `requests-${index}`, issuePrefix: `REQ${index}` })));
    await db.insert(agents).values([{ id: agent, orgId: org, name: "Reader", role: "general", status: "idle" }, { id: orderingAgent, orgId: orderingOrg, name: "Order reader", role: "general", status: "idle" }, { id: payloadAgent, orgId: payloadOrg, name: "Payload reader", role: "general", status: "idle" }]);
    await db.insert(agentApiKeys).values([{ orgId: org, agentId: agent, name: "Read", keyHash: createHash("sha256").update(token).digest("hex") }, { orgId: orderingOrg, agentId: orderingAgent, name: "Read", keyHash: createHash("sha256").update(orderingToken).digest("hex") }, { orgId: payloadOrg, agentId: payloadAgent, name: "Read", keyHash: createHash("sha256").update(payloadToken).digest("hex") }]);
    await db.insert(requests).values([
      { id: collision, orgId: other, kind: "assistance", subtype: "issue_blocker", title: "Foreign assistance wins", prompt: "Input" },
      { id: mixed, orgId: org, kind: "legacy", subtype: "legacy", title: "Mixed table kind", prompt: "Input" },
      { id: mixedApproval, orgId: payloadOrg, kind: "approval", subtype: "legacy", title: "Approval kind in requests", prompt: "Input" },
      { id: low, orgId: orderingOrg, kind: "assistance", subtype: "issue_blocker", title: "Later milliseconds, lower ID", prompt: "Input", updatedAt: new Date("2026-10-12T01:00:00.900Z") },
    ]);
    await db.insert(approvals).values([
      { id: collision, orgId: org, type: "hire_agent", payload: {} },
      { id: high, orgId: orderingOrg, type: "hire_agent", payload: {}, updatedAt: new Date("2026-10-12T01:00:00.100Z") },
    ]);
    for (const value of payloads) {
      await db.execute(sql`INSERT INTO approvals (id,org_id,type,payload) VALUES (${value.id}::uuid,${payloadOrg}::uuid,'hire_agent',${value.raw}::jsonb)`);
    }
    for (const { id, timestamp } of dates) {
      await db.execute(sql`INSERT INTO approvals (id,org_id,type,payload,created_at,decided_at) VALUES (${id}::uuid,${payloadOrg}::uuid,'hire_agent','{}',${timestamp}::timestamptz,${timestamp}::timestamptz)`);
    }
    await db.insert(authUsers).values({ id: userId, name: "Request reader", email: "request-reader@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(organizationMemberships).values([org, payloadOrg].map((orgId) => ({ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values({ userId, name: "Requests", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    for (const status of ["pending", "revision_requested", "approved", "rejected", "cancelled", "unknown_legacy_status"]) {
      await db.insert(approvals).values({ orgId: payloadOrg, type: "chat_operation", status, payload: { label: status } });
    }
    for (const status of ["open", "resolved", "cancelled", "superseded"]) {
      await db.insert(requests).values({ orgId: payloadOrg, kind: "assistance", subtype: "issue_blocker", status, title: status, prompt: "Input" });
    }
    await db.insert(requests).values({ id: auditedRequest, orgId: payloadOrg, kind: "assistance", subtype: "issue_blocker", title: "Audit", prompt: "Input" });
    const issue = randomUUID(), runs = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await db.execute(sql`INSERT INTO issues (id,org_id,title) VALUES (${issue}::uuid,${payloadOrg}::uuid,'Block audit')`);
    for (const [index, run] of runs.entries()) {
      await db.execute(sql`INSERT INTO heartbeat_runs (id,org_id,agent_id,status) VALUES (${run}::uuid,${payloadOrg}::uuid,${payloadAgent}::uuid,'succeeded')`);
      await db.execute(sql`INSERT INTO issue_block_audit_attempts (org_id,issue_id,request_id,run_id,root_run_id,agent_id,continuation_kind,failure_class,blocker_fingerprint,attempt_number,required_attempts,status_before,status_after,blocker_reason,requested_action)
        VALUES (${index === 3 ? other : payloadOrg}::uuid,${issue}::uuid,${auditedRequest}::uuid,${run}::uuid,${runs[0]}::uuid,${payloadAgent}::uuid,'initial','issue','fingerprint',${[3, 1, 2, 0][index]},3,'in_progress','in_progress','Input','Help')`);
    }
    function app(oracle: boolean) {
      const app = express();
      if (!oracle && mode === "required") app.use(nativeIdentity.middleware());
      app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
      app.use("/api", oracle ? legacyRoutes(db) : requestRoutes(db, bridge));
      app.use(errorHandler);
      return app;
    }
    oracleServer = app(true).listen(0, "127.0.0.1");
    await once(oracleServer, "listening");
    if (mode === "node") { target = oracleServer; return; }
    const listenPort = await freePort();
    const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryTarget = path.resolve(repoRoot, process.env.CARGO_TARGET_DIR ?? "native/target");
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary ? [path.resolve(repoRoot, explicitBinary)]
      : [path.join(binaryTarget, "debug", binaryName), path.join(binaryTarget, "release", binaryName)];
    const binary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    bridge = createRustFoundationBridge({ databaseUrl: url, binaryPath: binary, mode: "off", projectGoalSetMode: "off", organizationBrandingMode: "off", requestTimeoutMs: 10_000,
      ...(mode === "required" ? { publicIngress: { identityAuth: nativeIdentity.identityAuth, listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${listenPort}`, authorizationKey: "request-read-ingress-test-key-32-bytes" } } : {}),
    });
    server = app(false).listen(listenPort, "127.0.0.1");
    await once(server, "listening");
    await bridge.start();
    target = server;
    if (mode === "required") { await bridge.waitForPublicIngressReady!(); target = bridge.publicIngressBaseUrl!; }
  }, 120_000);

  afterAll(async () => {
    try {
      if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); }
      if (oracleServer) { oracleServer.closeAllConnections(); await new Promise<void>((resolve, reject) => oracleServer!.close((error) => error ? reject(error) : resolve())); }
      await bridge?.close();
      await db?.$client.end({ timeout: 5 });
      await postgres?.stop();
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects assistance before approval across organizations, before checking access", async () => {
    for (const suffix of ["", "/block-audit-attempts"]) {
      const response = await get(`/requests/${collision}${suffix}`);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "Agent key cannot access another organization" });
    }
  });
  it("uses descending ID after the accepted whole UTC second key", async () => {
    const response = await get(`/orgs/${orderingOrg}/requests`, orderingToken);
    expect(response.status).toBe(200);
    expect(response.body.map((row: { id: string }) => row.id)).toEqual([high, low]);
    expect(response.body.map((row: { updatedAt: string }) => row.updatedAt)).toEqual(["2026-10-12T01:00:00.100Z", "2026-10-12T01:00:00.900Z"]);
  });
  it("selects the requests table for assistance filtering without inventing a row-kind filter", async () => {
    const response = await get(`/orgs/${org}/requests?kind=assistance`);
    expect(response.status).toBe(200);
    expect(response.body.map((row: { id: string; kind: string }) => [row.id, row.kind])).toEqual([[mixed, "legacy"]]);
    const approvalOnly = await get(`/orgs/${org}/requests?kind=approval`);
    expect(approvalOnly.body.map((row: { id: string }) => row.id)).toEqual([collision]);
    const attempts = await get(`/requests/${mixed}/block-audit-attempts`);
    expect(attempts.status).toBe(422);
    expect(attempts.body).toEqual({ error: "Only Assistance Requests have Block Audit attempts" });
  });
  it.each(payloads)("pairs the real approval redaction boundary: $name", async ({ id }) => {
    const actual = await get(`/requests/${id}`, payloadToken);
    const expected = await request(oracleServer!).get(`/api/requests/${id}`).set("authorization", `Bearer ${payloadToken}`);
    expect(expected.status).toBe(200);
    expect(actual.status).toBe(expected.status);
    expect(actual.body).toEqual(expected.body);
  });
  it.each(dates)("projects historical timestamps as canonical UTC: $timestamp", async ({ id, timestamp }) => {
    const actual = await get(`/requests/${id}`, payloadToken);
    const oracle = await request(oracleServer!).get(`/api/requests/${id}`).set("authorization", `Bearer ${payloadToken}`);
    expect(actual.status).toBe(oracle.status);
    const expected = mode === "node" ? oracle.body : {
      ...oracle.body,
      createdAt: canonicalUtcTimestamp(timestamp),
      decidedAt: canonicalUtcTimestamp(timestamp),
    };
    expect(actual.body).toEqual(expected);
  });
  it.each([
    ["remapped year", ["0032-01-01 00:00:00Z", "2026-01-01 00:00:00Z"]],
    ["invalid first", ["infinity", "2024-01-01 00:00:00Z", "2026-01-01 00:00:00Z"]],
    ["invalid middle", ["2024-01-01 00:00:00Z", "infinity", "2026-01-01 00:00:00Z"]],
    ["assistance invalid head", ["infinity", "2024-01-01 00:00:00Z", "2026-01-01 00:00:00Z"]],
    ["Tokyo historical transition", ["1887-12-31 14:59:59Z", "1887-12-31 15:00:00Z"]],
    ["negative subsecond floor", ["1969-12-31 23:59:59.999999Z", "1970-01-01 00:00:00Z"]],
    ["all invalid", ["infinity", "-infinity", "275760-09-13 00:00:00.001Z"]],
  ] as const)("orders Request rows by canonical UTC timestamps: %s", async (_name, timestamps) => {
    const selectedOrg = randomUUID(), selectedAgent = randomUUID(), credential = `date-${randomUUID()}`;
    await db.insert(organizations).values({ id: selectedOrg, name: "Dates", urlKey: `dates-${selectedOrg}`, issuePrefix: `DT${selectedOrg.slice(0, 8).toUpperCase()}` });
    await db.insert(agents).values({ id: selectedAgent, orgId: selectedOrg, name: "Date reader", role: "general", status: "idle" });
    await db.insert(agentApiKeys).values({ orgId: selectedOrg, agentId: selectedAgent, name: "Dates", keyHash: createHash("sha256").update(credential).digest("hex") });
    const ids = _name === "negative subsecond floor" ? ["85000000-0000-4000-8000-000000000002", "85000000-0000-4000-8000-000000000001"] : timestamps.map(() => randomUUID());
    for (const [index, timestamp] of timestamps.entries()) {
      if (_name === "assistance invalid head" && index === 0) {
        await db.execute(sql`INSERT INTO requests (id,org_id,kind,subtype,title,prompt,updated_at) VALUES (${ids[index]}::uuid,${selectedOrg}::uuid,'assistance','issue_blocker','Date','Input',${timestamp}::timestamptz)`);
      } else {
        await db.execute(sql`INSERT INTO approvals (id,org_id,type,payload,updated_at) VALUES (${ids[index]}::uuid,${selectedOrg}::uuid,'hire_agent','{}',${timestamp}::timestamptz)`);
      }
    }
    const rawRows = [...await db.select().from(requests).where(eq(requests.orgId, selectedOrg)).orderBy(desc(requests.updatedAt), desc(requests.id)), ...await db.select().from(approvals).where(eq(approvals.orgId, selectedOrg))];
    console.info("Legacy Request before-sort dates", _name, rawRows.map((row) => [timestamps[ids.indexOf(row.id)], String(row.updatedAt), new Date(String(row.updatedAt)).getTime()]));
    const expected = await request(oracleServer!).get(`/api/orgs/${selectedOrg}/requests`).set("authorization", `Bearer ${credential}`);
    console.info("Legacy Request date order", _name, expected.body.map((row: { id: string }) => timestamps[ids.indexOf(row.id)]));
    const actual = await get(`/orgs/${selectedOrg}/requests`, credential);
    expect(actual.status).toBe(expected.status);
    const values = new Map(expected.body.map((row: { id: string }) => {
      const dateIndex = ids.indexOf(row.id);
      const timestamp = timestamps[dateIndex];
      return [row.id, mode === "node" ? row : { ...row, updatedAt: canonicalUtcTimestamp(timestamp) }];
    }));
    const ordered = [...rawRows].sort((a, b) => {
      const aMs = canonicalUtcMilliseconds(timestamps[ids.indexOf(a.id)]!), bMs = canonicalUtcMilliseconds(timestamps[ids.indexOf(b.id)]!);
      const aValid = aMs !== null, bValid = bMs !== null;
      if (aValid !== bValid) return aValid ? -1 : 1;
      if (aMs !== null && bMs !== null && Math.floor(aMs / 1000) !== Math.floor(bMs / 1000)) return Math.floor(bMs / 1000) - Math.floor(aMs / 1000);
      return b.id.localeCompare(a.id);
    });
    expect(actual.body).toEqual(mode === "node" ? expected.body : ordered.map((row) => values.get(row.id)));
  });
  it("preserves malformed UUID failures and requests-table approval projection", async () => {
    for (const suffix of ["", "/block-audit-attempts"]) {
      const response = await get(`/requests/not-a-uuid${suffix}`);
      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: "Internal server error" });
    }
    const response = await get(`/requests/${mixedApproval}`, payloadToken);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: mixedApproval, kind: "approval", subtype: "legacy", payload: {} });
    expect(response.body).not.toHaveProperty("requestStatus");
  });

  async function snapshot() {
    const output: Record<string, unknown> = {};
    for (const table of ["requests", "approvals", "issue_block_audit_attempts", "issues", "heartbeat_runs", "activity_log", "organization_mutation_state", "organization_mutation_receipts"]) {
      const rows = await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text value FROM ${table} t`));
      output[table] = rows[0]?.value;
    }
    return output;
  }
  async function pair(url: string, credential = payloadToken) {
    const expected = await request(oracleServer!).get(`/api${url}`).set("authorization", `Bearer ${credential}`);
    const actual = await get(url, credential);
    expect(actual.status).toBe(expected.status);
    // The accepted canonical UTC contract also applies when historical rows
    // occur in lists. Keep every other field and the legacy row order intact.
    const expectedBody = mode !== "node" && Array.isArray(expected.body)
      ? expected.body.map((row: Record<string, unknown>) => {
        const fixture = dates.find(({ id }) => id === row.id);
        return fixture ? { ...row, createdAt: canonicalUtcTimestamp(fixture.timestamp), decidedAt: canonicalUtcTimestamp(fixture.timestamp) } : row;
      }) : expected.body;
    expect(actual.body).toEqual(expectedBody);
    return actual;
  }
  it("preserves list status and kind selection without changing domain state", async () => {
    const before = await snapshot();
    for (const status of [undefined, "open", "resolved", "cancelled", "superseded"]) {
      for (const kind of [undefined, "assistance", "approval"]) {
        const filters = new URLSearchParams();
        if (status) filters.set("status", status);
        if (kind) filters.set("kind", kind);
        await pair(`/orgs/${payloadOrg}/requests?${filters}`);
      }
    }
    expect(await snapshot()).toEqual(before);
  });
  it("pairs attempts ascending order, foreign-row exclusion, and missing or wrong-kind errors", async () => {
    const before = await snapshot();
    const attempts = await pair(`/requests/${auditedRequest}/block-audit-attempts`);
    expect(attempts.body.map((row: { attemptNumber: number }) => row.attemptNumber)).toEqual([1, 2, 3]);
    for (const suffix of ["", "/block-audit-attempts"]) {
      const missing = await pair(`/requests/${randomUUID()}${suffix}`);
      expect(missing.status).toBe(404);
    }
    expect((await pair(`/requests/${payloads[0]!.id}/block-audit-attempts`)).status).toBe(422);
    expect(await snapshot()).toEqual(before);
  });
  it("rechecks current board membership and preserves real anonymous and foreign authorization", async () => {
    const paths = [`/orgs/${payloadOrg}/requests`, `/requests/${auditedRequest}`, `/requests/${auditedRequest}/block-audit-attempts`];
    for (const url of paths) expect((await pair(url, boardToken)).status).toBe(200);
    await db.update(organizationMemberships).set({ status: "inactive" }).where(and(eq(organizationMemberships.orgId, payloadOrg), eq(organizationMemberships.principalId, userId)));
    try { for (const url of paths) expect((await pair(url, boardToken)).status).toBe(403); }
    finally { await db.update(organizationMemberships).set({ status: "active" }).where(and(eq(organizationMemberships.orgId, payloadOrg), eq(organizationMemberships.principalId, userId))); }
    for (const url of paths) {
      expect((await request(target).get(`/api${url}`)).status).toBe(401);
      expect((await get(url)).status).toBe(403);
    }
    for (const query of ["status=bogus", "kind=bogus", "status=", "kind=", "status=open&status=resolved", "kind=approval&kind=assistance", "status=bogus&kind=bogus"]) {
      expect((await pair(`/orgs/${payloadOrg}/requests?${query}`)).status).toBe(400);
    }
  });
  it.runIf(mode === "off")("rejects a foreign assistance inserted after Node resolved the approval identity", async () => {
    for (const operation of ["detail", "block-audit-attempts"] as const) {
      const id = randomUUID();
      await db.insert(approvals).values({ id, orgId: payloadOrg, type: "hire_agent", payload: { privateMarker: "must not escape" } });
      const original = bridge!.requestRead!.bind(bridge);
      const intercepted = vi.spyOn(bridge!, "requestRead").mockImplementationOnce(async (actor, orgId, input) => {
        expect(input).toEqual({ operation, requestId: id });
        expect(orgId).toBe(payloadOrg);
        await db.insert(requests).values({ id, orgId: other, kind: "assistance", subtype: "issue_blocker", title: "Foreign winner", prompt: "Hidden" });
        return original(actor, orgId, input);
      });
      try {
        const response = await get(`/requests/${id}${operation === "detail" ? "" : "/block-audit-attempts"}`, payloadToken);
        expect(intercepted).toHaveBeenCalledOnce();
        expect(response.status).toBe(404);
        expect(response.body).toEqual({ error: "Request not found" });
      } finally { intercepted.mockRestore(); }
      expect((await get(`/requests/${id}`, payloadToken)).status).toBe(403);
    }
  });
  it("returns complete native detail and list beyond generic receipt limits", async () => {
    const id = randomUUID();
    await db.insert(requests).values({ id, orgId: payloadOrg, kind: "assistance", subtype: "issue_blocker", title: "Large history", prompt: "x".repeat(300_000) });
    const before = await snapshot();
    const response = await pair(`/requests/${id}`);
    expect(response.text.length).toBeGreaterThan(300_000);
    expect((await pair(`/orgs/${payloadOrg}/requests?kind=assistance`)).text.length).toBeGreaterThan(300_000);
    expect(await snapshot()).toEqual(before);
  });
  it.runIf(mode !== "node")("retains both same-ID rows and uses table rank only after whole-second ties", async () => {
    await db.insert(requests).values({id:high,orgId:orderingOrg,kind:"assistance",subtype:"issue_blocker",title:"Same ID Request",prompt:"Input",updatedAt:new Date("2026-10-12T01:00:00.950Z")});
    const equal=await get(`/orgs/${orderingOrg}/requests`,orderingToken);
    expect(equal.body.map((row:{id:string;kind:string})=>[row.id,row.kind])).toEqual([[high,"assistance"],[high,"approval"],[low,"assistance"]]);
    await db.update(requests).set({updatedAt:new Date("2026-10-12T00:59:59.999Z")}).where(eq(requests.id,high));
    const earlier=await get(`/orgs/${orderingOrg}/requests`,orderingToken);
    expect(earlier.body.map((row:{id:string;kind:string})=>[row.id,row.kind])).toEqual([[high,"approval"],[low,"assistance"],[high,"assistance"]]);
  });
  it.runIf(mode === "off")("fails closed when native dispatch is absent or its transport is unavailable", async () => {
    const unusedPort = await freePort();
    const unavailable = { requestRead: (actor, orgId, input) => requestRequestRead(`http://127.0.0.1:${unusedPort}`, "synthetic-unavailable-reader-key", 1000, actor, orgId, input) } as RustFoundationBridge;
    const before = await snapshot();
    const upstreamPort = (server!.address() as net.AddressInfo).port;
    for (const selected of [undefined, unavailable]) {
      server!.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      const failedApp = express();
      failedApp.get("/api/health", (_req, res) => res.json({ status: "ok" }));
      failedApp.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
      failedApp.use("/api", requestRoutes(db, selected));
      failedApp.use(errorHandler);
      server = failedApp.listen(upstreamPort, "127.0.0.1");
      await once(server, "listening");
      const outageTarget = mode === "required" ? target : server;
      expect((await request(outageTarget).get(`/api/orgs/${payloadOrg}/requests`).set("authorization", `Bearer ${payloadToken}`)).status).toBe(503);
      for (const url of [`/requests/${auditedRequest}`, `/requests/${auditedRequest}/block-audit-attempts`]) {
        const response = await request(outageTarget).get(`/api${url}`).set("authorization", `Bearer ${payloadToken}`);
        expect(response.status).toBe(503);
        expect(response.body.error).toBe("Rust Request reads are unavailable");
      }
    }
    expect(await snapshot()).toEqual(before);
  });

});
