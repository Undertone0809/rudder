import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  applyPendingMigrations,
  chatContextLinks,
  chatConversations,
  createDb,
  ensurePostgresDatabase,
  issues,
  organizations,
} from "@rudder/db";
import { deriveOrganizationUrlKey } from "@rudder/shared";
import { activityService } from "../services/activity.ts";

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

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate test port")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-activity-service-"));
  const port = await getAvailablePort();
  const EmbeddedPostgres = await getEmbeddedPostgresCtor();
  const instance = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "rudder",
    password: "rudder",
    port,
    persistent: true,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  await instance.initialise();
  await instance.start();

  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { connectionString, dataDir, instance };
}

describe("activityService.forIssue", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof activityService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    svc = activityService(db);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatContextLinks);
    await db.delete(chatConversations);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("includes issue-relevant chat events without pulling unrelated chat noise", async () => {
    const orgId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const linkedConversationId = randomUUID();
    const contextLinkedConversationId = randomUUID();
    const convertedConversationId = randomUUID();
    const unrelatedConversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RST",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values([
      {
        id: issueId,
        orgId,
        title: "Issue under test",
        status: "todo",
        priority: "medium",
      },
      {
        id: otherIssueId,
        orgId,
        title: "Other issue",
        status: "todo",
        priority: "medium",
      },
    ]);

    await db.insert(chatConversations).values([
      {
        id: linkedConversationId,
        orgId,
        title: "Discuss the issue",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: contextLinkedConversationId,
        orgId,
        title: "Support thread",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: convertedConversationId,
        orgId,
        title: "Escalation chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: unrelatedConversationId,
        orgId,
        title: "Unrelated chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);

    await db.insert(chatContextLinks).values([
      { orgId, conversationId: linkedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: contextLinkedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: convertedConversationId, entityType: "issue", entityId: issueId },
      { orgId, conversationId: unrelatedConversationId, entityType: "issue", entityId: otherIssueId },
    ]);

    await db.insert(activityLog).values([
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "issue.created",
        entityType: "issue",
        entityId: issueId,
        details: { title: "Issue under test" },
        createdAt: new Date("2026-04-01T10:00:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.created",
        entityType: "chat",
        entityId: linkedConversationId,
        details: { title: "Discuss the issue", contextLinkCount: 1 },
        createdAt: new Date("2026-04-01T10:05:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.context_linked",
        entityType: "chat",
        entityId: contextLinkedConversationId,
        details: { entityType: "issue", entityId: issueId },
        createdAt: new Date("2026-04-01T10:10:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "chat-assistant",
        action: "chat.created",
        entityType: "chat",
        entityId: convertedConversationId,
        details: { title: "Escalation chat", contextLinkCount: 0 },
        createdAt: new Date("2026-04-01T10:12:00.000Z"),
      },
      {
        orgId,
        actorType: "system",
        actorId: "chat-assistant",
        action: "chat.issue_converted",
        entityType: "chat",
        entityId: convertedConversationId,
        details: { issueId, issueIdentifier: "RST-42" },
        createdAt: new Date("2026-04-01T10:15:00.000Z"),
      },
      {
        orgId,
        actorType: "user",
        actorId: "board",
        action: "chat.created",
        entityType: "chat",
        entityId: unrelatedConversationId,
        details: { title: "Unrelated chat", contextLinkCount: 1 },
        createdAt: new Date("2026-04-01T10:20:00.000Z"),
      },
    ]);

    const result = await svc.forIssue(issueId);

    expect(result.map((event) => `${event.action}:${event.entityId}`)).toEqual([
      `chat.issue_converted:${convertedConversationId}`,
      `chat.context_linked:${contextLinkedConversationId}`,
      `chat.created:${linkedConversationId}`,
      `issue.created:${issueId}`,
    ]);

    expect(result.find((event) => event.action === "chat.issue_converted")?.details).toMatchObject({
      issueId,
      issueIdentifier: "RST-42",
      conversationTitle: "Escalation chat",
    });
    expect(result.find((event) => event.action === "chat.created")?.details).toMatchObject({
      conversationTitle: "Discuss the issue",
    });
    expect(result.some((event) => event.entityId === unrelatedConversationId)).toBe(false);
  });
});
