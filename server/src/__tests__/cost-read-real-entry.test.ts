import {
  activityLog, agentApiKeys, agents, applyPendingMigrations, authUsers, boardApiKeys,
  costEvents, createDb, ensurePostgresDatabase, financeEvents, heartbeatRuns, issues,
  organizationMemberships, organizations, projects,
} from "@rudderhq/db";
import { sql } from "drizzle-orm";
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
import { costRoutes } from "../routes/costs.js";
import { costService } from "../services/costs.js";
import { financeService } from "../services/finance.js";
import { createRustFoundationBridge, type CostReadOperation, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// The legacy services are oracle-only. Public route construction gets throwing
// read stubs, proving successful public responses cannot silently use Node SQL.
vi.mock("../services/index.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/index.js")>();
  const forbidden = () => { throw new Error("Node cost/finance read authority must not execute"); };
  return {
    ...original,
    costService: (...args: Parameters<typeof costService>) => ({ ...original.costService(...args),
      summary: forbidden, byAgent: forbidden, trend: forbidden, byAgentModel: forbidden,
      byProvider: forbidden, byBiller: forbidden, byProject: forbidden, windowSpend: forbidden,
    }),
    financeService: (...args: Parameters<typeof financeService>) => ({ ...original.financeService(...args),
      summary: forbidden, byBiller: forbidden, byKind: forbidden, list: forbidden,
    }),
  };
});

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags: string[]; postgresFlags?: string[]; onLog: () => void; onError: () => void;
}) => EmbeddedPostgresInstance;
const operations: CostReadOperation[] = ["summary", "by-agent", "trend", "by-agent-model", "by-provider", "by-biller", "by-project", "window-spend", "finance-summary", "finance-by-biller", "finance-by-kind", "finance-events"];
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
function canonical(value: unknown) {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, stable(val)]))
    : item;
  const data = stable(wire(value));
  return Array.isArray(data) ? data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : data;
}
function expectContractOrder(operation: CostReadOperation, rows: unknown, expected: unknown) {
  if (!Array.isArray(rows) || !Array.isArray(expected)) return;
  if (["trend", "finance-events"].includes(operation)) { expect(rows).toEqual(wire(expected)); return; }
  if (operation === "by-agent-model") {
    const keys = (values: typeof rows) => values.map((row) => [row.provider, row.biller, row.billingType, row.model]);
    expect(keys(rows)).toEqual(keys(expected)); return;
  }
  if (operation.startsWith("finance-by-")) {
    const key = operation === "finance-by-kind" ? "eventKind" : "biller";
    expect(rows.map((row) => [row.netCents, row[key]])).toEqual(expected.map((row) => [row.netCents, row[key]])); return;
  }
  if (operation === "window-spend") {
    expect(rows.map((row) => [row.windowHours, row.costCents])).toEqual(expected.map((row) => [row.windowHours, row.costCents])); return;
  }
  expect(rows.map((row) => row.costCents)).toEqual(expected.map((row) => row.costCents));
}
async function port() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer(); server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(new Error("No test port")); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}
async function close(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); });
}

// Real Express actor authentication -> signed private Rust capability -> SQLx
// PostgreSQL, with both default ingress and actual Rust public ingress.
describe.each(["off", "required"] as const)("Cost read real public workflow (ingress %s)", (ingressMode) => {
  let db: ReturnType<typeof createDb>;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let target: Server | string;
  let baseline: Record<string, unknown>;
  const orgId = randomUUID(), foreignOrgId = randomUUID(), emptyOrgId = randomUUID(), volumeOrgId = randomUUID(), dateOrgId = randomUUID();
  const agentId = randomUUID(), foreignAgentId = randomUUID(), volumeAgentId = randomUUID();
  const projectIds = [randomUUID(), randomUUID()];
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  const issueIds = [randomUUID(), randomUUID()];
  const agentToken = `cost-agent-${randomUUID()}`, boardToken = `cost-board-${randomUUID()}`, userId = randomUUID();
  const from = new Date("2024-02-29T00:00:00.000Z"), to = new Date("2024-03-01T00:00:00.000Z");

  async function startApp(selectedBridge?: RustFoundationBridge, listenPort = 0) {
    const app = express(); app.use(express.json());
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", costRoutes(db, selectedBridge)); app.use(errorHandler);
    const result = app.listen(listenPort, "127.0.0.1"); await once(result, "listening"); return result;
  }
  function get(operation: string, org = orgId, token = agentToken, selected = target) {
    return request(selected).get(`/api/orgs/${org}/costs/${operation}`).set("authorization", `Bearer ${token}`);
  }
  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of ["cost_events", "finance_events", "cost_monthly_spend_rollups", "organizations", "agents", "heartbeat_runs", "activity_log", "organization_mutation_state", "organization_mutation_receipts"]) {
      const rows = await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb)::text AS value FROM ${table} x`));
      result[table] = rows[0]?.value;
    }
    return result;
  }
  async function oracle(operation: CostReadOperation, org = orgId, range?: { from?: Date; to?: Date }) {
    const costs = costService(db), finance = financeService(db);
    switch (operation) {
      case "summary": return costs.summary(org, range);
      case "by-agent": return costs.byAgent(org, range);
      case "trend": return costs.trend(org, range);
      case "by-agent-model": return costs.byAgentModel(org, range);
      case "by-provider": return costs.byProvider(org, range);
      case "by-biller": return costs.byBiller(org, range);
      case "by-project": return costs.byProject(org, range);
      case "window-spend": return costs.windowSpend(org);
      case "finance-summary": return finance.summary(org, range);
      case "finance-by-biller": return finance.byBiller(org, range);
      case "finance-by-kind": return finance.byKind(org, range);
      case "finance-events": return finance.list(org, range);
    }
  }

  beforeAll(async () => {
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
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-cost-read-postgres-"));
    const dbPort = await port();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({ databaseDir: dataDir, user: "rudder", password: "rudder", port: dbPort,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-c", "unix_socket_directories="], onLog: () => {}, onError: () => {},
    });
    await database.initialise(); await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${dbPort}/postgres`, "rudder");
    const databaseUrl = `postgres://rudder:rudder@127.0.0.1:${dbPort}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'Pacific/Honolulu'`);
    await db.$client.end({ timeout: 5 }); db = createDb(databaseUrl);
    await db.insert(organizations).values([
      { id: orgId, name: "Costs", urlKey: "costs", issuePrefix: "CST", budgetMonthlyCents: 10000 },
      { id: foreignOrgId, name: "Foreign", urlKey: "foreign", issuePrefix: "FRN" },
      { id: emptyOrgId, name: "Empty", urlKey: "empty", issuePrefix: "EMP" },
      { id: volumeOrgId, name: "Volume", urlKey: "volume", issuePrefix: "VOL" },
      { id: dateOrgId, name: "Date boundaries", urlKey: "date-boundaries", issuePrefix: "DTE" },
    ]);
    await db.insert(agents).values([
      { id: agentId, orgId, name: "Reader", role: "general", status: "idle" },
      { id: foreignAgentId, orgId: foreignOrgId, name: "Foreign secret", role: "general", status: "idle" },
      { id: volumeAgentId, orgId: volumeOrgId, name: "Big totals", role: "general", status: "idle" },
    ]);
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Cost read", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(authUsers).values({ id: userId, name: "Cost reader", email: "cost-read@example.test", createdAt: from, updatedAt: to });
    await db.insert(organizationMemberships).values([orgId, emptyOrgId, volumeOrgId, dateOrgId].map((orgId) => ({ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values({ userId, name: "Cost reader", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(projects).values(projectIds.map((id, index) => ({ id, orgId, name: `Project ${index}` })));
    await db.insert(heartbeatRuns).values(runIds.map((id, index) => ({ id, orgId, agentId, status: "succeeded", startedAt: new Date(from.getTime() - 3600000 * (index + 1)), finishedAt: new Date(to.getTime() + 3600000 * index) })));
    await db.insert(heartbeatRuns).values([
      { orgId, agentId, status: "running", startedAt: new Date(from.getTime() + 7200000), finishedAt: null },
      { orgId, agentId, status: "queued", startedAt: null, finishedAt: null },
      { orgId, agentId, status: "running", startedAt: new Date(Date.now() + 86400000), finishedAt: null },
    ]);
    await db.insert(issues).values(issueIds.map((id, index) => ({ id, orgId, projectId: projectIds[index], title: `Attribution ${index}` })));
    await db.insert(activityLog).values(issueIds.map((entityId, index) => ({ orgId, actorType: "agent", actorId: agentId, action: "issue.updated", entityType: "issue", entityId, runId: runIds[0], createdAt: new Date(from.getTime() + index * 1000) })));
    const common = { orgId, agentId, createdAt: from };
    await db.insert(costEvents).values([
      { ...common, provider: "Anthropic", biller: "claude", billingType: "subscription_included", model: "a", inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, costCents: 101, occurredAt: from, heartbeatRunId: runIds[0] },
      { ...common, provider: "openai", biller: "openai", billingType: "metered_api", model: "b", inputTokens: 200, cachedInputTokens: 30, outputTokens: 40, costCents: 202, occurredAt: to, heartbeatRunId: runIds[0], projectId: projectIds[0] },
      { ...common, provider: "claude", biller: "claude", billingType: "subscription_overage", model: "c", costCents: 53, occurredAt: new Date(to.getTime() + 1), heartbeatRunId: runIds[1] },
      { ...common, provider: "openai", biller: "azure", billingType: "unknown", model: "d", inputTokens: 500, outputTokens: 10, costCents: 17, occurredAt: new Date(from.getTime() - 1) },
      ...[1, 6, 25, 200].map((hours) => ({ ...common, provider: "openai", biller: hours === 1 ? "openai" : "azure", billingType: "metered_api", model: "recent", inputTokens: hours, costCents: hours, occurredAt: new Date(Date.now() - hours * 3600000) })),
      { ...common, orgId: foreignOrgId, agentId: foreignAgentId, provider: "foreign", model: "secret", costCents: 99999, occurredAt: from },
    ]);
    await db.insert(financeEvents).values(Array.from({ length: 110 }, (_, index) => ({ orgId, biller: index % 2 ? "openai" : "claude", eventKind: index % 3 ? "usage" : "subscription", direction: index % 7 ? "debit" : "credit", amountCents: index + 1, estimated: index % 2 === 0, occurredAt: index < 3 ? from : to, createdAt: new Date(from.getTime() + index), metadataJson: index === 0 ? { nested: { snake_key: [true, null] } } : null })));
    await db.insert(financeEvents).values({ orgId: foreignOrgId, biller: "foreign", eventKind: "secret", amountCents: 99999, occurredAt: from });
    await db.insert(costEvents).values(Array.from({ length: 3 }, () => ({ orgId: volumeOrgId, agentId: volumeAgentId, provider: "anthropic", biller: "anthropic", model: "big", inputTokens: 2_000_000_000, cachedInputTokens: 2_000_000_000, outputTokens: 2_000_000_000, costCents: 2_000_000_000, occurredAt: from })));
    await db.insert(financeEvents).values(Array.from({ length: 3 }, () => ({ orgId: volumeOrgId, biller: "big", eventKind: "usage", amountCents: 2_000_000_000, occurredAt: from })));
    for (const timestamp of ["10000-01-01 00:00:00Z", "0001-01-01 00:00:00Z", "0012-02-01 00:00:00Z", "0032-01-01 00:00:00Z", "0099-01-01 00:00:00Z", "0001-01-01 00:00:00Z BC", "1969-12-31 23:59:59.999999Z", "infinity"]) {
      await db.execute(sql`INSERT INTO finance_events (org_id,biller,event_kind,amount_cents,occurred_at,created_at,metadata_json)
        VALUES (${dateOrgId}::uuid,'date','edge',1,${timestamp}::timestamptz,'2024-01-01Z',${`${"[".repeat(600)}9007199254740993${"]".repeat(600)}`}::jsonb)`);
    }
    baseline = await snapshot();
    const listenPort = ingressMode === "required" ? await port() : 0;
    bridge = createRustFoundationBridge({ databaseUrl, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10000,
      ...(ingressMode === "required" ? { publicIngress: { listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${listenPort}`, authorizationKey: "cost-read-test-ingress-authorization-key-32bytes" } } : {}),
    });
    server = await startApp(bridge, listenPort); await bridge.start(); target = server;
    if (ingressMode === "required") { await bridge.waitForPublicIngressReady!(); target = bridge.publicIngressBaseUrl!; }
  }, 120000);

  afterAll(async () => {
    try { await close(server); await bridge?.close(); await db?.$client.end({ timeout: 5 }); await database?.stop(); }
    finally { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); }
  });

  it.each(operations)("preserves %s legacy JSON through the native authority", async (operation) => {
    const expected = await oracle(operation);
    const response = await get(operation);
    expect(response.status, response.text).toBe(200);
    if (operation === "summary") {
      const expectedSummary = expected as { activeDurationMs: number };
      expect(response.body.activeDurationMs).toBeGreaterThanOrEqual(expectedSummary.activeDurationMs);
      expect(response.body.activeDurationMs - expectedSummary.activeDurationMs).toBeLessThan(10000);
      expect(canonical(response.body)).toEqual(canonical({ ...expectedSummary, activeDurationMs: response.body.activeDurationMs }));
    } else {
      expect(canonical(response.body)).toEqual(canonical(expected));
      expectContractOrder(operation, response.body, expected);
    }
    const empty = await get(operation, emptyOrgId, boardToken);
    expect(empty.status, empty.text).toBe(200);
    expect(canonical(empty.body)).toEqual(canonical(await oracle(operation, emptyOrgId)));
  });

  it.each(operations.filter((operation) => operation !== "window-spend"))("honors inclusive offset date bounds for %s", async (operation) => {
    const response = await get(operation).query({ from: "2024-02-29T08:00:00+08:00", to: "2024-03-01T01:00:00+01:00" });
    expect(response.status, response.text).toBe(200);
    const expected = await oracle(operation, orgId, { from, to });
    expect(canonical(response.body)).toEqual(canonical(expected));
    expectContractOrder(operation, response.body, expected);
  });

  it("preserves latest run attribution, explicit project precedence and hourly filter combination", async () => {
    for (const projectId of projectIds) {
      const response = await get("trend").query({ agentId, projectId, granularity: "hour", from: from.toISOString(), to: to.toISOString() });
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(wire(await costService(db).trend(orgId, { from, to }, "hour", { agentId, projectId })));
    }
    const compactId = agentId.replaceAll("-", "");
    expect((await get("trend").query({ agentId: compactId })).body).toEqual(wire(await costService(db).trend(orgId, undefined, "day", { agentId: compactId })));
  });

  it("preserves finance ordering, defaults and limits", async () => {
    for (const limit of [1, 25, 100, 500]) {
      const response = await get("finance-events").query({ limit });
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(wire(await financeService(db).list(orgId, undefined, limit)));
      expect(response.body.length).toBe(Math.min(limit, 110));
    }
  });

  it("preserves extended dates, historical offsets, invalid dates and deep metadata", async () => {
    const response = await get("finance-events", dateOrgId, boardToken);
    expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual(wire(await financeService(db).list(dateOrgId)));
    expect(response.body[0].occurredAt).toBeNull(); // PostgreSQL infinity -> invalid JS Date -> null
    expect(response.body[1].occurredAt).toBe("+010000-01-01T00:00:00.000Z");
  });

  it("widens token and finance aggregation past signed 32-bit limits", async () => {
    const summary = await get("summary", volumeOrgId, boardToken);
    expect(summary.status, summary.text).toBe(200);
    expect(summary.body).toMatchObject({ spendCents: 6_000_000_000, inputTokens: 12_000_000_000, totalTokens: 18_000_000_000 });
    const finance = await get("finance-summary", volumeOrgId, boardToken);
    expect(finance.status, finance.text).toBe(200);
    expect(finance.body).toMatchObject({ debitCents: 6_000_000_000, netCents: 6_000_000_000 });
  });

  it("rejects cross-org and anonymous requests, validates inputs and fails closed", async () => {
    for (const operation of operations) {
      expect((await get(operation, foreignOrgId)).status).toBe(403);
      expect((await get(operation, foreignOrgId, boardToken)).status).toBe(403);
      expect((await get(operation, orgId, "bad-token")).status).toBe(401);
    }
    for (const query of [{ from: "invalid" }, { to: "invalid" }, { from: to.toISOString(), to: from.toISOString() }]) expect((await get("summary").query(query)).status).toBe(400);
    expect((await get("trend").query({ granularity: "minute" })).status).toBe(400);
    expect((await get("finance-events").query({ limit: 501 })).status).toBe(400);
    const unavailable = await startApp();
    try { for (const operation of operations) expect((await get(operation, orgId, agentToken, unavailable)).status).toBe(503); }
    finally { await close(unavailable); }
    expect(await snapshot()).toEqual(baseline);
  });
});
