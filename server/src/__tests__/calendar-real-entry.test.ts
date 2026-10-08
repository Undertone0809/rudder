import {
  activityLog, agents, applyPendingMigrations, authUsers, boardApiKeys, calendarEvents, calendarSources,
  chatConversations, createDb, ensurePostgresDatabase, goals, heartbeatRuns,
  organizationMemberships, organizations,
} from "@rudderhq/db";
import {
  createCalendarEventSchema, createCalendarSourceSchema,
  updateCalendarEventSchema, updateCalendarSourceSchema,
} from "@rudderhq/shared";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { calendarRoutes } from "../routes/calendar.js";
import { calendarService } from "../services/calendar.js";
import { createRustFoundationBridge, type RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { calendarBoundaryCases } from "./helpers/calendar-request-boundary.js";

type EmbeddedPostgresInstance = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void> };
type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string; user: string; password: string; port: number; persistent: boolean;
  initdbFlags: string[]; postgresFlags?: string[]; onLog: () => void; onError: () => void;
}) => EmbeddedPostgresInstance;

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function port() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function close(server?: Server) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

describe("Calendar public source and event operations through real Rust and PostgreSQL", () => {
  let db: ReturnType<typeof createDb>;
  let database: EmbeddedPostgresInstance | undefined;
  let dataDir = "";
  let bridge: RustFoundationBridge | undefined;
  let server: Server | undefined;
  let fixtureBinary = "";
  let beforeMutations: Record<string, string>;
  let afterMutations: Record<string, string>;
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const boundaryOrgId = randomUUID();
  const ownerId = `calendar-owner-${randomUUID()}`;
  const otherId = `calendar-other-${randomUUID()}`;
  const foreignId = `calendar-foreign-${randomUUID()}`;
  const ownerToken = `calendar-board-${randomUUID()}`;
  const otherToken = `calendar-board-${randomUUID()}`;
  const foreignToken = `calendar-board-${randomUUID()}`;
  const agentId = randomUUID();
  const boundaryAgentId = randomUUID();
  const foreignAgentId = randomUUID();
  const boundarySourceId = randomUUID();
  const foreignSourceId = randomUUID();
  const foreignGoalId = randomUUID();
  const malformedProjectionRunId = randomUUID();
  const malformedProjectionActivityId = randomUUID();
  let runIds: string[] = [];
  const startAt = "2030-07-01T10:00:00.000Z";
  const endAt = "2030-07-01T11:00:00.000Z";

  function get(url: string, token = ownerToken) {
    return request(server!).get(url).set("authorization", `Bearer ${token}`);
  }

  async function snapshot() {
    const rows: Record<string, string> = {};
    for (const table of ["calendar_sources", "calendar_events", "activity_log", "organization_mutation_outbox"]) {
      const result = await db.execute(sql.raw(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY to_jsonb(x)::text),'[]'::jsonb)::text AS value FROM "${table}" x`));
      rows[table] = String(result[0]?.value ?? "[]");
    }
    return rows;
  }

  beforeAll(async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const targetDir = path.resolve(repo, process.env.CARGO_TARGET_DIR ?? "native/target");
    const binaryName = process.platform === "win32" ? "rudder-server-foundation.exe" : "rudder-server-foundation";
    const explicit = process.env.RUDDER_SERVER_FOUNDATION_PATH?.trim();
    const candidates = explicit ? [path.resolve(repo, explicit)] : [
      path.join(targetDir, "debug", binaryName), path.join(targetDir, "release", binaryName),
    ];
    const binary = candidates.find((candidate) => {
      try { fs.accessSync(candidate, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK); return fs.statSync(candidate).isFile(); }
      catch { return false; }
    }) ?? candidates[0]!;
    fs.accessSync(binary, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-calendar-public-http-"));
    const dbPort = await port();
    const EmbeddedPostgres = (await import("embedded-postgres")).default as EmbeddedPostgresCtor;
    database = new EmbeddedPostgres({ databaseDir: dataDir, user: "rudder", password: "rudder", port: dbPort,
      persistent: true, initdbFlags: ["--encoding=UTF8", "--locale=C"],
      postgresFlags: ["-c", "unix_socket_directories=", "-c", "dynamic_shared_memory_type=mmap"],
      onLog: () => {}, onError: () => {},
    });
    await database.initialise();
    await database.start();
    await ensurePostgresDatabase(`postgres://rudder:rudder@127.0.0.1:${dbPort}/postgres`, "rudder");
    const databaseUrl = `postgres://rudder:rudder@127.0.0.1:${dbPort}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);

    const now = new Date();
    await db.insert(organizations).values([
      { id: orgId, name: "Calendar test", urlKey: `calendar-${orgId.slice(0, 8)}`, issuePrefix: `C${orgId.slice(0, 2).toUpperCase()}` },
      { id: foreignOrgId, name: "Foreign calendar", urlKey: `foreign-${foreignOrgId.slice(0, 8)}`, issuePrefix: `F${foreignOrgId.slice(0, 2).toUpperCase()}` },
      { id: boundaryOrgId, name: "Calendar boundary", urlKey: `boundary-${boundaryOrgId.slice(0, 8)}`, issuePrefix: `B${boundaryOrgId.slice(0, 2).toUpperCase()}` },
    ]);
    await db.insert(agents).values([
      { id: agentId, orgId, name: "Calendar agent", role: "engineer", status: "idle", adapterType: "process" },
      { id: boundaryAgentId, orgId: boundaryOrgId, name: "Boundary agent", role: "engineer", status: "idle", adapterType: "process" },
      { id: foreignAgentId, orgId: foreignOrgId, name: "Foreign agent", role: "engineer", status: "idle", adapterType: "process" },
    ]);
    await db.insert(authUsers).values([
      { id: ownerId, name: "Calendar owner", email: `${ownerId}@example.test`, createdAt: now, updatedAt: now },
      { id: otherId, name: "Calendar peer", email: `${otherId}@example.test`, createdAt: now, updatedAt: now },
      { id: foreignId, name: "Foreign board", email: `${foreignId}@example.test`, createdAt: now, updatedAt: now },
    ]);
    await db.insert(organizationMemberships).values([
      { orgId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "admin" },
      { orgId, principalType: "user", principalId: otherId, status: "active", membershipRole: "admin" },
      { orgId: foreignOrgId, principalType: "user", principalId: foreignId, status: "active", membershipRole: "admin" },
      { orgId: boundaryOrgId, principalType: "user", principalId: ownerId, status: "active", membershipRole: "admin" },
    ]);
    await db.insert(boardApiKeys).values([
      { userId: ownerId, name: "Calendar owner", keyHash: createHash("sha256").update(ownerToken).digest("hex") },
      { userId: otherId, name: "Calendar peer", keyHash: createHash("sha256").update(otherToken).digest("hex") },
      { userId: foreignId, name: "Foreign board", keyHash: createHash("sha256").update(foreignToken).digest("hex") },
    ]);

    const sideChats = [
      { id: randomUUID(), userId: ownerId, title: "Private owner SideChat" },
      { id: randomUUID(), userId: otherId, title: "Private peer SideChat" },
    ];
    const normalChatId = randomUUID();
    await db.insert(chatConversations).values([
      ...sideChats.map((chat) => ({ id: chat.id, orgId, conversationKind: "side_chat", createdByUserId: chat.userId, status: "resolved", sideChatState: "completed", resolvedAt: now, title: chat.title })),
      { id: normalChatId, orgId, conversationKind: "chat", createdByUserId: ownerId, status: "active", title: "Normal conversation" },
    ]);
    runIds = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(heartbeatRuns).values([
      { id: runIds[0], orgId, agentId, status: "running", startedAt: new Date(now.getTime() - 20_000), triggerDetail: "OWNER_PRIVATE_TRIGGER", contextSnapshot: { scene: "side_chat" }, chatConversationId: sideChats[0]!.id },
      { id: runIds[1], orgId, agentId, status: "running", startedAt: new Date(now.getTime() - 20_000), triggerDetail: "PEER_PRIVATE_TRIGGER", contextSnapshot: { scene: "side_chat" }, chatConversationId: sideChats[1]!.id },
      { id: runIds[2], orgId, agentId, status: "running", startedAt: new Date(now.getTime() - 20_000), triggerDetail: "NORMAL_CHAT_TRIGGER", contextSnapshot: { scene: "chat" }, chatConversationId: normalChatId },
      { id: malformedProjectionRunId, orgId, agentId, status: "running", startedAt: new Date(now.getTime() - 20_000), triggerDetail: "Malformed historical projection", contextSnapshot: { issueId: "not-a-uuid" } },
    ]);
    await db.insert(activityLog).values({
      id: malformedProjectionActivityId, orgId, actorType: "user", actorId: ownerId,
      action: "test.calendar_malformed_projection", entityType: "issue", entityId: "not-a-uuid",
      runId: malformedProjectionRunId,
    });
    await db.insert(calendarSources).values([
      { id: boundarySourceId, orgId: boundaryOrgId, type: "rudder_local", name: "Boundary source", ownerType: "user", ownerUserId: ownerId },
      { id: foreignSourceId, orgId: foreignOrgId, type: "rudder_local", name: "Foreign source", ownerType: "user", ownerUserId: foreignId },
    ]);
    await db.insert(goals).values({ id: foreignGoalId, orgId: foreignOrgId, title: "Foreign goal" });

    beforeMutations = await snapshot();
    fixtureBinary = path.join(dataDir, binaryName);
    fs.copyFileSync(binary, fixtureBinary, fs.constants.COPYFILE_FICLONE);
    bridge = createRustFoundationBridge({
      databaseUrl, binaryPath: fixtureBinary, mode: "off", organizationBrandingMode: "off", projectGoalSetMode: "off", requestTimeoutMs: 10_000,
    });
    const app = express();
    app.use(express.json());
    app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", authRequirement: "required" }));
    app.use("/api", calendarRoutes(db, bridge));
    app.use(errorHandler);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    await bridge.start();
  }, 120_000);

  afterAll(async () => {
    try { await close(server); await bridge?.close(); await db?.$client.end({ timeout: 5 }); await database?.stop(); }
    finally { if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true }); }
  }, 30_000);

  it("matches the shared Zod field-boundary corpus and JavaScript date coercion", async () => {
    const sourceFields = [
      "type", "name", "ownerType", "ownerUserId", "ownerAgentId", "externalProvider",
      "externalCalendarId", "visibilityDefault", "status", "syncCursorJson",
    ];
    const sourceBase: Record<string, unknown> = {
      type: "rudder_local", name: "Boundary source", ownerType: "user", ownerUserId: ownerId,
      ownerAgentId: boundaryAgentId, externalProvider: "fixture", externalCalendarId: "calendar",
      visibilityDefault: "full", status: "active", syncCursorJson: { cursor: "safe" },
    };
    const sourceUrl = `/api/orgs/${boundaryOrgId}/calendar/sources`;
    for (const item of calendarBoundaryCases(sourceBase, sourceFields, {
      wrongTypeOverrides: { syncCursorJson: [] }, enumFields: ["type", "ownerType", "visibilityDefault", "status"],
    })) {
      const legacy = createCalendarSourceSchema.safeParse(item.input);
      const response = await request(server!).post(sourceUrl).set("authorization", `Bearer ${ownerToken}`).send(item.input);
      expect(response.status === 400, `${item.field}/${item.variant}: ${response.status} ${response.text}`).toBe(!legacy.success);
      expect(response.status, `${item.field}/${item.variant}: ${response.text}`).toBeLessThan(500);
    }

    const eventFields = [
      "sourceId", "eventKind", "eventStatus", "ownerType", "ownerUserId", "ownerAgentId", "title",
      "description", "startAt", "endAt", "timezone", "allDay", "visibility", "issueId", "projectId",
      "goalId", "approvalId", "heartbeatRunId", "activityId", "sourceMode", "externalProvider",
      "externalCalendarId", "externalEventId", "externalEtag", "externalUpdatedAt",
    ];
    const eventBase: Record<string, unknown> = {
      sourceId: boundarySourceId, eventKind: "human_event", eventStatus: "planned", ownerType: "user",
      ownerUserId: ownerId, ownerAgentId: boundaryAgentId, title: "Boundary event", description: "A description",
      startAt: "2026-10-08T17:00:00.000Z", endAt: "2030-07-01T11:00:00.000Z", timezone: "UTC",
      allDay: false, visibility: "full", issueId: null, projectId: null, goalId: null, approvalId: null,
      heartbeatRunId: null, activityId: null, sourceMode: "manual", externalProvider: "fixture",
      externalCalendarId: "calendar", externalEventId: "event", externalEtag: "etag", externalUpdatedAt: null,
    };
    const eventsUrl = `/api/orgs/${boundaryOrgId}/calendar/events`;
    let boundaryEventId = "";
    for (const item of calendarBoundaryCases(eventBase, eventFields, {
      enumFields: ["eventKind", "eventStatus", "ownerType", "visibility", "sourceMode"],
    })) {
      const legacy = createCalendarEventSchema.safeParse(item.input);
      const response = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send(item.input);
      expect(response.status === 400, `${item.field}/${item.variant}: ${response.status} ${response.text}`).toBe(!legacy.success);
      expect(response.status, `${item.field}/${item.variant}: ${response.text}`).toBeLessThan(500);
      if (legacy.success && !boundaryEventId && response.status === 201) boundaryEventId = response.body.id;
      if (item.field === "description" && item.variant === "empty") {
        expect(legacy.success).toBe(true);
        expect(response.status, response.text).toBe(201);
        expect(response.body.description).toBe("");
      }
      if (item.field === "startAt" && item.variant === "null") {
        expect(legacy.success).toBe(true);
        expect(response.body.startAt).toBe(legacy.data.startAt.toISOString());
        expect(response.body.startAt).toBe("1970-01-01T00:00:00.000Z");
      }
    }

    const dateCases = [
      { label: "date-only UTC", value: "2024-10-08", expectedUtc: "2024-10-08T00:00:00.000Z" },
      { label: "minute ISO local", value: "2024-10-08T17:20" },
      { label: "minute ISO with space", value: "2024-10-08 17:20" },
      { label: "offset minute", value: "2024-10-08T17:20+05:30", expectedUtc: "2024-10-08T11:50:00.000Z" },
      { label: "offset compact", value: "2024-10-08T17:20+0530", expectedUtc: "2024-10-08T11:50:00.000Z" },
      { label: "fractional millisecond clipping", value: "2024-10-08T17:20:30.987654Z", expectedUtc: "2024-10-08T17:20:30.987Z" },
      { label: "boolean coercion", value: true, expectedUtc: "1970-01-01T00:00:00.001Z" },
      { label: "numeric epoch coercion", value: 0, expectedUtc: "1970-01-01T00:00:00.000Z" },
      { label: "DST gap", value: "2024-03-10T02:30" },
      { label: "DST fold", value: "2024-11-03T01:30" },
      { label: "invalid date", value: "not-a-date", invalid: true },
      { label: "invalid Unicode offset", value: "2024-10-08T17:20+1é1", invalid: true },
    ] as const;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const item of dateCases) {
      const input = { ...eventBase, title: `Date boundary ${item.label}`, startAt: item.value };
      const legacy = createCalendarEventSchema.safeParse(input);
      const response = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send(input);
      expect(response.status === 400, `${item.label}: ${response.status} ${response.text}`).toBe(!legacy.success);
      if (!legacy.success) continue;
      expect(response.status, `${item.label}: ${response.text}`).toBe(201);
      expect(response.body.startAt).toBe(legacy.data.startAt.toISOString());
      if ("expectedUtc" in item) expect(response.body.startAt).toBe(item.expectedUtc);
      if (zone === "America/Los_Angeles" && item.label === "DST gap") expect(response.body.startAt).toBe("2024-03-10T10:30:00.000Z");
      if (zone === "America/Los_Angeles" && item.label === "DST fold") expect(response.body.startAt).toBe("2024-11-03T08:30:00.000Z");
    }

    const sourcePatch = { lastSyncedAt: null };
    expect(updateCalendarSourceSchema.safeParse(sourcePatch).success).toBe(true);
    await db.execute(sql`UPDATE calendar_sources SET last_synced_at=now() WHERE id=${boundarySourceId}::uuid`);
    const clearedSource = await request(server!).patch(`${sourceUrl}/${boundarySourceId}`).set("authorization", `Bearer ${ownerToken}`).send(sourcePatch);
    expect(clearedSource.status, clearedSource.text).toBe(200);
    const sourceTimestamp = await db.execute(sql`SELECT last_synced_at FROM calendar_sources WHERE id=${boundarySourceId}::uuid`);
    expect(sourceTimestamp[0]?.last_synced_at).toBeNull();
    expect(updateCalendarSourceSchema.safeParse({}).success).toBe(true);
    expect((await request(server!).patch(`${sourceUrl}/${boundarySourceId}`).set("authorization", `Bearer ${ownerToken}`).send({})).status).toBe(200);
    for (const invalidPatch of [{ lastSyncedAt: "" }, { lastSyncedAt: {} }]) {
      expect(updateCalendarSourceSchema.safeParse(invalidPatch).success).toBe(false);
      const invalidResponse = await request(server!).patch(`${sourceUrl}/${boundarySourceId}`).set("authorization", `Bearer ${ownerToken}`).send(invalidPatch);
      expect(invalidResponse.status, invalidResponse.text).toBe(400);
    }

    expect(boundaryEventId).not.toBe("");
    expect(updateCalendarEventSchema.safeParse({}).success).toBe(true);
    expect((await request(server!).patch(`${eventsUrl}/${boundaryEventId}`).set("authorization", `Bearer ${ownerToken}`).send({})).status).toBe(200);
    expect(updateCalendarEventSchema.safeParse({ description: "" }).success).toBe(true);
    const emptyDescriptionPatch = await request(server!).patch(`${eventsUrl}/${boundaryEventId}`).set("authorization", `Bearer ${ownerToken}`).send({ description: "" });
    expect(emptyDescriptionPatch.status, emptyDescriptionPatch.text).toBe(200);
    expect(emptyDescriptionPatch.body.description).toBe("");
    const nullableStartPatch = { startAt: null };
    expect(updateCalendarEventSchema.safeParse(nullableStartPatch).success).toBe(true);
    const nullableStart = await request(server!).patch(`${eventsUrl}/${boundaryEventId}`).set("authorization", `Bearer ${ownerToken}`).send(nullableStartPatch);
    expect(nullableStart.status, nullableStart.text).toBe(200);
    expect(nullableStart.body.startAt).toBe("1970-01-01T00:00:00.000Z");
    for (const invalidPatch of [{ startAt: "" }, { startAt: {} }, { endAt: "" }, { endAt: {} }]) {
      expect(updateCalendarEventSchema.safeParse(invalidPatch).success).toBe(false);
      const invalidResponse = await request(server!).patch(`${eventsUrl}/${boundaryEventId}`).set("authorization", `Bearer ${ownerToken}`).send(invalidPatch);
      expect(invalidResponse.status, invalidResponse.text).toBe(400);
    }
    const endBeforeStartPatch = { endAt: null };
    expect(updateCalendarEventSchema.safeParse(endBeforeStartPatch).success).toBe(true);
    const endBeforeStart = await request(server!).patch(`${eventsUrl}/${boundaryEventId}`).set("authorization", `Bearer ${ownerToken}`).send(endBeforeStartPatch);
    expect(endBeforeStart.status).toBe(422);

    const crossOrgCases = [
      { field: "sourceId", value: foreignSourceId, status: 404 },
      { field: "ownerAgentId", value: agentId, status: 422 },
      { field: "goalId", value: foreignGoalId, status: 422 },
    ] as const;
    for (const item of crossOrgCases) {
      const input = { ...eventBase, [item.field]: item.value };
      const legacy = createCalendarEventSchema.safeParse(input);
      if (!legacy.success) throw new Error(`Zod unexpectedly rejected ${item.field}: ${legacy.error.message}`);
      let legacyStatus = 201;
      try { await calendarService(db).createEvent(boundaryOrgId, legacy.data, { userId: ownerId }); }
      catch (error) { legacyStatus = Number((error as { status?: unknown }).status ?? 500); }
      const response = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send(input);
      expect(legacyStatus, `legacy ${item.field}`).toBe(item.status);
      expect(response.status, `Rust ${item.field}: ${response.text}`).toBe(legacyStatus);
    }

    beforeMutations = await snapshot();
  }, 90_000);

  it("keeps private SideChat runs owner scoped while normal chat runs match across same-org boards", async () => {
    const start = new Date(Date.now() - 60_000).toISOString();
    const end = new Date(Date.now() + 60_000).toISOString();
    const url = `/api/orgs/${orgId}/calendar/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&agentIds=${agentId}&eventKinds=agent_work_block&statuses=in_progress`;
    const owner = await get(url, ownerToken);
    const peer = await get(url, otherToken);
    expect(owner.status, owner.text).toBe(200);
    expect(peer.status, peer.text).toBe(200);
    const ownerIds = owner.body.events.map((event: { id: string }) => event.id);
    const peerIds = peer.body.events.map((event: { id: string }) => event.id);
    expect(ownerIds).toContain(`run:${runIds[0]}`);
    expect(ownerIds).not.toContain(`run:${runIds[1]}`);
    expect(peerIds).not.toContain(`run:${runIds[0]}`);
    expect(peerIds).toContain(`run:${runIds[1]}`);
    expect(ownerIds).toContain(`run:${runIds[2]}`);
    expect(peerIds).toContain(`run:${runIds[2]}`);
    expect(ownerIds).toContain(`run:${malformedProjectionRunId}`);
    expect(peerIds).toContain(`run:${malformedProjectionRunId}`);
    expect(owner.text).not.toContain("PEER_PRIVATE_TRIGGER");
    expect(peer.text).not.toContain("OWNER_PRIVATE_TRIGGER");
    const malformedDetail = await get(`/api/orgs/${orgId}/calendar/events/run:${malformedProjectionRunId}`, ownerToken);
    expect(malformedDetail.status, malformedDetail.text).toBe(200);
    expect(malformedDetail.body.issue).toBeNull();
    expect(malformedDetail.body.activityId).toBeNull();
    expect((await get(`/api/orgs/${orgId}/calendar/events/run:${runIds[0]}`, ownerToken)).status).toBe(200);
    expect((await get(`/api/orgs/${orgId}/calendar/events/run:${runIds[0]}`, otherToken)).status).toBe(404);
    const ownerNormal = await get(`/api/orgs/${orgId}/calendar/events/run:${runIds[2]}`, ownerToken);
    const peerNormal = await get(`/api/orgs/${orgId}/calendar/events/run:${runIds[2]}`, otherToken);
    expect(ownerNormal.status).toBe(200);
    expect(peerNormal.status).toBe(200);
    expect(peerNormal.body).toEqual({ ...ownerNormal.body, endAt: expect.any(String) });
    expect((await get(`/api/orgs/${foreignOrgId}/calendar/sources`, ownerToken)).status).toBe(403);
    expect((await get(`/api/orgs/${orgId}/calendar/sources`, foreignToken)).status).toBe(403);
    expect(await snapshot()).toEqual(beforeMutations);
  }, 30_000);

  it("exercises source and event list/create/detail/update/delete over public Express HTTP", async () => {
    const sourcesUrl = `/api/orgs/${orgId}/calendar/sources`;
    const initialSources = await get(sourcesUrl);
    expect(initialSources.status, initialSources.text).toBe(200);
    expect(initialSources.body).toEqual([]);

    const staleRunId = randomUUID();
    const sourceCreated = await request(server!).post(sourcesUrl)
      .set("authorization", `Bearer ${ownerToken}`)
      .set("x-rudder-run-id", staleRunId)
      .send({ name: "Personal planning", syncCursorJson: { accessToken: "access-secret", refreshToken: "refresh-secret", syncToken: "cursor-safe" } });
    expect(sourceCreated.status, sourceCreated.text).toBe(201);
    const sourceId = sourceCreated.body.id as string;
    expect(sourceCreated.body).toMatchObject({ name: "Personal planning", type: "rudder_local", ownerUserId: ownerId });
    expect(sourceCreated.body.syncCursorJson).toMatchObject({ accessToken: "[redacted]", refreshToken: "[redacted]", syncToken: "cursor-safe" });
    expect(sourceCreated.text).not.toContain("access-secret");
    expect(sourceCreated.text).not.toContain("refresh-secret");
    expect(sourceCreated.body).toEqual(wire((await calendarService(db).listSources(orgId))[0]));
    const staleRunAudit = await db.execute(sql`SELECT id::text,run_id::text FROM activity_log WHERE org_id=${orgId}::uuid AND action='calendar.source_created' AND entity_id=${sourceId}`);
    expect(staleRunAudit).toHaveLength(1);
    expect(staleRunAudit[0]?.run_id).toBeNull();
    const staleRunOutbox = await db.execute(sql`SELECT payload->>'runId' AS run_id FROM organization_mutation_outbox WHERE activity_id=${staleRunAudit[0]!.id}::uuid`);
    expect(staleRunOutbox[0]?.run_id).toBeNull();

    const sourceList = await get(sourcesUrl);
    expect(sourceList.status).toBe(200);
    expect(sourceList.body).toHaveLength(1);
    expect(sourceList.body[0]).toEqual(sourceCreated.body);
    expect(sourceList.body).toEqual(wire(await calendarService(db).listSources(orgId)));
    const sourceUpdated = await request(server!).patch(`${sourcesUrl}/${sourceId}`).set("authorization", `Bearer ${ownerToken}`).send({
      name: "Planning calendar", syncCursorJson: null,
    });
    expect(sourceUpdated.status, sourceUpdated.text).toBe(200);
    expect(sourceUpdated.body.name).toBe("Planning calendar");
    expect(sourceUpdated.body.syncCursorJson).toBeNull();
    expect(sourceUpdated.body).toEqual(wire((await calendarService(db).listSources(orgId))[0]));
    const sourceDeleted = await request(server!).delete(`${sourcesUrl}/${sourceId}`).set("authorization", `Bearer ${ownerToken}`);
    expect(sourceDeleted.status, sourceDeleted.text).toBe(200);
    expect(sourceDeleted.body).toEqual({ ok: true });
    expect((await get(sourcesUrl)).body).toEqual([]);
    expect((await get(sourcesUrl)).body).toEqual(wire(await calendarService(db).listSources(orgId)));

    const eventsUrl = `/api/orgs/${orgId}/calendar/events`;
    const eventCreated = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send({
      eventKind: "human_event", eventStatus: "planned", ownerType: "user", title: "Planning session",
      description: "Private but ordinary calendar content", startAt, endAt, timezone: "UTC", allDay: false,
      visibility: "full", sourceMode: "manual",
    });
    expect(eventCreated.status, eventCreated.text).toBe(201);
    const eventId = eventCreated.body.id as string;
    expect(eventCreated.body).toMatchObject({
      orgId, sourceId: null, eventKind: "human_event", eventStatus: "planned", ownerType: "user",
      ownerUserId: null, title: "Planning session", sourceMode: "manual", createdByUserId: ownerId, updatedByUserId: ownerId,
    });
    expect(eventCreated.body).toEqual(wire(await calendarService(db).getEvent(orgId, eventId)));
    const detail = await get(`${eventsUrl}/${eventId}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body).toEqual(eventCreated.body);
    expect(detail.body).toEqual(wire(await calendarService(db).getEvent(orgId, eventId)));

    const eventFilters = { start: new Date("2030-07-01T00:00:00.000Z"), end: new Date("2030-07-02T00:00:00.000Z"), eventKinds: ["human_event"], statuses: ["planned"] };
    const list = await get(`${eventsUrl}?start=2030-07-01T00%3A00%3A00.000Z&end=2030-07-02T00%3A00%3A00.000Z&eventKinds=human_event&statuses=planned`);
    expect(list.status, list.text).toBe(200);
    expect(list.body.events).toEqual(wire(await calendarService(db).listEvents(orgId, eventFilters)));
    const eventUpdated = await request(server!).patch(`${eventsUrl}/${eventId}`).set("authorization", `Bearer ${ownerToken}`).send({ title: "Updated planning session", description: null });
    expect(eventUpdated.status, eventUpdated.text).toBe(200);
    expect(eventUpdated.body).toMatchObject({ id: eventId, title: "Updated planning session", description: null, createdByUserId: ownerId, updatedByUserId: ownerId });
    expect(eventUpdated.body).toEqual(wire(await calendarService(db).getEvent(orgId, eventId)));
    const updatedDetail = await get(`${eventsUrl}/${eventId}`);
    expect(updatedDetail.status).toBe(200);
    expect(updatedDetail.body).toEqual(eventUpdated.body);
    const updatedList = await get(`${eventsUrl}?start=2030-07-01T00%3A00%3A00.000Z&end=2030-07-02T00%3A00%3A00.000Z&eventKinds=human_event&statuses=planned`);
    expect(updatedList.body.events).toEqual(wire(await calendarService(db).listEvents(orgId, eventFilters)));

    const eventDeleted = await request(server!).delete(`${eventsUrl}/${eventId}`).set("authorization", `Bearer ${ownerToken}`);
    expect(eventDeleted.status, eventDeleted.text).toBe(200);
    expect(eventDeleted.body).toEqual({ ok: true });
    expect((await get(`${eventsUrl}/${eventId}`)).status).toBe(404);
    const deletedRow = await db.select().from(calendarEvents).where(sql`${calendarEvents.id} = ${eventId}::uuid`);
    expect(deletedRow).toHaveLength(1);
    expect(deletedRow[0]!.deletedAt).toBeInstanceOf(Date);
    expect(deletedRow[0]!.eventStatus).toBe("cancelled");

    const imported = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send({
      eventKind: "external_event", eventStatus: "external", ownerType: "system", title: "Imported provider event",
      startAt, endAt, timezone: "UTC", allDay: false, visibility: "busy_only", sourceMode: "imported",
      externalProvider: "fixture", externalCalendarId: "calendar", externalEventId: "remote-event",
    });
    expect(imported.status, imported.text).toBe(201);
    const importedId = imported.body.id as string;
    const importedUpdate = await request(server!).patch(`${eventsUrl}/${importedId}`).set("authorization", `Bearer ${ownerToken}`).send({ title: "Read only" });
    expect(importedUpdate.status).toBe(409);
    expect(importedUpdate.body.error).toBe("Imported and derived calendar events are read-only");
    const importedDelete = await request(server!).delete(`${eventsUrl}/${importedId}`).set("authorization", `Bearer ${ownerToken}`);
    expect(importedDelete.status).toBe(409);
    expect((await get(`${eventsUrl}/${importedId}`)).body).toMatchObject({ id: importedId, sourceMode: "imported", title: "Imported provider event" });
    const derivedCreate = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send({
      eventKind: "human_event", eventStatus: "planned", ownerType: "user", title: "Cannot create derived event",
      startAt, endAt, timezone: "UTC", allDay: false, sourceMode: "derived",
    });
    expect(derivedCreate.status).toBe(403);
    expect(derivedCreate.body.error).toBe("Derived calendar events are read-only");

    const shortJwtTitle = "h.p.s";
    const shortJwtEvent = await request(server!).post(eventsUrl).set("authorization", `Bearer ${ownerToken}`).send({
      eventKind: "human_event", eventStatus: "planned", ownerType: "user", title: shortJwtTitle,
      startAt, endAt, timezone: "UTC", allDay: false, sourceMode: "manual",
    });
    expect(shortJwtEvent.status, shortJwtEvent.text).toBe(201);
    const shortJwtId = shortJwtEvent.body.id as string;
    expect(shortJwtEvent.body.title).toBe(shortJwtTitle);
    const shortJwtAudit = await db.execute(sql`SELECT id::text,details->>'title' AS title FROM activity_log WHERE org_id=${orgId}::uuid AND action='calendar.event_created' AND entity_id=${shortJwtId}`);
    expect(shortJwtAudit[0]?.title).toBe("***REDACTED***");
    const shortJwtOutbox = await db.execute(sql`SELECT payload->'details'->>'title' AS title FROM organization_mutation_outbox WHERE activity_id=${shortJwtAudit[0]!.id}::uuid`);
    expect(shortJwtOutbox[0]?.title).toBe("***REDACTED***");

    const sourceRows = await db.select().from(calendarSources).where(sql`${calendarSources.orgId} = ${orgId}::uuid`);
    expect(sourceRows).toHaveLength(0);
    const activities = await db.execute(sql`SELECT action,actor_id FROM activity_log WHERE org_id=${orgId}::uuid AND action LIKE 'calendar.%' ORDER BY action`);
    expect(activities.map((row) => [row.action, row.actor_id])).toEqual([
      ["calendar.event_created", ownerId], ["calendar.event_created", ownerId], ["calendar.event_created", ownerId], ["calendar.event_deleted", ownerId], ["calendar.event_updated", ownerId],
      ["calendar.source_created", ownerId], ["calendar.source_deleted", ownerId], ["calendar.source_updated", ownerId],
    ]);
    const outbox = await db.execute(sql`SELECT event_type,payload->>'action' AS action FROM organization_mutation_outbox WHERE org_id=${orgId}::uuid ORDER BY activity_id`);
    expect(outbox).toHaveLength(8);
    expect(outbox.every((row) => row.event_type === "activity.logged")).toBe(true);
    expect(outbox.map((row) => row.action).sort()).toEqual([
      "calendar.event_created", "calendar.event_created", "calendar.event_created", "calendar.event_deleted", "calendar.event_updated",
      "calendar.source_created", "calendar.source_deleted", "calendar.source_updated",
    ]);
    afterMutations = await snapshot();
  }, 30_000);

  it("fails closed when the actual native binary is unavailable", async () => {
    await bridge!.close();
    const unavailable = `${fixtureBinary}.unavailable`;
    fs.renameSync(fixtureBinary, unavailable);
    try {
      expect((await request(server!).get("/api/health")).status).toBe(200);
      for (const url of [`/api/orgs/${orgId}/calendar/sources`, `/api/orgs/${orgId}/calendar/events?start=${encodeURIComponent(startAt)}&end=${encodeURIComponent(endAt)}`]) {
        const response = await get(url);
        expect(response.status, response.text).toBe(503);
        expect(response.body).toMatchObject({ error: "Rust Calendar is unavailable", code: "rust_foundation_calendar_unavailable" });
      }
      expect(await snapshot()).toEqual(afterMutations);
    } finally { fs.renameSync(unavailable, fixtureBinary); }
  }, 30_000);
});
