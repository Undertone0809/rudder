import {
  agentApiKeys,
  agents,
  applyPendingMigrations,
  authUsers,
  boardApiKeys,
  chatConversations,
  chatConversationUserStates,
  createDb,
  ensurePostgresDatabase,
  issueFollows,
  issues,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  messengerSavedViews,
  messengerThreadUserStates,
  organizationMemberships,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey, type KeepMessengerSavedView, type MessengerSavedViewTarget } from "@rudderhq/shared";
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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { messengerRoutes } from "../routes/messenger.js";
import { chatService } from "../services/chats.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  messengerSavedViewCanonicalResourceKey,
  messengerSavedViewResourceKey,
  messengerSavedViewsService,
} from "../services/messenger-saved-views.js";
import { messengerService } from "../services/messenger.js";
import { startOrganizationMutationOutboxPublisher } from "../services/organization-mutation-outbox.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";

// Intentionally not conditional/skipped: a real candidate binary and disposable
// PostgreSQL are prerequisites. No bridge, route, service, fetch, or DB mocks.
// RUDDER_HOME=/tmp/rudder-messenger-state-test RUDDER_SERVER_FOUNDATION_PATH=/tmp/rudder-messenger-state-foundation \
//   pnpm exec vitest run --root server --config vitest.config.ts \
//   src/__tests__/messenger-state-rust.integration.test.ts

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags: string[]; postgresFlags: string[]; onLog: () => void; onError: () => void;
}) => EmbeddedPostgresInstance;
type JsonRow = Record<string, unknown>;
type Snapshot = Record<string, JsonRow[]>;
type Result = { status: number; body: unknown };
type Method = "get" | "post" | "patch" | "delete";
const tables = [
  "messenger_custom_groups", "messenger_saved_views", "messenger_custom_group_entries",
  "messenger_saved_view_mutations", "messenger_thread_user_states", "chat_conversation_user_states", "activity_log",
] as const;
const timestampKeys = new Set([
  "createdAt", "updatedAt", "pinnedAt", "primaryRailPinnedAt", "hiddenAt", "lastReadAt",
  "created_at", "updated_at", "pinned_at", "primary_rail_pinned_at", "hidden_at", "last_read_at",
]);
const jsonKeys = new Set(["targetPayload", "target_payload", "details", "payload"]);
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
};
async function port() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("No disposable test port");
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
async function closeServer(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe("Messenger state through public HTTP, real Rust and disposable PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let database: EmbeddedPostgresInstance | undefined;
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let home = "";
  let dataDir = "";
  let connectionString = "";
  let nativeBinary = "";
  let baseline: Snapshot;
  let baselineIds = new Set<string>();
  const originalHome = process.env.RUDDER_HOME;
  const originalInstance = process.env.RUDDER_INSTANCE_ID;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const userId = `messenger-owner-${randomUUID()}`;
  const otherUserId = `messenger-other-${randomUUID()}`;
  const agentId = randomUUID();
  const token = `messenger-board-${randomUUID()}`;
  const otherToken = `messenger-other-${randomUUID()}`;
  const agentToken = `messenger-agent-${randomUUID()}`;
  const groupId = randomUUID();
  const singletonGroupId = randomUUID();
  const foreignGroupId = randomUUID();
  const otherGroupId = randomUUID();
  const viewIds = Array.from({ length: 7 }, () => randomUUID());
  const chatId = randomUUID();
  const hiddenChatId = randomUUID();
  const foreignChatId = randomUUID();
  const issueId = randomUUID();
  const privateIssueId = randomUUID();
  const followedIssueId = randomUUID();
  const notificationIssueId = randomUUID();
  const foreignIssueId = randomUUID();
  const early = new Date("2024-02-29T12:34:56.123+08:00");
  const later = new Date("2024-03-01T01:02:03.456-07:00");
  const prefix = `/api/orgs/${orgId}/messenger`;
  const fixed = { createdAt: early, updatedAt: later };
  const baseTarget: MessengerSavedViewTarget = { kind: "browser", tabId: "浏览器-☃", url: "https://例子.测试/a?b=%E2%98%83#片段", viewInstanceId: "existing-browser" };

  async function startApp(selectedBridge: RustFoundationBridge) {
    const app = express();
    app.use(express.json());
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", messengerRoutes(db, selectedBridge));
    app.use(errorHandler);
    const result = app.listen(0, "127.0.0.1");
    await once(result, "listening");
    return result;
  }
  async function http(method: Method, suffix: string, body?: unknown, selectedToken = token, target = server!) {
    const req = request(target)[method](suffix.startsWith("/api/") ? suffix : `${prefix}${suffix}`);
    if (selectedToken) req.set("authorization", `Bearer ${selectedToken}`);
    const result = await (body === undefined ? req : req.send(body));
    return { status: result.status, body: result.body };
  }
  async function legacy(action: () => Promise<unknown>, status = 200): Promise<Result> {
    try { return { status, body: wire(await action()) }; }
    catch (error) {
      if (error instanceof HttpError) return { status: error.status, body: { error: error.message, ...(error.details ? { details: error.details } : {}) } };
      throw error;
    }
  }
  async function snapshot(): Promise<Snapshot> {
    const state: Snapshot = {};
    for (const table of tables) {
      const result = await db.execute(sql.raw(`SELECT to_jsonb(t) AS value FROM "${table}" t ORDER BY id`));
      state[table] = result.map((row) => row.value as JsonRow);
    }
    return state;
  }
  async function reset() {
    // Only this suite's private, newly created database is ever reset.
    await db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM organization_mutation_outbox`);
      for (const table of [...tables].reverse()) await tx.execute(sql.raw(`DELETE FROM "${table}"`));
      for (const table of tables) {
        await tx.execute(sql`INSERT INTO ${sql.identifier(table)} SELECT * FROM ${sql.identifier(`_messenger_test_baseline_${table}`)}`);
      }
    });
  }
  function canonical(result: unknown, state: Snapshot, events: unknown[]) {
    const aliases = new Map<string, string>();
    const replace = (input: string) => {
      let value = input;
      for (const [id, alias] of aliases) value = value.replaceAll(id, alias);
      return value;
    };
    // UUID normalization is confined to generated row primary keys. Existing
    // IDs, user IDs, client mutation IDs and arbitrary JSON values stay exact.
    const identity: Record<string, (r: JsonRow) => unknown> = {
      messenger_custom_groups: (r) => [r.org_id, r.user_id, r.name, r.sort_order],
      messenger_saved_views: (r) => [r.org_id, r.user_id, r.instance_id],
      messenger_custom_group_entries: (r) => [r.org_id, r.user_id, r.thread_key],
      messenger_saved_view_mutations: (r) => [r.org_id, r.user_id, r.client_mutation_id],
      messenger_thread_user_states: (r) => [r.org_id, r.user_id, r.thread_key],
      chat_conversation_user_states: (r) => [r.org_id, r.user_id, r.conversation_id],
      activity_log: (r) => [r.org_id, r.action, r.entity_id, r.details, r.idempotency_key],
    };
    for (const table of tables) {
      const counts = new Map<string, number>();
      for (const row of state[table]) {
        const id = String(row.id);
        if (baselineIds.has(id)) continue;
        const key = replace(stable(identity[table](row)));
        const occurrence = counts.get(key) ?? 0;
        counts.set(key, occurrence + 1);
        aliases.set(id, `<${table}:${key}:${occurrence}>`);
      }
    }
    // Deleted generated rows can survive only in an earlier response. Bind
    // those generated IDs by their response position, retaining all references.
    const collect = (value: unknown, location = "response") => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach((item, index) => collect(item, `${location}[${index}]`)); return; }
      const row = value as JsonRow;
      if (typeof row.id === "string" && !baselineIds.has(row.id) && !aliases.has(row.id)) aliases.set(row.id, `<${location}.id>`);
      for (const [key, entry] of Object.entries(row)) if (!jsonKeys.has(key)) collect(entry, `${location}.${key}`);
    };
    collect(result);
    const normalize = (value: unknown, inJson = false): unknown => {
      if (typeof value === "string") return replace(value);
      if (Array.isArray(value)) return value.map((entry) => normalize(entry, inJson));
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
        if (!inJson && timestampKeys.has(key) && typeof entry === "string") {
          const date = new Date(entry);
          expect(Number.isFinite(date.getTime()), `valid timestamp ${key}`).toBe(true);
          // Only mutation-time timestamps are volatile. Fixture dates, epoch
          // read positions, nulls and JSON-embedded dates are never discarded.
          if (date.getTime() > later.getTime()) {
            expect(Math.abs(Date.now() - date.getTime()), `recent mutation timestamp ${key}`).toBeLessThan(120_000);
            return [key, "<mutation-time>"];
          }
          return [key, date.toISOString()];
        }
        return [key, normalize(entry, inJson || jsonKeys.has(key))];
      }));
    };
    const normalizedState = Object.fromEntries(tables.map((table) => [table, (normalize(state[table]) as unknown[]).sort((a, b) => stable(a).localeCompare(stable(b)))]));
    return { result: normalize(result), state: normalizedState, events: (normalize(events) as unknown[]).sort((a, b) => stable(a).localeCompare(stable(b))) };
  }
  async function capture(action: () => Promise<unknown>, native: boolean) {
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(orgId, (event) => {
      if (event.type === "activity.logged") events.push({ orgId: event.orgId, type: event.type, payload: event.payload });
    });
    try {
      const result = await action();
      if (native) {
        const publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000, batchSize: 500 });
        try { await publisher.drain(); } finally { await publisher.close(); }
        const pending = await db.execute(sql`SELECT count(*)::int AS count FROM organization_mutation_outbox WHERE state <> 'published'`);
        expect(pending[0].count).toBe(0);
      }
      return canonical(result, await snapshot(), events);
    } finally { unsubscribe(); }
  }
  async function differential(old: () => Promise<unknown>, native: () => Promise<unknown>) {
    const expected = await capture(old, false);
    await reset();
    const actual = await capture(native, true);
    expect(actual).toEqual(expected);
    return actual;
  }
  function keepInput(overrides: Partial<KeepMessengerSavedView> = {}): KeepMessengerSavedView {
    return {
      target: { kind: "browser", tabId: "new-tab-雪", url: "https://example.test/a?q=雪#☃", viewInstanceId: "new-browser-雪" },
      title: "资料 🧭 e\u0301", subtitle: null, favicon: "data:image/svg+xml,<svg>☃</svg>",
      clientMutationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", placement: { kind: "group", groupId }, ...overrides,
    };
  }

  beforeAll(async () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const target = path.resolve(root, process.env.CARGO_TARGET_DIR ?? "native/target");
    const name = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicit = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicit ? [path.resolve(root, explicit)] : [path.join(target, "debug", name), path.join(target, "release", name)];
    nativeBinary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    if (!fs.existsSync(nativeBinary)) throw new Error(`Real Messenger state integration requires a built foundation binary at ${nativeBinary}. Build rudder-server-foundation or set RUDDER_SERVER_FOUNDATION_PATH.`);
    fs.accessSync(nativeBinary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    home = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-messenger-state-home-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-messenger-state-pg-"));
    process.env.RUDDER_HOME = home;
    process.env.RUDDER_INSTANCE_ID = "messenger-state-test";
    const databasePort = await port();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({ databaseDir: dataDir, user: "rudder", password: "rudder", port: databasePort, persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"], postgresFlags: ["-k", ""], onLog: () => {}, onError: () => {} });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${databasePort}/postgres`, "rudder");
    connectionString = `postgres://rudder:rudder@127.0.0.1:${databasePort}/rudder`;
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
    await db.execute(sql`ALTER DATABASE rudder SET timezone TO 'Pacific/Honolulu'`);
    await db.$client.end({ timeout: 5 });
    db = createDb(connectionString);
    await db.insert(organizations).values([
      { id: orgId, name: "Messenger state", urlKey: deriveOrganizationUrlKey("Messenger state"), issuePrefix: "MSG" },
      { id: foreignOrgId, name: "Foreign messenger", urlKey: deriveOrganizationUrlKey("Foreign messenger"), issuePrefix: "FOR" },
    ]);
    await db.insert(authUsers).values([
      { id: userId, name: "State owner", email: "state-owner@example.test", ...fixed },
      { id: otherUserId, name: "Other owner", email: "state-other@example.test", ...fixed },
    ]);
    await db.insert(organizationMemberships).values([userId, otherUserId].map((id) => ({ orgId, principalId: id, principalType: "user", status: "active", membershipRole: "member" })));
    await db.insert(boardApiKeys).values([{ userId, name: "State test", keyHash: createHash("sha256").update(token).digest("hex") }, { userId: otherUserId, name: "Other state test", keyHash: createHash("sha256").update(otherToken).digest("hex") }]);
    await db.insert(agents).values({ id: agentId, orgId, name: "Agent", role: "general", status: "idle" });
    await db.insert(agentApiKeys).values({ orgId, agentId, name: "Agent state test", keyHash: createHash("sha256").update(agentToken).digest("hex") });
    await db.insert(chatConversations).values([
      { id: chatId, orgId, title: "聊天 🧭 e\u0301", createdByUserId: userId, lastMessageAt: early, ...fixed },
      { id: hiddenChatId, orgId, title: "Private side chat", createdByUserId: otherUserId, messengerVisible: false, ...fixed },
      { id: foreignChatId, orgId: foreignOrgId, title: "Foreign chat", ...fixed },
    ]);
    await db.insert(issues).values([
      { id: issueId, orgId, title: "Assigned", assigneeUserId: userId, ...fixed },
      { id: privateIssueId, orgId, title: "Someone else's issue", createdByUserId: otherUserId, ...fixed },
      { id: followedIssueId, orgId, title: "Followed automation", originKind: "automation_execution", ...fixed },
      { id: notificationIssueId, orgId, title: "Notified automation", originKind: "automation_execution", ...fixed },
      { id: foreignIssueId, orgId: foreignOrgId, title: "Foreign", assigneeUserId: userId, ...fixed },
    ]);
    await db.insert(issueFollows).values({ orgId, issueId: followedIssueId, userId, ...fixed });
    await db.execute(sql`INSERT INTO activity_log (id,org_id,actor_type,actor_id,action,entity_type,entity_id,details,created_at) VALUES (${randomUUID()}::uuid,${orgId}::uuid,'system','test','automation.issue_created_notification','issue',${notificationIssueId},${JSON.stringify({ userId })}::jsonb,${early.toISOString()}::timestamptz)`);
    await db.insert(messengerCustomGroups).values([
      { id: groupId, orgId, userId, name: "项目组 🧭", icon: "folder", sortOrder: 4, pinnedAt: early, ...fixed },
      { id: singletonGroupId, orgId, userId, name: "Single", sortOrder: 8, ...fixed },
      { id: foreignGroupId, orgId: foreignOrgId, userId, name: "Foreign", sortOrder: 0, ...fixed },
      { id: otherGroupId, orgId, userId: otherUserId, name: "Other", sortOrder: 0, ...fixed },
    ]);
    const targets: MessengerSavedViewTarget[] = [
      baseTarget,
      { kind: "library_file", filePath: "资料/隐藏.md", viewInstanceId: "hidden-library" },
      { kind: "local_app", desktopInstallationId: "desktop-雪", appPublicId: "终端", localBindingId: "binding-☃", viewInstanceId: "local-app" },
      { kind: "library_directory", directoryPath: "", viewInstanceId: "root-library" },
      { kind: "browser", tabId: "foreign", url: "https://example.test/foreign", viewInstanceId: "foreign" },
      { kind: "browser", tabId: "other", url: "https://example.test/other", viewInstanceId: "other" },
      { kind: "library_document", documentId: randomUUID(), viewInstanceId: "singleton-document" },
    ];
    await db.insert(messengerSavedViews).values(targets.map((target, index) => ({
      id: viewIds[index], orgId: index === 4 ? foreignOrgId : orgId, userId: index === 5 ? otherUserId : userId,
      targetKind: target.kind, targetPayload: target, resourceKey: messengerSavedViewResourceKey(target), instanceId: target.viewInstanceId,
      canonicalResourceKey: messengerSavedViewCanonicalResourceKey(target), title: `视图 ${index} 🧭 e\u0301`, subtitle: index === 0 ? "" : null, favicon: index === 0 ? "data:image/svg+xml,<svg>☃</svg>" : null,
      sortOrder: [3, 7, 11, 19, 0, 0, 23][index], hiddenAt: index === 1 ? early : null, primaryRailPinnedAt: index === 2 ? early : null, ...fixed,
    })));
    // Read compatibility must preserve historical payloads even though new
    // writes now have a strict target schema. Keep raw PG numeric values too.
    await db.execute(sql`UPDATE messenger_saved_views SET target_payload = target_payload || ${'{"legacy":{"null":null,"array":[true,false,"雪",{"id":"keep-this-id","updatedAt":"2024-01-01T00:00:00.000Z"}],"big":9007199254740993,"overflow":1e400,"negativeZero":-0.0,"tiny":1e-400}}'}::jsonb WHERE id=${viewIds[0]}::uuid`);
    const deepPayload = `${"[".repeat(192)}{"snow":"雪","empty":{},"array":[],"null":null}${"]".repeat(192)}`;
    await db.execute(sql`UPDATE messenger_saved_views SET target_payload=${deepPayload}::jsonb WHERE id=${viewIds[3]}::uuid`);
    await db.execute(sql`UPDATE messenger_saved_views SET target_payload='null'::jsonb WHERE id=${viewIds[6]}::uuid`);
    await db.insert(messengerCustomGroupEntries).values([
      { id: randomUUID(), orgId, userId, groupId, threadKey: `saved-view:${viewIds[0]}`, sortOrder: 2, ...fixed },
      { id: randomUUID(), orgId, userId, groupId, threadKey: `saved-view:${viewIds[1]}`, sortOrder: 9, ...fixed },
      { id: randomUUID(), orgId, userId, groupId, threadKey: `chat:${chatId}`, sortOrder: 14, ...fixed },
      { id: randomUUID(), orgId, userId, groupId: singletonGroupId, threadKey: `saved-view:${viewIds[6]}`, sortOrder: 3, ...fixed },
    ]);
    await db.insert(messengerThreadUserStates).values({ id: randomUUID(), orgId, userId, threadKey: "issues", lastReadAt: early, pinnedAt: early, ...fixed });
    await db.insert(chatConversationUserStates).values({ id: randomUUID(), orgId, userId, conversationId: chatId, lastReadAt: early, pinnedAt: early, ...fixed });
    baseline = await snapshot();
    for (const table of tables) {
      // Database-native copies preserve JSONB null versus SQL NULL, deep JSON,
      // numeric tokens and sub-millisecond timestamps without a JSON roundtrip.
      await db.execute(sql`CREATE TABLE ${sql.identifier(`_messenger_test_baseline_${table}`)} AS TABLE ${sql.identifier(table)}`);
    }
    baselineIds = new Set(Object.values(baseline).flatMap((rows) => rows.map((row) => String(row.id))));
    bridge = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: nativeBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000 });
    await bridge.start();
    server = await startApp(bridge);
  }, 120_000);

  beforeEach(async () => { await reset(); });
  afterAll(async () => {
    try { await closeServer(server); await bridge?.close(); await db?.$client.end({ timeout: 5 }); await database?.stop(); }
    finally {
      if (home) fs.rmSync(home, { recursive: true, force: true });
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.RUDDER_HOME; else process.env.RUDDER_HOME = originalHome;
      if (originalInstance === undefined) delete process.env.RUDDER_INSTANCE_ID; else process.env.RUDDER_INSTANCE_ID = originalInstance;
    }
  }, 30_000);

  it("returns exact legacy list/get metadata, nested JSON, nulls, Unicode, filters and pageInfo without mutation", async () => {
    const svc = messengerSavedViewsService(db);
    for (const options of [{}, { visibility: "all" as const, limit: 2, offset: 1 }, { visibility: "hidden" as const }, { primaryRailPinned: true }, { limit: 1, offset: 50 }]) {
      const query = new URLSearchParams(Object.entries(options).map(([key, value]) => [key, String(value)]));
      const expected = wire(await svc.list(orgId, userId, options));
      const actual = await http("get", `/saved-views?${query}`);
      expect(actual).toEqual({ status: 200, body: expected });
    }
    for (const id of [viewIds[0], viewIds[1], viewIds[2], viewIds[3]]) expect(await http("get", `/saved-views/${id}`)).toEqual({ status: 200, body: wire(await svc.get(orgId, userId, id)) });
    expect(await snapshot()).toEqual(baseline);
  });

  it("keeps all seven target kinds with exact response, durable fingerprint, placement and audit parity", async () => {
    const targets: MessengerSavedViewTarget[] = [
      keepInput().target,
      { kind: "automation", automationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", viewInstanceId: "new-automation" },
      { kind: "library_document", documentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", viewInstanceId: "new-document" },
      { kind: "library_entry", entryId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", path: "资料/entry", viewInstanceId: "new-entry" },
      { kind: "library_file", filePath: "资料/e\u0301.md", viewInstanceId: "new-file" },
      { kind: "library_directory", directoryPath: "", viewInstanceId: "new-directory" },
      { kind: "local_app", desktopInstallationId: "机\"器", appPublicId: "app\\☃", localBindingId: "绑定", viewInstanceId: "new-app" },
    ];
    for (const target of targets) {
      await reset();
      const input = keepInput({ target, placement: { kind: "loose" }, ...(target.kind === "local_app" ? { primaryRailPinned: true } : {}) });
      await differential(() => legacy(() => messengerSavedViewsService(db).keep(orgId, userId, input), 201), () => http("post", "/saved-views/keep", input));
    }
  }, 30_000);

  it.each(["group", "chat", "issue"] as const)("keeps with %s placement and replays once without duplicate audit", async (placement) => {
    const input = keepInput({ placement: placement === "group" ? { kind: "group", groupId } : { kind: "anchor", anchor: placement === "chat" ? { kind: "chat", conversationId: hiddenChatId } : { kind: "issue", issueId } } });
    // The visible chat is already grouped; a separate visible chat below tests
    // atomic group creation while the existing anchor tests group reuse.
    if (placement === "chat") input.placement = { kind: "anchor", anchor: { kind: "chat", conversationId: chatId } };
    const changed = { ...input, title: "Changed mutation must conflict" };
    await differential(async () => {
      const svc = messengerSavedViewsService(db);
      return [await legacy(() => svc.keep(orgId, userId, input), 201), await legacy(() => svc.keep(orgId, userId, input), 201), await legacy(() => svc.keep(orgId, userId, changed), 201)];
    }, async () => [await http("post", "/saved-views/keep", input), await http("post", "/saved-views/keep", input), await http("post", "/saved-views/keep", changed)]);
  });

  it.each([
    { censorUsernameInLogs: true, locale: "zh-CN" },
    { censorUsernameInLogs: true, unknownLegacyOption: true },
    { censorUsernameInLogs: true, gitIdentity: { name: "ignored legacy value" } },
  ])("preserves activity censorship and malformed-settings fallback: %j", async (general) => {
    const previous = await db.execute(sql`SELECT general::text AS general FROM instance_settings WHERE singleton_key='default'`);
    await db.execute(sql`INSERT INTO instance_settings(singleton_key,general) VALUES('default',${JSON.stringify(general)}::jsonb) ON CONFLICT(singleton_key) DO UPDATE SET general=EXCLUDED.general`);
    try {
      const username = os.userInfo().username;
      const input = keepInput({ target: { ...baseTarget, viewInstanceId: `${username} /home/${username} /Users/${username} é 雪` }, placement: { kind: "loose" } });
      await differential(() => legacy(() => messengerSavedViewsService(db).keep(orgId, userId, input), 201), () => http("post", "/saved-views/keep", input));
    } finally {
      if (previous.length) await db.execute(sql`UPDATE instance_settings SET general=${previous[0].general as string}::jsonb WHERE singleton_key='default'`);
      else await db.execute(sql`DELETE FROM instance_settings WHERE singleton_key='default'`);
    }
  });

  it("retains consumed mutation identity after deleting its result", async () => {
    const input = keepInput();
    const kept = await http("post", "/saved-views/keep", input);
    expect(kept.status).toBe(201);
    const id = (kept.body as { savedView: { id: string } }).savedView.id;
    expect((await http("delete", `/saved-views/${id}`)).status).toBe(200);
    const afterDelete = await snapshot();
    expect((await http("post", "/saved-views/keep", input)).status).toBe(409);
    expect((await http("post", "/saved-views/keep", { ...input, title: "New intent" })).status).toBe(409);
    expect(await snapshot()).toEqual(afterDelete);
    expect(afterDelete.messenger_saved_view_mutations).toHaveLength(1);
  });

  it.each([
    { id: 0, patch: { title: "更新 🧭", subtitle: null, favicon: null } },
    { id: 1, patch: { hidden: false as const } },
    { id: 2, patch: { primaryRailPinned: false } },
    { id: 2, patch: { primaryRailPinned: true } },
    { id: 0, patch: { target: { ...baseTarget, url: "https://example.test/new#雪" } } },
    { id: 0, patch: { target: { ...baseTarget, tabId: "changed-identity" } } },
    { id: 0, patch: { primaryRailPinned: true } },
  ])("updates $id with contract and transactional audit parity: $patch", async ({ id, patch }) => {
    await differential(() => legacy(() => messengerSavedViewsService(db).update(orgId, userId, viewIds[id], patch)), () => http("patch", `/saved-views/${viewIds[id]}`, patch));
  });

  it("reorders only visible slots, keeps hidden positions and appends omitted views", async () => {
    const ids = [viewIds[3], viewIds[0]];
    await differential(() => legacy(() => messengerSavedViewsService(db).reorder(orgId, userId, ids)), () => http("patch", "/saved-views/reorder", { ids }));
    const rows = await snapshot();
    expect(rows.messenger_saved_views.find((row) => row.id === viewIds[1])?.sort_order).toBe(7);
    expect(rows.messenger_saved_views.find((row) => row.id === viewIds[3])?.sort_order).toBe(3);
    const before = await snapshot();
    expect((await http("patch", "/saved-views/reorder", { ids: [viewIds[1]] })).status).toBe(404);
    expect(await snapshot()).toEqual(before);
  });

  it.each([0, 6])("deletes saved view %s, removes membership and cleans an empty group", async (index) => {
    await differential(() => legacy(() => messengerSavedViewsService(db).remove(orgId, userId, viewIds[index])), () => http("delete", `/saved-views/${viewIds[index]}`));
  });

  it("creates and updates custom group metadata, pinning, collapse and sort order", async () => {
    await differential(() => legacy(() => messengerService(db).createCustomGroup(orgId, userId, "新组 🧭", "folder"), 201), () => http("post", "/groups", { name: "新组 🧭", icon: "folder" }));
    await reset();
    const patch = { name: "改名 e\u0301", icon: null, pinned: false, collapsed: true, sortOrder: 37 };
    await differential(() => legacy(() => messengerService(db).updateCustomGroup(orgId, userId, groupId, patch)), () => http("patch", `/groups/${groupId}`, patch));
  });

  it.each(["delete", "separate"] as const)("%s group preserves saved views and exact per-view/group activity", async (operation) => {
    await differential(() => legacy(() => operation === "delete" ? messengerService(db).deleteCustomGroup(orgId, userId, groupId) : messengerService(db).separateCustomGroup(orgId, userId, groupId)), () => http(operation === "delete" ? "delete" : "post", `/groups/${groupId}${operation === "separate" ? "/separate" : ""}`));
    const state = await snapshot();
    expect(state.messenger_saved_views).toEqual(baseline.messenger_saved_views);
    const activity = state.activity_log.filter((row) => row.action === "messenger.custom_group_removed");
    expect(activity).toHaveLength(1);
    expect(activity[0].details).toEqual({ source: `group_${operation}` });
    expect(activity[0].idempotency_key).toBe(`messenger-custom-group-removed:${userId}:${groupId}`);
  });

  it.each([0, 6, "chat", "absent"] as const)("removes entry %s with legacy itemKey and empty-group semantics", async (entry) => {
    const key = entry === "chat" ? `chat:${chatId}` : entry === "absent" ? "issues" : `saved-view:${viewIds[entry]}`;
    await differential(() => legacy(() => messengerService(db).removeThreadFromCustomGroups(orgId, userId, key)), () => http("delete", `/groups/entries/${encodeURIComponent(key)}`));
  });

  it.each(["issues", "approvals", "budget-alerts", "chat", "hidden-chat", "issue", "followed", "notification", "private", "foreign-issue"])("pins and unpins %s with owner access and read-position parity", async (kind) => {
    const key = ({ chat: `chat:${chatId}`, "hidden-chat": `chat:${hiddenChatId}`, issue: `issue:${issueId}`, followed: `issue:${followedIssueId}`, notification: `issue:${notificationIssueId}`, private: `issue:${privateIssueId}`, "foreign-chat": `chat:${foreignChatId}`, "foreign-issue": `issue:${foreignIssueId}` } as Record<string, string>)[kind] ?? kind;
    await differential(async () => {
      const output: Result[] = [];
      for (const pinned of [true, false]) {
        const result = await messengerService(db).setThreadPinned(orgId, userId, key, pinned);
        output.push(result ? { status: 200, body: wire(result) } : { status: 404, body: { error: "Messenger thread not found" } });
      }
      return output;
    }, async () => [await http("post", `/threads/${encodeURIComponent(key)}/user-state`, { pinned: true }), await http("post", `/threads/${encodeURIComponent(key)}/user-state`, { pinned: false })]);
  });

  it("rejects a foreign chat before legacy hydration can create cross-organization state", async () => {
    // The former getById hydrated a per-user state before checking orgId.
    // Preserve its 404 result, intentionally eliminate that unauthorized write.
    expect(await messengerService(db).setThreadPinned(orgId, userId, `chat:${foreignChatId}`, true)).toBeNull();
    const legacyState = await snapshot();
    expect(legacyState.chat_conversation_user_states.some((row) => row.org_id === foreignOrgId && row.conversation_id === foreignChatId && row.user_id === userId)).toBe(true);
    await reset();
    for (const pinned of [true, false]) {
      expect(await http("post", `/threads/${encodeURIComponent(`chat:${foreignChatId}`)}/user-state`, { pinned })).toEqual({ status: 404, body: { error: "Messenger thread not found" } });
      expect(await snapshot()).toEqual(baseline);
      const outbox = await db.execute(sql`SELECT count(*)::int AS count FROM organization_mutation_outbox`);
      expect(outbox[0].count).toBe(0);
    }
  });

  it("rejects cross-organization, other-owner, agent and anonymous access without effects", async () => {
    const calls: [Method, string, unknown?][] = [
      ["get", "/saved-views"], ["get", `/saved-views/${viewIds[0]}`], ["post", "/saved-views/keep", keepInput()],
      ["patch", `/saved-views/${viewIds[0]}`, { title: "attack" }], ["delete", `/saved-views/${viewIds[0]}`], ["patch", "/saved-views/reorder", { ids: [viewIds[0]] }],
      ["post", "/groups", { name: "attack" }], ["patch", `/groups/${groupId}`, { name: "attack" }], ["delete", `/groups/${groupId}`], ["post", `/groups/${groupId}/separate`],
      ["delete", `/groups/entries/${encodeURIComponent(`saved-view:${viewIds[0]}`)}`], ["post", "/threads/issues/user-state", { pinned: true }],
    ];
    for (const [method, suffix, body] of calls) {
      expect((await http(method, suffix, body, agentToken)).status).toBe(403);
      expect((await http(method, suffix, body, "")).status).toBe(401);
      expect((await http(method, `/api/orgs/${foreignOrgId}/messenger${suffix}`, body)).status).toBe(403);
    }
    for (const [method, suffix, body] of calls.filter(([, suffix]) => suffix.includes(viewIds[0]) || suffix.includes(groupId) || suffix === "/saved-views/reorder")) expect((await http(method, suffix, body, otherToken)).status).toBe(404);
    expect((await http("post", "/saved-views/keep", keepInput({ placement: { kind: "group", groupId: otherGroupId } }))).status).toBe(404);
    expect((await http("post", "/saved-views/keep", keepInput({ placement: { kind: "group", groupId: foreignGroupId } }))).status).toBe(404);
    expect((await http("post", "/saved-views/keep", keepInput({ placement: { kind: "anchor", anchor: { kind: "chat", conversationId: hiddenChatId } } }))).status).toBe(404);
    expect(await snapshot()).toEqual(baseline);
  }, 30_000);

  it("isolates identical mutation and view-instance identities across organizations and users", async () => {
    await db.insert(organizationMemberships).values({ orgId: foreignOrgId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    try {
      const input = keepInput({ placement: { kind: "loose" } });
      const first = await http("post", "/saved-views/keep", input);
      const second = await http("post", `/api/orgs/${foreignOrgId}/messenger/saved-views/keep`, input);
      const other = await http("post", "/saved-views/keep", input, otherToken);
      expect([first.status, second.status, other.status]).toEqual([201, 201, 201]);
      const ids = [first, second, other].map((result) => (result.body as { savedView: { id: string } }).savedView.id);
      expect(new Set(ids).size).toBe(3);
      expect((await http("get", `/saved-views/${ids[1]}`)).status).toBe(404);
      expect((await http("get", `/saved-views/${ids[2]}`)).status).toBe(404);
      expect((await http("get", `/api/orgs/${foreignOrgId}/messenger/saved-views/${ids[0]}`)).status).toBe(404);
      const receipts = await db.execute(sql`SELECT org_id::text,user_id FROM messenger_saved_view_mutations WHERE client_mutation_id=${input.clientMutationId}::uuid`);
      expect(receipts).toHaveLength(3);
    } finally {
      await db.execute(sql`DELETE FROM organization_memberships WHERE org_id=${foreignOrgId}::uuid AND principal_type='user' AND principal_id=${userId}`);
    }
  });

  it("validates IDs, strict fields, targets, pagination and duplicate reorder input before writes", async () => {
    for (const [method, suffix, body] of [
      ["get", "/saved-views/not-a-uuid"], ["get", "/saved-views?visibility=private"], ["get", "/saved-views?limit=101"], ["get", "/saved-views?offset=-1"], ["get", "/saved-views?unexpected=true"],
      ["patch", "/saved-views/reorder", { ids: [viewIds[0], viewIds[0]] }], ["patch", `/saved-views/${viewIds[0]}`, { hidden: true }],
      ["post", "/saved-views/keep", { ...keepInput(), userId: otherUserId }], ["post", "/saved-views/keep", keepInput({ target: { ...baseTarget, url: "file:///tmp/secret" } })],
      ["post", "/saved-views/keep", keepInput({ target: { kind: "library_file", filePath: "../escape", viewInstanceId: "escape" } })],
    ] as [Method, string, unknown?][]) expect((await http(method, suffix, body)).status).toBe(400);
    expect((await http("post", "/threads/unknown/user-state", { pinned: true })).status).toBe(404);
    expect((await http("post", "/threads/issues/user-state", {})).body).toEqual({ threadKey: "issues" });
    expect(await snapshot()).toEqual(baseline);
  });

  it("enforces the 100-pin limit atomically under concurrent keep requests", async () => {
    await db.execute(sql`INSERT INTO messenger_saved_views(org_id,user_id,target_kind,target_payload,resource_key,instance_id,canonical_resource_key,title,sort_order,primary_rail_pinned_at)
      SELECT ${orgId}::uuid,${userId},'local_app',jsonb_build_object('kind','local_app','desktopInstallationId','test','appPublicId','app','localBindingId',i::text,'viewInstanceId','pin-'||i), 'view-instance:pin-'||i,'pin-'||i,'pin-resource-'||i,'Pinned',100+i,now() FROM generate_series(1,98) i`);
    const inputs = ["a", "b"].map((suffix) => keepInput({ clientMutationId: randomUUID(), title: `Pin ${suffix}`, target: { kind: "local_app", desktopInstallationId: "test", appPublicId: "app", localBindingId: suffix, viewInstanceId: `last-pin-${suffix}` }, placement: { kind: "loose" }, primaryRailPinned: true }));
    const result = await Promise.all(inputs.map((input) => http("post", "/saved-views/keep", input)));
    expect(result.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(result.find((r) => r.status === 400)?.body).toEqual({ error: "Primary Rail supports up to 100 pinned Local Apps" });
    const rows = await db.execute(sql`SELECT count(*)::int AS count FROM messenger_saved_views WHERE org_id=${orgId}::uuid AND user_id=${userId} AND primary_rail_pinned_at IS NOT NULL`);
    expect(rows[0].count).toBe(100);
    expect((await snapshot()).messenger_saved_view_mutations).toHaveLength(1);
  });

  it("serializes concurrent keep requests and owner reorder against the PostgreSQL advisory lock", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => { acquired = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    const held = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`messenger-saved-views:${orgId}:${userId}`}))`);
      acquired();
      await unblock;
    });
    await locked;
    let finished = 0;
    let releasedAt = 0;
    const input = keepInput();
    const pending = [
      ...Array.from({ length: 6 }, () => http("post", "/saved-views/keep", input).then((value) => { finished += 1; return value; })),
      http("patch", "/saved-views/reorder", { ids: [viewIds[3], viewIds[0]] }).then((value) => { finished += 1; return value; }),
    ];
    try {
      // Observe the actual competing database sessions, rather than treating
      // a fast Promise resolution or a sleep alone as evidence of locking.
      const deadline = Date.now() + 5_000;
      let blocked = 0;
      do {
        const sessions = await db.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory'`);
        blocked = Number(sessions[0].count);
        if (blocked >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      } while (Date.now() < deadline);
      expect(blocked).toBeGreaterThanOrEqual(2);
      expect(finished).toBe(0);
    } finally { releasedAt = Date.now(); release(); await held; }
    const result = await Promise.all(pending);
    expect(result.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201, 200]);
    const ids = result.slice(0, 6).map((r) => (r.body as { savedView: { id: string } }).savedView.id);
    expect(new Set(ids).size).toBe(1);
    const state = await snapshot();
    expect(state.messenger_saved_view_mutations).toHaveLength(1);
    expect(state.messenger_saved_views.filter((row) => row.instance_id === input.target.viewInstanceId)).toHaveLength(1);
    const committedView = state.messenger_saved_views.find((row) => row.instance_id === input.target.viewInstanceId)!;
    expect(new Date(String(committedView.updated_at)).getTime()).toBeGreaterThanOrEqual(releasedAt);
    expect(state.activity_log.filter((row) => row.action === "messenger.saved_view_created")).toHaveLength(1);
    expect(state.messenger_saved_views.find((row) => row.id === viewIds[1])?.sort_order).toBe(7);
  }, 20_000);

  it.each([
    { first: "delete", existingState: false },
    { first: "delete", existingState: true },
    { first: "pin", existingState: false },
    { first: "pin", existingState: true },
  ] as const)("serializes real Chat delete × pin with $first first and existing state=$existingState", async ({ first, existingState }) => {
    const conversationId = randomUUID();
    const threadKey = `chat:${conversationId}`;
    const gateKey = `messenger-delete-pin-test:${randomUUID()}`;
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: "Concurrent Chat", createdByUserId: userId, ...fixed });
    await db.insert(messengerCustomGroupEntries).values({ orgId, userId, groupId, threadKey, sortOrder: 99, ...fixed });
    if (existingState) await db.insert(chatConversationUserStates).values({ orgId, userId, conversationId, lastReadAt: early, ...fixed });

    // Both competitors are real writers: Node chatService.remove performs its
    // DELETE/cascade before owner-locked Messenger cleanup; the pin uses the
    // actual public HTTP -> signed Rust path. A database trigger pauses the
    // first writer at a known point, rather than relying on timing or mocks.
    await db.execute(sql.raw(`CREATE FUNCTION messenger_test_pause_chat_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0])); IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END $$`));
    if (first === "delete") {
      await db.execute(sql.raw(`CREATE TRIGGER zz_messenger_test_pause_chat_race AFTER DELETE ON chat_conversations FOR EACH ROW WHEN (OLD.id='${conversationId}'::uuid) EXECUTE FUNCTION messenger_test_pause_chat_race('${gateKey}')`));
    } else {
      await db.execute(sql.raw(`CREATE TRIGGER zz_messenger_test_pause_chat_race BEFORE INSERT ON chat_conversation_user_states FOR EACH ROW WHEN (NEW.conversation_id='${conversationId}'::uuid) EXECUTE FUNCTION messenger_test_pause_chat_race('${gateKey}')`));
    }
    let release!: () => void;
    let ready!: (pid: number) => void;
    const gateReady = new Promise<number>((resolve) => { ready = resolve; });
    const gateRelease = new Promise<void>((resolve) => { release = resolve; });
    const heldGate = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${gateKey}))`);
      const rows = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
      ready(Number(rows[0].pid));
      await gateRelease;
    });
    const gatePid = await gateReady;
    const settle = <T,>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
    type Blocked = { pid: number; query: string; wait_event_type: string; wait_event: string };
    async function waitBlockedBy(blockerPid: number): Promise<Blocked> {
      const deadline = Date.now() + 5_000;
      do {
        const rows = await db.execute(sql`SELECT pid,query,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=current_database() AND ${blockerPid}::int=ANY(pg_blocking_pids(pid))`);
        if (rows.length > 0) return rows[0] as unknown as Blocked;
        await new Promise((resolve) => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      throw new Error(`No database session blocked by expected writer PID ${blockerPid}`);
    }
    let deletion: Promise<{ value: { id: string } | null; error: unknown }> | undefined;
    let pin: Promise<{ value: Result | null; error: unknown }> | undefined;
    try {
      if (first === "delete") deletion = settle(chatService(db).remove(conversationId));
      else pin = settle(http("post", `/threads/${encodeURIComponent(threadKey)}/user-state`, { pinned: true }));
      const firstWriter = await waitBlockedBy(gatePid);
      expect(firstWriter.wait_event).toBe("advisory");
      if (first === "delete") {
        const cascadeLocks = await db.execute(sql`SELECT 1 FROM pg_locks WHERE pid=${firstWriter.pid} AND relation='chat_conversation_user_states'::regclass AND mode='RowExclusiveLock' AND granted`);
        expect(cascadeLocks.length).toBeGreaterThan(0);
      }
      if (first === "delete") pin = settle(http("post", `/threads/${encodeURIComponent(threadKey)}/user-state`, { pinned: true }));
      else deletion = settle(chatService(db).remove(conversationId));
      const secondWriter = await waitBlockedBy(firstWriter.pid);
      expect(secondWriter.pid).not.toBe(firstWriter.pid);
      expect(secondWriter.wait_event_type).toBe("Lock");
      expect(secondWriter.query.toLowerCase()).toContain("chat_conversations");
      expect(secondWriter.query.toLowerCase()).not.toContain("pg_advisory_xact_lock");
      release();
      await heldGate;
      const [deleted, pinned] = await Promise.all([deletion!, pin!]);
      expect(deleted.error).toBeNull();
      expect(pinned.error).toBeNull();
      expect(deleted.value?.id).toBe(conversationId);
      expect(pinned.value).toEqual(first === "delete"
        ? { status: 404, body: { error: "Messenger thread not found" } }
        : { status: 200, body: { threadKey, pinned: true } });
      const remnants = await db.execute(sql`SELECT
        (SELECT count(*)::int FROM chat_conversations WHERE id=${conversationId}::uuid) AS chats,
        (SELECT count(*)::int FROM chat_conversation_user_states WHERE conversation_id=${conversationId}::uuid) AS states,
        (SELECT count(*)::int FROM messenger_custom_group_entries WHERE thread_key=${threadKey}) AS memberships`);
      expect(remnants[0]).toEqual({ chats: 0, states: 0, memberships: 0 });
    } finally {
      release();
      await heldGate;
      await Promise.allSettled([deletion, pin].filter(Boolean));
      const table = first === "delete" ? "chat_conversations" : "chat_conversation_user_states";
      await db.execute(sql.raw(`DROP TRIGGER zz_messenger_test_pause_chat_race ON ${table}`));
      await db.execute(sql`DROP FUNCTION messenger_test_pause_chat_race()`);
      // Clean up a rejected-candidate run too; this is the test's own new Chat.
      await chatService(db).remove(conversationId);
    }
  }, 20_000);

  it("rolls back view, anchor group, membership, audit and outbox when durable receipt insertion fails", async () => {
    const input = keepInput({ placement: { kind: "anchor", anchor: { kind: "issue", issueId } } });
    const before = await snapshot();
    await db.execute(sql`CREATE FUNCTION messenger_test_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END $$`);
    await db.execute(sql`CREATE TRIGGER messenger_test_fail_receipt BEFORE INSERT ON messenger_saved_view_mutations FOR EACH ROW EXECUTE FUNCTION messenger_test_fail_receipt()`);
    try {
      expect((await http("post", "/saved-views/keep", input)).status).toBe(500);
      expect(await snapshot()).toEqual(before);
      const outbox = await db.execute(sql`SELECT count(*)::int AS count FROM organization_mutation_outbox`);
      expect(outbox[0].count).toBe(0);
    } finally {
      await db.execute(sql`DROP TRIGGER messenger_test_fail_receipt ON messenger_saved_view_mutations`);
      await db.execute(sql`DROP FUNCTION messenger_test_fail_receipt()`);
    }
    expect((await http("post", "/saved-views/keep", input)).status).toBe(201);
  });

  it("persists activity while the publisher is stopped and drains exactly once after restart", async () => {
    const events: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(orgId, (event) => { if (event.type === "activity.logged") events.push(event.payload); });
    let publisher: ReturnType<typeof startOrganizationMutationOutboxPublisher> | undefined;
    try {
      expect((await http("post", "/saved-views/keep", keepInput())).status).toBe(201);
      expect(events).toEqual([]);
      const pending = await db.execute(sql`SELECT state, payload FROM organization_mutation_outbox ORDER BY id`);
      expect(pending).toHaveLength(2);
      expect(pending.every((row) => row.state === "pending")).toBe(true);
      publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });
      await publisher.drain();
      expect(events.map(stable).sort()).toEqual(pending.map((row) => stable(row.payload)).sort());
      await publisher.close();
      publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });
      await publisher.drain();
      expect(events).toHaveLength(2);
      const published = await db.execute(sql`SELECT state, attempts, published_at FROM organization_mutation_outbox`);
      expect(published.every((row) => row.state === "published" && row.attempts === 1 && row.published_at)).toBe(true);
    } finally { await publisher?.close(); unsubscribe(); }
  });

  it("retries a failed durable event publication with the same dedupe key", async () => {
    const deliveries: string[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(orgId, (event) => { if (event.type === "activity.logged") deliveries.push(event.dedupeKey!); });
    const fail = subscribeCompanyLiveEvents(orgId, () => { throw new Error("synthetic transport failure"); });
    let publisher: ReturnType<typeof startOrganizationMutationOutboxPublisher> | undefined;
    try {
      expect((await http("patch", `/saved-views/${viewIds[0]}`, { title: "retry event" })).status).toBe(200);
      publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });
      await publisher.drain();
      await publisher.close();
      const failed = await db.execute(sql`SELECT state,attempts,last_error FROM organization_mutation_outbox`);
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ state: "pending", attempts: 1 });
      expect(failed[0].last_error).toContain("synthetic transport failure");
      fail();
      await db.execute(sql`UPDATE organization_mutation_outbox SET next_attempt_at=now()`);
      publisher = startOrganizationMutationOutboxPublisher(db, { intervalMs: 60_000 });
      await publisher.drain();
      const published = await db.execute(sql`SELECT state,attempts,last_error FROM organization_mutation_outbox`);
      expect(published[0]).toEqual({ state: "published", attempts: 2, last_error: null });
      expect(deliveries).toHaveLength(2);
      expect(deliveries[0]).toMatch(/^organization-mutation-outbox:[0-9a-f-]{36}$/);
      expect(deliveries[0]).toBe(deliveries[1]);
      await publisher.drain();
      expect(deliveries).toHaveLength(2);
    } finally { fail(); unsubscribe(); await publisher?.close(); }
  });

  it("rejects signed unknown operations and owner injection, and derives the owner only from the verified actor", async () => {
    const actor = { type: "board" as const, source: "session" as const, userId };
    for (const input of [
      { operation: "rawSql", sql: "SELECT 1" },
      { operation: "savedViewList", query: {}, userId: otherUserId },
      { operation: "savedViewList", query: { unknown: true } },
      { operation: "savedViewUpdate", id: viewIds[0], patch: { userId: otherUserId } },
    ]) {
      expect((await bridge!.messengerState!(actor, orgId, input as never)).status).toBe(422);
    }
    expect((await bridge!.messengerState!({ type: "agent", source: "api_key", agentId, orgId }, orgId, { operation: "savedViewList", query: {} })).status).toBe(403);
    const response = await bridge!.messengerState!({ ...actor, userId: otherUserId }, orgId, { operation: "savedViewList", query: {} });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString()).items.map((item: { id: string }) => item.id)).toEqual([viewIds[5]]);
    expect(await snapshot()).toEqual(baseline);
  });

  it("keeps Node healthy and fails every migrated endpoint when the actual native binary cannot start", async () => {
    const unavailable = createRustFoundationBridge({ databaseUrl: connectionString, binaryPath: path.join(home, "foundation-does-not-exist"), mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off" });
    const failingServer = await startApp(unavailable);
    const before = await snapshot();
    try {
      expect((await request(failingServer).get("/api/health")).body).toEqual({ status: "ok" });
      for (const [method, suffix, body] of [
        ["get", "/saved-views"], ["get", `/saved-views/${viewIds[0]}`], ["post", "/saved-views/keep", keepInput()],
        ["patch", `/saved-views/${viewIds[0]}`, { title: "must not write" }], ["delete", `/saved-views/${viewIds[0]}`], ["patch", "/saved-views/reorder", { ids: [viewIds[0]] }],
        ["post", "/groups", { name: "must not write" }], ["patch", `/groups/${groupId}`, { name: "must not write" }], ["delete", `/groups/${groupId}`], ["post", `/groups/${groupId}/separate`],
        ["delete", `/groups/entries/${encodeURIComponent(`saved-view:${viewIds[0]}`)}`], ["post", "/threads/issues/user-state", { pinned: true }],
      ] as [Method, string, unknown?][]) {
        const response = await http(method, suffix, body, token, failingServer);
        expect(response.status, `${method} ${suffix}`).toBe(503);
      }
      expect(await snapshot()).toEqual(before);
      expect((await request(failingServer).get("/api/health")).status).toBe(200);
    } finally { await closeServer(failingServer); await unavailable.close(); }
  });
});
