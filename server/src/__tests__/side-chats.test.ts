import {
  applyPendingMigrations,
  chatAttachments,
  chatContextLinks,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  messengerCustomGroupEntries,
  messengerCustomGroups,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SIDE_CHAT_TTL_MS, sideChatService } from "../services/side-chats.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (opts: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function getAvailablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startTempDatabase() {
  const external = process.env.RUDDER_SIDE_CHAT_TEST_DATABASE_URL?.trim();
  if (external) {
    await applyPendingMigrations(external);
    return { connectionString: external, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-side-chat-"));
  const port = await getAvailablePort();
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });
  await instance.initialise();
  await instance.start();
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("sideChatService", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof sideChatService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    service = sideChatService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 60_000);

  afterEach(async () => {
    await db.delete(messengerCustomGroupEntries);
    await db.delete(messengerCustomGroups);
    await db.delete(chatAttachments);
    await db.delete(chatContextLinks);
    await db.delete(chatMessages);
    await db.delete(chatConversations);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function createSource(userId = "side-chat-owner") {
    const orgId = randomUUID();
    const sourceConversationId = randomUUID();
    const anchorMessageId = randomUUID();
    const startedAt = new Date("2026-07-19T02:00:00.000Z");
    await db.insert(organizations).values({
      id: orgId,
      name: `Side Chat ${orgId}`,
      urlKey: deriveOrganizationUrlKey(`Side Chat ${orgId}`),
      issuePrefix: `S${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: sourceConversationId,
      orgId,
      title: "Source answer",
      createdByUserId: userId,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    await db.insert(chatMessages).values([
      {
        id: randomUUID(),
        orgId,
        conversationId: sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Original question",
        createdAt: startedAt,
        updatedAt: startedAt,
      },
      {
        id: anchorMessageId,
        orgId,
        conversationId: sourceConversationId,
        role: "assistant",
        kind: "message",
        status: "completed",
        body: "Anchored answer",
        structuredPayload: { privateRuntimeData: true },
        createdAt: new Date(startedAt.getTime() + 1_000),
        updatedAt: new Date(startedAt.getTime() + 1_000),
      },
      {
        id: randomUUID(),
        orgId,
        conversationId: sourceConversationId,
        role: "user",
        kind: "message",
        status: "completed",
        body: "Must not be copied",
        createdAt: new Date(startedAt.getTime() + 2_000),
        updatedAt: new Date(startedAt.getTime() + 2_000),
      },
    ]);
    return { orgId, sourceConversationId, anchorMessageId, userId };
  }

  async function createSideChat(source: Awaited<ReturnType<typeof createSource>>) {
    return service.create({
      orgId: source.orgId,
      userId: source.userId,
      sourceConversationId: source.sourceConversationId,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-test-mutation",
    });
  }

  it("creates one hidden Side Chat per client mutation and copies context only through the anchor", async () => {
    const source = await createSource();
    const before = Date.now();
    const first = await createSideChat(source);
    const second = await createSideChat(source);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      conversationKind: "side_chat",
      messengerVisible: false,
      sideChatState: "active",
      forkedFromConversationId: source.sourceConversationId,
      forkedFromMessageId: source.anchorMessageId,
      createdByUserId: source.userId,
    });
    expect(first.sideChatExpiresAt?.getTime()).toBeGreaterThanOrEqual(before + SIDE_CHAT_TTL_MS - 1_000);

    const copied = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, first.id))
      .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
    expect(copied.map((message) => message.body)).toEqual(expect.arrayContaining([
      "Original question",
      "Anchored answer",
    ]));
    expect(copied.map((message) => message.body)).not.toContain("Must not be copied");
    const copiedAnchor = copied.find((message) => message.body === "Anchored answer");
    expect(copiedAnchor).toMatchObject({ runId: null, approvalId: null, structuredPayload: null });
  });

  it("turns completed and expired Side Chats read-only", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const completed = await service.complete({ conversationId: sideChat.id, userId: source.userId });

    expect(completed.sideChatState).toBe("completed");
    expect(completed.sideChatExpiresAt).toBeNull();
    await expect(service.assertMutable(completed, source.userId)).rejects.toMatchObject({ status: 409 });

    const other = await service.create({
      ...source,
      sourceMessageId: source.anchorMessageId,
      clientMutationId: "side-chat-expiry-test",
    });
    const expiredAt = new Date("2026-07-19T04:00:00.000Z");
    await db.update(chatConversations).set({ sideChatExpiresAt: expiredAt }).where(eq(chatConversations.id, other.id));
    const stale = { ...other, sideChatExpiresAt: expiredAt };
    await expect(service.assertMutable(stale, source.userId, new Date(expiredAt.getTime() + 1))).rejects.toMatchObject({ status: 409 });
    const [expired] = await db.select().from(chatConversations).where(eq(chatConversations.id, other.id));
    expect(expired?.sideChatState).toBe("expired");
  });

  it("hides a Side Chat from every user except its owner", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    await expect(service.assertAccessible(sideChat, "different-user")).rejects.toMatchObject({ status: 404 });
    await expect(service.complete({ conversationId: sideChat.id, userId: "different-user" })).rejects.toMatchObject({ status: 404 });
  });

  it("keeps the same conversation id and joins the source Messenger group when present", async () => {
    const source = await createSource();
    const sideChat = await createSideChat(source);
    const [group] = await db.insert(messengerCustomGroups).values({
      orgId: source.orgId,
      userId: source.userId,
      name: "Source work",
      sortOrder: 0,
    }).returning();
    await db.insert(messengerCustomGroupEntries).values({
      orgId: source.orgId,
      userId: source.userId,
      groupId: group!.id,
      threadKey: `chat:${source.sourceConversationId}`,
      sortOrder: 0,
    });

    const kept = await service.keepInMessenger({ conversationId: sideChat.id, userId: source.userId });
    expect(kept).toMatchObject({ id: sideChat.id, messengerVisible: true, sideChatState: "kept" });
    const entries = await db
      .select()
      .from(messengerCustomGroupEntries)
      .where(eq(messengerCustomGroupEntries.groupId, group!.id))
      .orderBy(asc(messengerCustomGroupEntries.sortOrder));
    expect(entries.map((entry) => entry.threadKey)).toEqual([
      `chat:${source.sourceConversationId}`,
      `chat:${sideChat.id}`,
    ]);
  });
});
