import { activityLog, agentApiKeys, agents, applyPendingMigrations, authUsers, boardApiKeys, chatContextLinks, chatConversations, createDb, issues, organizationMemberships, organizations, resolveOfficialPostgresBinDir, resolveOfficialPostgresBinaries } from "@rudderhq/db";
import { isLowSignalIssueContentOnlyUpdate } from "@rudderhq/shared";
import { and, desc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import express from "express";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import type { Server } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { activityRoutes } from "../routes/activity.js";
import { activityService } from "../services/activity.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { nativeIdentityIngressFixture } from "./helpers/native-identity-ingress.js";

const routeConstruction = vi.hoisted(() => ({ native: false }));
vi.mock("../services/activity.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/activity.js")>();
  return { ...original, activityService: (...args: Parameters<typeof original.activityService>) => {
    const service = original.activityService(...args);
    if (!routeConstruction.native) return service;
    const forbidden = () => { throw new Error("Node Activity read authority must not execute"); };
    return { ...service, list: forbidden, listPage: forbidden, forIssue: forbidden };
  } };
});

const execFile = promisify(execFileCallback);
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
async function port() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return server.close(() => reject(new Error("No test port")));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function database() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-activity-read-"));
  const data = path.join(root, "data"), dbPort = await port();
  const binDir = resolveOfficialPostgresBinDir();
  const timezone = process.env.RUDDER_ACTIVITY_TEST_TIMEZONE ?? "UTC";
  let stop: () => Promise<void>;
  if (binDir) {
    const binary = resolveOfficialPostgresBinaries(binDir);
    await execFile(binary.initdb, ["-D", data, "--encoding=UTF8", "--locale=C", "--auth=trust", "--username=postgres", "--no-sync"]);
    await execFile(binary.pgCtl, ["-D", data, "-l", path.join(root, "postgres.log"), "-o",
      `-h 127.0.0.1 -p ${dbPort} -k '' -c shared_buffers=16MB -c max_connections=24 -c dynamic_shared_memory_type=mmap -c timezone=${timezone}`, "-w", "start"]);
    stop = async () => { await execFile(binary.pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"]); };
  } else {
    // CI installs the repository's embedded provider; PostgreSQL need not be on
    // PATH. Keep the same TCP-only fixture and timezone in either provider.
    const EmbeddedPostgres = (await import("embedded-postgres")).default;
    const postgres = new EmbeddedPostgres({ databaseDir: data, user: "postgres", password: "synthetic", port: dbPort,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-h", "127.0.0.1", "-c", "unix_socket_directories=", "-c", "shared_buffers=16MB",
        "-c", "max_connections=24", "-c", "dynamic_shared_memory_type=mmap", "-c", `timezone=${timezone}`],
      onLog: () => {}, onError: () => {},
    });
    await postgres.initialise(); await postgres.start();
    stop = async () => { await postgres.stop(); };
  }
  const url = `postgres://postgres:synthetic@127.0.0.1:${dbPort}/postgres`;
  await applyPendingMigrations(url);
  const db = createDb(url);
  return { db, url, close: async () => {
    await db.$client.end({ timeout: 5 });
    await stop();
    fs.rmSync(root, { recursive: true, force: true });
  } };
}

type Database = Awaited<ReturnType<typeof database>>;
async function organization(db: Database["db"], suffix: string) {
  const orgId = randomUUID();
  await db.insert(organizations).values({ id: orgId, name: suffix, urlKey: `${suffix}-${orgId}`, issuePrefix: suffix });
  return orgId;
}
async function event(db: Database["db"], orgId: string, options: Record<string, unknown>) {
  const id = typeof options.id === "string" ? options.id : randomUUID();
  await db.insert(activityLog).values({ id, orgId, actorType: "system", actorId: "fixture", action: "project.updated",
    entityType: "project", entityId: "fixture", ...options } as typeof activityLog.$inferInsert);
  return id;
}

// Immutable pre-hardening Issue oracle from cfdc237, activity.ts SHA256
// 51239cf5e156f779399d84df0442a1ba7121cca8613d20d40b95f38ef183fd41.
// Keep the original unfenced queries here so security tests cannot compare the
// hardened implementation against itself or erase evidence of prior leakage.
async function legacyIssueActivity(db: Database["db"], issueId: string) {
  const conversationIdAsText = sql<string>`${chatConversations.id}::text`;
  const shouldShowIssueActivity = (event: typeof activityLog.$inferSelect) => event.action !== "issue.execution_released"
    && event.action !== "issue.document_updated" && !isLowSignalIssueContentOnlyUpdate(event.action, event.details);

      const [issueEvents, relatedChatEvents] = await Promise.all([
        db
          .select()
          .from(activityLog)
          .where(
            and(
              eq(activityLog.entityType, "issue"),
              eq(activityLog.entityId, issueId),
              ne(activityLog.action, "issue.read_marked"),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
        db
          .select({
            activityLog,
            conversationTitle: chatConversations.title,
          })
          .from(activityLog)
          .innerJoin(
            chatConversations,
            and(
              eq(activityLog.entityType, "chat"),
              eq(activityLog.entityId, conversationIdAsText),
            ),
          )
          .leftJoin(
            chatContextLinks,
            and(
              eq(chatContextLinks.conversationId, chatConversations.id),
              eq(chatContextLinks.entityType, "issue"),
              eq(chatContextLinks.entityId, issueId),
            ),
          )
          .where(
            or(
              and(
                eq(activityLog.action, "chat.issue_converted"),
                sql`${activityLog.details} ->> 'issueId' = ${issueId}`,
              ),
              and(
                eq(activityLog.action, "chat.context_linked"),
                sql`${activityLog.details} ->> 'entityType' = 'issue'`,
                sql`${activityLog.details} ->> 'entityId' = ${issueId}`,
              ),
              and(
                eq(activityLog.action, "chat.created"),
                isNotNull(chatContextLinks.id),
                sql`coalesce((${activityLog.details} ->> 'contextLinkCount')::int, 0) > 0`,
              ),
            ),
          )
          .orderBy(desc(activityLog.createdAt)),
      ]);

      const merged = [
        ...issueEvents.filter(shouldShowIssueActivity),
        ...relatedChatEvents.map(({ activityLog: event, conversationTitle }) => ({
          ...event,
          details: {
            ...(event.details ?? {}),
            conversationTitle,
          },
        })),
      ];

      return merged.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
}

// Run this focused oracle group before native implementation/aggregate checks.
// Its observations freeze the subtle legacy behavior, including the explicitly
// approved organization-isolation difference in contaminated Issue references.
describe("Activity Node oracle", () => {
  let fixture: Database;
  beforeAll(async () => { fixture = await database(); }, 120000);
  afterAll(async () => { await fixture?.close(); });

  it("retains microseconds for org cursors but source-stable milliseconds for issue merge", async () => {
    const { db } = fixture;
    const orgId = await organization(db, "MIC");
    const issueId = randomUUID(), conversationId = randomUUID();
    await db.insert(issues).values({ id: issueId, orgId, title: "Microseconds", identifier: "MIC-1" });
    await db.execute(sql`INSERT INTO chat_conversations(id,org_id,title) VALUES (${conversationId}::uuid,${orgId}::uuid,'Linked')`);
    const ids = ["00000000-0000-4000-8000-000000000011", "00000000-0000-4000-8000-000000000012", "00000000-0000-4000-8000-000000000013"];
    for (let index = 0; index < ids.length; index++) {
      await db.execute(sql`INSERT INTO activity_log(id,org_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at)
        VALUES (${ids[index]}::uuid,${orgId}::uuid,'system','fixture',${index === 2 ? "chat.issue_converted" : "issue.comment_added"},
        ${index === 2 ? "chat" : "issue"},${index === 2 ? conversationId : issueId},${JSON.stringify({ issueId })}::jsonb,
        ${`2026-04-01T10:00:00.000${index * 400 + 100}Z`}::timestamptz)`);
    }
    const svc = activityService(db);
    const first = await svc.listPage({ orgId, limit: 2 });
    expect(first.items.map((row) => row.id)).toEqual([ids[2], ids[1]]);
    expect(JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString())).toEqual({ createdAt: "2026-04-01T10:00:00.000500Z", id: ids[1] });
    expect((await svc.listPage({ orgId, limit: 2, cursor: first.nextCursor })).items.map((row) => row.id)).toEqual([ids[0]]);
    expect(wire(await legacyIssueActivity(db, issueId)).map((row: { id: string }) => row.id)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it("uses raw page boundary before JS internal-field filtering and after hydration", async () => {
    const { db } = fixture;
    const orgId = await organization(db, "PAG"), issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, orgId, title: "Canonical", identifier: "PAG-1" });
    const newer = new Date("2026-04-01T10:02:00Z"), older = new Date("2026-04-01T10:01:00Z");
    const hidden = await event(db, orgId, { action: "issue.updated", entityType: "issue", entityId: randomUUID(),
      details: { title: "Low signal", executionWorkspaceId: "internal" }, createdAt: newer });
    const visible = await event(db, orgId, { createdAt: older });
    const svc = activityService(db);
    const page = await svc.listPage({ orgId, limit: 1 });
    expect(page.items).toEqual([]);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString()).id).toBe(hidden);
    expect((await svc.listPage({ orgId, limit: 1, cursor: page.nextCursor })).items.map((row) => row.id)).toEqual([visible]);
    const hydrated = await event(db, orgId, { action: "issue.updated", entityType: "issue", entityId: issueId,
      details: { title: "Original", executionWorkspaceId: "internal" }, createdAt: new Date("2026-04-01T10:03:00Z") });
    expect((await svc.listPage({ orgId, limit: 1 })).items.map((row) => row.id)).toEqual([hydrated]);
    expect(await legacyIssueActivity(db, issueId)).toEqual([]);
  });

  it("demonstrates four cross-org contaminated reference classes in the legacy oracle", async () => {
    const { db } = fixture;
    const orgId = await organization(db, "OWN"), foreign = await organization(db, "FOR");
    const issueId = randomUUID(), localChat = randomUUID(), foreignChat = randomUUID(), linkChat = randomUUID();
    await db.insert(issues).values({ id: issueId, orgId, title: "Scoped", identifier: "OWN-1" });
    await db.execute(sql`INSERT INTO chat_conversations(id,org_id,title) VALUES
      (${localChat}::uuid,${orgId}::uuid,'Local'),(${foreignChat}::uuid,${foreign}::uuid,'Foreign'),(${linkChat}::uuid,${orgId}::uuid,'Contaminated link')`);
    await db.execute(sql`INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id)
      VALUES (${foreign}::uuid,${linkChat}::uuid,'issue',${issueId})`);
    const leaked = [];
    leaked.push(await event(db, foreign, { entityType: "issue", entityId: issueId, action: "issue.created" }));
    leaked.push(await event(db, foreign, { entityType: "chat", entityId: foreignChat, action: "chat.issue_converted", details: { issueId } }));
    leaked.push(await event(db, orgId, { entityType: "chat", entityId: foreignChat, action: "chat.context_linked", details: { entityType: "issue", entityId: issueId } }));
    leaked.push(await event(db, foreign, { entityType: "chat", entityId: localChat, action: "chat.issue_converted", details: { issueId } }));
    leaked.push(await event(db, orgId, { entityType: "chat", entityId: linkChat, action: "chat.created", details: { contextLinkCount: 1 } }));
    expect((await legacyIssueActivity(db, issueId)).map((row) => row.id).sort()).toEqual(leaked.sort());
  });
});

describe.each(["off", "required"] as const)("Activity native public ingress %s", (ingress) => {
  let fixture: Database, bridge: RustFoundationBridge, server: Server, target: Server | string;
  let orgId: string, foreign: string, empty: string, volume: string, agentId: string, issueId: string, hiddenId: string, foreignIssue: string, dateIssue: string;
  const agentToken = `activity-agent-${randomUUID()}`, boardToken = `activity-board-${randomUUID()}`, userId = randomUUID();
  const contaminated: string[] = [];
  const nativeIdentity = nativeIdentityIngressFixture();
  let activeIssueReadHook: null | (() => Promise<void>) = null;
  let baseline: Record<string, unknown>;
  async function snapshot() {
    const values: Record<string, unknown> = {};
    for (const table of ["activity_log", "issues", "chat_conversations", "chat_context_links", "organization_mutation_state", "organization_mutation_receipts"]) {
      const [row] = await fixture.db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text AS value FROM ${table} t`));
      values[table] = row?.value;
    }
    return values;
  }
  async function startApp(selectedBridge?: RustFoundationBridge, listenPort = 0, beforeIssueRead: null | (() => Promise<void>) = null) {
    const app = express(); if (ingress === "required") app.use(nativeIdentity.middleware()); app.use(express.json());
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.use(actorMiddleware(fixture.db, { deploymentMode: "authenticated", authRequirement: "required" }));
    routeConstruction.native = true;
    const dispatcher = selectedBridge ? { ...selectedBridge,
      activityRead: async (...args: Parameters<NonNullable<RustFoundationBridge["activityRead"]>>) => {
        if (args[2].operation === "issue") {
          await activeIssueReadHook?.();
          await beforeIssueRead?.();
        }
        return selectedBridge.activityRead!(...args);
      },
    } : selectedBridge;
    try { app.use("/api", activityRoutes(fixture.db, dispatcher)); }
    finally { routeConstruction.native = false; }
    app.use(errorHandler);
    const listening = app.listen(listenPort, "127.0.0.1"); await once(listening, "listening"); return listening;
  }
  async function close(listening?: Server) {
    if (listening) await new Promise<void>((resolve, reject) => { listening.close((error) => error ? reject(error) : resolve()); listening.closeAllConnections(); });
  }
  function get(url: string, token = agentToken, selected = target) {
    return request(selected).get(`/api/${url}`).set("authorization", `Bearer ${token}`);
  }
  async function orderingFixture(rows: Array<{ source: "issue" | "chat"; stamp: string; label: string; id?: string; payload?: string }>, verify: (issue: string) => Promise<void>) {
    const orderingIssue = randomUUID(), orderingChat = randomUUID();
    const { db } = fixture;
    await db.insert(issues).values({ id: orderingIssue, orgId, title: "Ordering contract" });
    await db.insert(chatConversations).values({ id: orderingChat, orgId, title: "Ordering chat" });
    try {
      for (const row of rows) {
        await db.insert(activityLog).values({ id: row.id ?? randomUUID(), orgId, actorType: "system", actorId: "ordering",
          action: row.source === "chat" ? "chat.issue_converted" : "issue.created", entityType: row.source,
          entityId: row.source === "chat" ? orderingChat : orderingIssue,
          createdAt: sql`${row.stamp}::timestamptz`, details: { issueId: orderingIssue, label: row.label, ...(row.payload ? { payload: row.payload } : {}) } });
      }
      await verify(orderingIssue);
    } finally {
      await db.delete(activityLog).where(and(eq(activityLog.orgId, orgId), or(eq(activityLog.entityId, orderingIssue), eq(activityLog.entityId, orderingChat))));
      await db.delete(chatConversations).where(eq(chatConversations.id, orderingChat));
      await db.delete(issues).where(eq(issues.id, orderingIssue));
    }
    expect(await snapshot()).toEqual(baseline);
  }
  beforeAll(async () => {
    fixture = await database();
    const { db } = fixture;
    orgId = await organization(db, "ACT"); foreign = await organization(db, "EXT"); empty = await organization(db, "EMP"); volume = await organization(db, "VOL");
    agentId = randomUUID(); issueId = randomUUID(); hiddenId = randomUUID(); foreignIssue = randomUUID(); dateIssue = randomUUID();
    await db.insert(agents).values({ id: agentId, orgId, name: "Reader", role: "general" });
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Activity reader", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(authUsers).values({ id: userId, name: "Activity reader", email: `activity-${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(organizationMemberships).values([orgId, empty, volume].map((orgId) => ({ orgId, principalType: "user", principalId: userId, status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values({ userId, name: "Activity reader", keyHash: createHash("sha256").update(boardToken).digest("hex") });
    await db.insert(issues).values([
      { id: issueId, orgId, title: "Canonical", identifier: "ACT-1", issueNumber: 1 },
      { id: hiddenId, orgId, title: "Hidden", identifier: "ACT-2", issueNumber: 2, hiddenAt: new Date() },
      { id: foreignIssue, orgId: foreign, title: "Foreign", identifier: "EXT-1", issueNumber: 1 },
      { id: dateIssue, orgId, title: "Historical ordering", identifier: "ACT-3", issueNumber: 3 },
    ]);
    await db.execute(sql`INSERT INTO organization_issue_prefix_aliases(org_id,prefix) VALUES (${orgId}::uuid,'OLD')`);
    const local = [randomUUID(), randomUUID(), randomUUID()], foreignChat = randomUUID(), badLink = randomUUID();
    for (const id of [...local, badLink]) await db.execute(sql`INSERT INTO chat_conversations(id,org_id,title) VALUES (${id}::uuid,${orgId}::uuid,'Current title')`);
    await db.execute(sql`INSERT INTO chat_conversations(id,org_id,title) VALUES (${foreignChat}::uuid,${foreign}::uuid,'Foreign title')`);
    await db.execute(sql`INSERT INTO chat_context_links(org_id,conversation_id,entity_type,entity_id) VALUES
      (${orgId}::uuid,${local[0]}::uuid,'issue',${issueId}),(${foreign}::uuid,${badLink}::uuid,'issue',${issueId})`);
    const events = [
      { entityType: "issue", entityId: issueId, action: "issue.created", details: { identifier: "", title: 123, nested: true } },
      { entityType: "chat", entityId: local[0], action: "chat.created", details: { contextLinkCount: 1, conversationTitle: "Old" } },
      { entityType: "chat", entityId: local[1], action: "chat.context_linked", details: { entityType: "issue", entityId: issueId } },
      { entityType: "chat", entityId: local[2], action: "chat.issue_converted", details: { issueId } },
      { entityType: "issue", entityId: issueId, action: "issue.updated", details: { title: "Low", executionWorkspaceId: "internal" } },
      { entityType: "issue", entityId: randomUUID(), action: "issue.updated", details: { title: "Low orphan", executionWorkspaceId: "internal" } },
      { entityType: "issue", entityId: issueId, action: "issue.document_updated", details: { title: "Document" } },
      ...["issue.read_marked", "issue.execution_released"].map((action) => ({ entityType: "issue", entityId: issueId, action })),
      { entityType: "issue", entityId: hiddenId, action: "issue.created" },
      { entityType: "issue", entityId: randomUUID(), action: "issue.created" },
      { actorType: "agent", actorId: agentId, entityType: "agent", entityId: agentId },
      { actorType: "system", actorId: "associated", agentId },
      { actorType: "user", actorId: " reader " },
    ];
    for (let index = 0; index < events.length; index++) {
      const id = await event(db, orgId, events[index]!);
      await db.execute(sql`UPDATE activity_log SET created_at=${`2026-04-01T10:00:00.${String(100+index*50).padStart(6,"0")}Z`}::timestamptz WHERE id=${id}::uuid`);
    }
    contaminated.push(await event(db, foreign, { entityType: "issue", entityId: issueId, action: "issue.created" }));
    contaminated.push(await event(db, foreign, { entityType: "chat", entityId: foreignChat, action: "chat.issue_converted", details: { issueId } }));
    contaminated.push(await event(db, orgId, { entityType: "chat", entityId: foreignChat, action: "chat.context_linked", details: { entityType: "issue", entityId: issueId } }));
    contaminated.push(await event(db, foreign, { entityType: "chat", entityId: local[1], action: "chat.issue_converted", details: { issueId } }));
    contaminated.push(await event(db, orgId, { entityType: "chat", entityId: badLink, action: "chat.created", details: { contextLinkCount: 1 } }));
    for (const value of ['{"nested":'+"[".repeat(600)+'9007199254740993'+"]".repeat(600)+'}', '"{\\"title\\":\\"Encoded\\",\\"status\\":\\"done\\"}"', '[1,true,{"$serde_json::private::RawValue":"literal"}]', '"😀x"', 'null']) {
      const id = await event(db, orgId, { entityType: "issue", entityId: issueId, action: "issue.comment_added" });
      await db.execute(sql`UPDATE activity_log SET details=${value}::jsonb WHERE id=${id}::uuid`);
    }
    for (const value of [String.fromCharCode(0xd800), { [String.fromCharCode(0xd800)]: "value" }]) {
      const id = await event(db, orgId, { actorId: "surrogate", entityType: "issue", entityId: issueId, action: "issue.comment_added" });
      await db.execute(sql`UPDATE activity_log SET details=${JSON.stringify(JSON.stringify(value))}::jsonb WHERE id=${id}::uuid`);
    }
    await db.insert(activityLog).values(Array.from({ length: 130 }, (_, index) => ({ orgId: volume, actorType: "system", actorId: "volume", action: "project.updated", entityType: "project", entityId: String(index), createdAt: new Date("2026-04-01T10:00:00Z"), details: index === 0 ? { payload: "x".repeat(1_050_000) } : null })));
    const dateChat = randomUUID();
    await db.execute(sql`INSERT INTO chat_conversations(id,org_id,title) VALUES (${dateChat}::uuid,${orgId}::uuid,'Historical')`);
    const historicalSources = [
      ["2027","2027","0099","0099","0099","0049","0049","0032","0032","0032","0031","0001","0001","0001"],
      ["2027","2027","0099","0049","0049","0032","BC"],
    ];
    for (const [source, years] of historicalSources.entries()) for (const [index, year] of years.entries()) {
      const fraction = String(900000-index).padStart(6,"0");
      const timestamp = year === "BC" ? `0001-01-01 00:00:00.${fraction}+00 BC` : `${year}-01-01T00:00:00.${fraction}Z`;
      const id = await event(db, orgId, { entityType: source ? "chat" : "issue", entityId: source ? dateChat : dateIssue,
        action: source ? "chat.issue_converted" : "issue.created", details: { issueId: dateIssue, position: `${source}:${index}` } });
      await db.execute(sql`UPDATE activity_log SET created_at=${timestamp}::timestamptz WHERE id=${id}::uuid`);
    }
    baseline = await snapshot();
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const buildTarget = path.resolve(repo, process.env.CARGO_TARGET_DIR ?? "native/target");
    const explicitBinary = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicitBinary ? [path.resolve(repo, explicitBinary)]
      : [path.join(buildTarget, "debug", binaryName), path.join(buildTarget, "release", binaryName)];
    const binary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    const listenPort = ingress === "required" ? await port() : 0;
    bridge = createRustFoundationBridge({ databaseUrl: fixture.url, binaryPath: binary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10000,
      ...(ingress === "required" ? { publicIngress: { identityAuth: nativeIdentity.identityAuth, listenAddr: "127.0.0.1:0", nodeUpstream: `http://127.0.0.1:${listenPort}`, authorizationKey: "activity-read-ingress-synthetic-key-32-bytes" } } : {}) });
    server = await startApp(bridge, listenPort); await bridge.start(); target = server;
    if (ingress === "required") { await bridge.waitForPublicIngressReady!(); target = bridge.publicIngressBaseUrl!; }
  }, 120000);
  afterAll(async () => { await close(server); await bridge?.close(); await fixture?.close(); });

  it("pairs deep details and JSONB primitive hydration without a structural depth limit", async () => {
    const expected = await activityService(fixture.db).list({ orgId, entityType: "issue", entityId: issueId });
    const response = await get(`orgs/${orgId}/activity`).query({ entityType: "issue", entityId: issueId });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual(wire(expected));
  });

  it("pairs reparsed JSONB lone UTF-16 surrogate values and property names", async () => {
    const expected = await activityService(fixture.db).list({ orgId, actorId: "surrogate" });
    expect(expected).toHaveLength(2);
    const response = await get(`orgs/${orgId}/activity`).query({ actorId: "surrogate" });
    expect(response.status, response.text).toBe(200);
    expect(response.body).toEqual(wire(expected));
  });

  it("truncates sub-millisecond dates before applying the maximum TimeClip boundary", async () => {
    const { db } = fixture;
    const actorId = `timeclip-${randomUUID()}`;
    const before = await snapshot();
    try {
      for (const stamp of ["275760-09-12T23:59:59.999999Z", "275760-09-13T00:00:00.000000Z", "275760-09-13T00:00:00.000001Z", "275760-09-13T00:00:00.000999Z", "275760-09-13T00:00:00.001000Z"]) {
        await db.insert(activityLog).values({ orgId, actorType: "system", actorId, action: "project.updated", entityType: "project", entityId: stamp, createdAt: sql`${stamp}::timestamptz` });
      }
      const expected = wire(await activityService(db).list({ orgId, actorId }));
      expect(expected.map((row: { createdAt: string | null }) => row.createdAt)).toEqual([
        null, "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "+275760-09-13T00:00:00.000Z", "+275760-09-12T23:59:59.999Z",
      ]);
      const response = await get(`orgs/${orgId}/activity`).query({ actorId });
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(expected);
    } finally {
      await db.delete(activityLog).where(and(eq(activityLog.orgId, orgId), eq(activityLog.actorId, actorId)));
    }
    expect(await snapshot()).toEqual(before);
  });

  it("gives the former 21-row comparator panic a deterministic total order", async () => {
    const legacy = await legacyIssueActivity(fixture.db, dateIssue);
    expect(legacy).toHaveLength(21);
    const expectedPositions = process.env.RUDDER_ACTIVITY_TEST_TIMEZONE === "Pacific/Honolulu"
      ? ["0:0", "1:0", "0:1", "1:1", ...Array.from({ length: 12 }, (_, i) => `0:${i + 2}`), ...Array.from({ length: 5 }, (_, i) => `1:${i + 2}`)]
      : ["0:5", "0:6", "1:3", "1:4", "0:7", "0:8", "0:9", "1:5", "0:0", "1:0", "0:1", "1:1", "0:11", "0:12", "0:13", "0:2", "0:3", "0:4", "1:2", "0:10", "1:6"];
    const byPosition = new Map(legacy.map((row) => [(row.details as { position: string }).position, row]));
    const expected = expectedPositions.map((position) => byPosition.get(position));
    for (let repeat = 0; repeat < 3; repeat++) {
      const response = await get(`issues/${dateIssue}/activity`);
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(wire(expected));
    }
  });

  it("retains full raw historical timestamps and source precedence for parsed millisecond ties", async () => {
    await orderingFixture([
      { source: "issue", stamp: "2032-01-01T00:00:00.000100Z", label: "modern" },
      { source: "issue", stamp: "0032-01-01T00:00:00.000900Z", label: "ancient" },
      { source: "chat", stamp: "2032-01-01T00:00:00.000999Z", label: "chat" },
    ], async (issue) => {
      const old = await legacyIssueActivity(fixture.db, issue);
      const response = await get(`issues/${issue}/activity`);
      expect(response.status, response.text).toBe(200);
      const expected = process.env.RUDDER_ACTIVITY_TEST_TIMEZONE === "Pacific/Honolulu"
        ? ["modern", "chat", "ancient"] : ["modern", "ancient", "chat"];
      expect(response.body.map((row: { details: { label: string } }) => row.details.label)).toEqual(expected);
      const byLabel = new Map(old.map((row) => [(row.details as { label: string }).label, row]));
      expect(response.body).toEqual(wire(expected.map((label) => byLabel.get(label))));
    });
  });

  it("orders all-invalid dates by source, full raw timestamp and UUID without dropping rows", async () => {
    const stamps = ["infinity", "294276-01-01T00:00:00Z", "0031-01-01T00:00:00Z", "0001-01-01 00:00:00+00 BC", "-infinity"];
    const rows = (["issue", "chat"] as const).flatMap((source) => stamps.map((stamp, index) => ({ source, stamp, label: `${source}:${index}` })));
    await orderingFixture(rows, async (issue) => {
      for (let repeat = 0; repeat < 3; repeat++) {
        const response = await get(`issues/${issue}/activity`);
        expect(response.status, response.text).toBe(200);
        expect(response.body.map((row: { details: { label: string } }) => row.details.label)).toEqual(rows.map((row) => row.label));
        expect(response.body.every((row: { createdAt: null }) => row.createdAt === null)).toBe(true);
      }
    });
  });

  it("uses descending UUID only after exact raw timestamps and source rank tie", async () => {
    const stamp = "2032-01-01T00:00:00.000100Z";
    await orderingFixture([
      { source: "issue", stamp, label: "issue-low", id: "85000000-0000-4000-8000-000000000001" },
      { source: "chat", stamp, label: "chat-high", id: "85000000-0000-4000-8000-000000000004" },
      { source: "issue", stamp, label: "issue-high", id: "85000000-0000-4000-8000-000000000003" },
      { source: "chat", stamp, label: "chat-low", id: "85000000-0000-4000-8000-000000000002" },
    ], async (issue) => {
      const response = await get(`issues/${issue}/activity`);
      expect(response.status, response.text).toBe(200);
      expect(response.body.map((row: { details: { label: string } }) => row.details.label)).toEqual(["issue-high", "issue-low", "chat-high", "chat-low"]);
    });
  });

  it("keeps large unbounded multi-source Issue responses complete", async () => {
    const rows = Array.from({ length: 130 }, (_, index) => ({ source: index % 2 ? "chat" as const : "issue" as const,
      stamp: "2032-01-01T00:00:00.000100Z", label: String(index), id: randomUUID(), ...(index === 0 ? { payload: "x".repeat(1_050_000) } : {}) }));
    const expected = (["issue", "chat"] as const).flatMap((source) => rows.filter((row) => row.source === source).sort((a, b) => b.id.localeCompare(a.id)).map((row) => row.id));
    await orderingFixture(rows, async (issue) => {
      const response = await get(`issues/${issue}/activity`);
      expect(response.status, response.text.slice(0, 200)).toBe(200);
      expect(response.text.length).toBeGreaterThan(1024 * 1024);
      expect(response.body.map((row: { id: string }) => row.id)).toEqual(expected);
    });
  });

  it("preserves list, page boundaries, cursors and all filter intersections", async () => {
    const svc = activityService(fixture.db);
    for (const filter of [{}, { agentId }, { userId: " reader " }, { actorType: "system" as const }, { actorId: " reader " }, { entityType: "issue" }, { entityId: issueId }, { agentId, userId: " reader " }, { actorType: "system" as const, actorId: "associated", agentId }]) {
      const response = await get(`orgs/${orgId}/activity`).query(filter);
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(wire(await svc.list({ orgId, ...filter })));
    }
    let cursor: string | null = null;
    for (let index=0; index<50; index++) {
      const query = { limit: "2", ...(cursor ? { cursor } : {}) };
      const response = await get(`orgs/${orgId}/activity`).query(query);
      expect(response.status, response.text).toBe(200);
      const expected = await svc.listPage({ orgId, limit: 2, cursor });
      expect(response.body).toEqual(wire(expected));
      cursor = response.body.nextCursor;
      if (!cursor) break;
      expect(index).toBeLessThan(49);
    }
  });

  it("isolates native Issue activity while preserving same-org Chat order and reference aliases", async () => {
    const old = await legacyIssueActivity(fixture.db, issueId);
    expect(old.filter((row) => contaminated.includes(row.id))).toHaveLength(5);
    const expected = wire(old.filter((row) => !contaminated.includes(row.id)));
    for (const ref of [issueId, "act-1", "OLD-1"]) {
      const response = await get(`issues/${ref}/activity`);
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual(expected);
    }
    expect(expected.filter((row: { id: string; entityType: string }) => row.entityType === "chat" && !contaminated.includes(row.id)).map((row: { action: string }) => row.action).sort())
      .toEqual(["chat.context_linked", "chat.created", "chat.issue_converted"]);
    const hidden = await get(`issues/${hiddenId}/activity`);
    expect(hidden.status).toBe(200);
    expect(hidden.body).toEqual(wire(await legacyIssueActivity(fixture.db, hiddenId)));
    expect(await activityService(fixture.db).forIssue(issueId, foreign)).toEqual([]);
  });

  it("keeps public auth, empty/missing results, query acceptance and fail-closed ownership", async () => {
    expect((await request(target).get(`/api/orgs/${orgId}/activity`)).status).toBe(401);
    for (const token of [agentToken, boardToken]) expect((await get(`orgs/${foreign}/activity`, token)).status).toBe(403);
    for (const token of [agentToken, boardToken]) expect((await get(`issues/${foreignIssue}/activity`, token)).status).toBe(403);
    expect((await get(`orgs/${empty}/activity`, boardToken)).body).toEqual([]);
    expect((await get(`issues/${randomUUID()}/activity`)).body).toEqual({ error: "Issue not found" });
    for (const limit of ["0x10", "1e1", "100"]) {
      const response = await get(`orgs/${orgId}/activity`).query({ limit });
      expect(response.status).toBe(200); expect(response.body.items).toBeInstanceOf(Array);
    }
    for (const cursor of [" ", ["one","two"]]) expect((await get(`orgs/${orgId}/activity`).query({ cursor })).body).toBeInstanceOf(Array);
    expect((await get(`orgs/${orgId}/activity`).query({ limit: ["1","2"] })).status).toBe(400);
    expect((await get(`orgs/${orgId}/activity`).query({ limit: "101" })).status).toBe(400);
    expect((await get(`orgs/${orgId}/activity`).query({ cursor: "invalid" })).body.error).toBe("Activity cursor is invalid or expired");
    if (ingress === "required") {
      const nativeActivityRead = bridge.activityRead;
      bridge.activityRead = undefined;
      try {
        expect((await get(`orgs/${orgId}/activity`)).status).toBe(503);
        expect((await get(`issues/${issueId}/activity`)).status).toBe(503);
      } finally { bridge.activityRead = nativeActivityRead; }
    } else {
      const unavailable = await startApp();
      try {
        expect((await get(`orgs/${orgId}/activity`,agentToken,unavailable)).status).toBe(503);
        expect((await get(`issues/${issueId}/activity`,agentToken,unavailable)).status).toBe(503);
      } finally { await close(unavailable); }
    }
    expect(await snapshot()).toEqual(baseline);
  });

  it("preserves unbounded large responses, exact timestamp UUID ties, and cursor-only default pages", async () => {
    const svc = activityService(fixture.db);
    const response = await get(`orgs/${volume}/activity`, boardToken);
    expect(response.status, response.text.slice(0,300)).toBe(200);
    expect(response.text.length).toBeGreaterThan(1024*1024);
    expect(response.body).toHaveLength(130);
    expect(response.body).toEqual(wire(await svc.list({ orgId: volume })));
    const first = await get(`orgs/${volume}/activity`, boardToken).query({ limit: "100" });
    expect(first.body).toEqual(wire(await svc.listPage({ orgId: volume, limit: 100 })));
    const next = await get(`orgs/${volume}/activity`, boardToken).query({ cursor: first.body.nextCursor });
    expect(next.body).toEqual(wire(await svc.listPage({ orgId: volume, cursor: first.body.nextCursor })));
    expect(next.body.items).toHaveLength(30);
    expect(next.body.nextCursor).toBeNull();
  });

  it("rechecks the signed organization for private Issue reads", async () => {
    const wrongScope = await bridge.activityRead!({ type: "agent", agentId, orgId }, orgId, { operation: "issue", issueId: foreignIssue });
    expect(wrongScope.status).toBe(200);
    expect(JSON.parse(wrongScope.body.toString())).toEqual([]);
    const missing = await bridge.activityRead!({ type: "agent", agentId, orgId }, orgId, { operation: "issue", issueId: randomUUID() });
    expect(missing.status).toBe(200);
    expect(JSON.parse(missing.body.toString())).toEqual([]);
    expect((await get(`orgs/${orgId}/activity`)).status).toBe(200);
  });

  it("checks live Board membership on every Activity read", async () => {
    const membership = and(eq(organizationMemberships.orgId, orgId), eq(organizationMemberships.principalType, "user"), eq(organizationMemberships.principalId, userId));
    const routes = [`orgs/${orgId}/activity`, `issues/${issueId}/activity`];
    for (const route of routes) expect((await get(route, boardToken)).status).toBe(200);
    try {
      await fixture.db.update(organizationMemberships).set({ status: "inactive" }).where(membership);
      for (const route of routes) {
        expect((await get(route, boardToken)).status).toBe(403);
        expect((await get(route, agentToken)).status).toBe(200);
      }
    } finally {
      await fixture.db.update(organizationMemberships).set({ status: "active" }).where(membership);
    }
    for (const route of routes) expect((await get(route, boardToken)).status).toBe(200);
    expect(await snapshot()).toEqual(baseline);
  });

  it.each(["delete", "move"] as const)("rechecks the current issue after route resolution and a %s before native dispatch", async (mutation) => {
    const { db } = fixture;
    const racedIssue = randomUUID();
    await db.insert(issues).values({ id: racedIssue, orgId, title: "Deleted after reference resolution" });
    const racedEvent = await event(db, orgId, { entityType: "issue", entityId: racedIssue, action: "issue.created" });
    let intercepted = false;
    const mutateAfterResolution = async () => {
      intercepted = true;
      if (mutation === "delete") await db.delete(issues).where(eq(issues.id, racedIssue));
      else await db.update(issues).set({ orgId: foreign }).where(eq(issues.id, racedIssue));
    };
    const raced = ingress === "required" ? undefined : await startApp(bridge, 0, mutateAfterResolution);
    try {
      activeIssueReadHook = ingress === "required" ? mutateAfterResolution : null;
      const response = await get(`issues/${racedIssue}/activity`, agentToken, raced ?? target);
      expect(intercepted).toBe(true);
      expect(response.status, response.text).toBe(200);
      expect(response.body).toEqual([]);
      expect((await legacyIssueActivity(db, racedIssue)).map((row) => row.id)).toEqual([racedEvent]);
    } finally {
      activeIssueReadHook = null;
      await close(raced);
      await db.delete(activityLog).where(eq(activityLog.id, racedEvent));
      await db.delete(issues).where(eq(issues.id, racedIssue));
    }
    expect(await snapshot()).toEqual(baseline);
  });

});
