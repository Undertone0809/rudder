import {
  activityLog,
  applyPendingMigrations,
  chatControlActions,
  chatConversations,
  chatGenerations,
  chatMessages,
  chatQueuedMessages,
  createDb,
  ensurePostgresDatabase,
  organizations,
  type Db,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import type { ChatBackgroundRuntime } from "../routes/chat-background-runtime.js";
import { chatRoutes } from "../routes/chats.js";
import { chatService } from "../services/chats.js";

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

function createPausedBackgroundRuntime() {
  let acceptingWork = true;
  let wakes = 0;
  const runtime: ChatBackgroundRuntime = {
    get acceptingWork() { return acceptingWork; },
    setTimeout: () => null,
    setInterval: () => null,
    clearTimer: () => undefined,
    createCoalescingTask: () => ({ wake: () => { wakes += 1; } }),
    track: (work) => work,
    manageAbortController: (controller = new AbortController()) => ({ controller, release: () => undefined }),
    close: async () => { acceptingWork = false; },
  };
  return { runtime, getWakes: () => wakes };
}

function withFailingFirstActivityInsert(db: Db) {
  let failed = false;
  let activityInsertAttempts = 0;
  const wrapped = new Proxy(db, {
    get(target, property) {
      if (property === "insert") {
        return (table: unknown) => {
          if (table === activityLog) {
            activityInsertAttempts += 1;
            if (!failed) {
              failed = true;
              throw new Error("injected activity-log persistence failure");
            }
          }
          return target.insert(table as never);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: wrapped as Db, getActivityInsertAttempts: () => activityInsertAttempts };
}

describe("failed queue Continue route recovery", () => {
  let db!: Db;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  const workerTestFlag = process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-queue-recovery-"));
    const port = await getAvailablePort();
    const EmbeddedPostgres = await getEmbeddedPostgresCtor();
    instance = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: "rudder",
      password: "rudder",
      port,
      persistent: true,
      initdbFlags: ["--encoding=UTF8", "--locale=C"],
      onLog: () => undefined,
      onError: (message) => console.error(message),
    });
    await instance.initialise();
    await instance.start();
    const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
    await ensurePostgresDatabase(adminUrl, "rudder");
    const databaseUrl = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
    await applyPendingMigrations(databaseUrl);
    db = createDb(databaseUrl);
  }, 30_000);

  afterAll(async () => {
    if (workerTestFlag === undefined) delete process.env.RUDDER_CHAT_QUEUE_WORKER_TEST;
    else process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = workerTestFlag;
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("retries the same authorization after activity failure and materializes one continuation", async () => {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const failedGenerationId = randomUUID();
    const controlActionId = randomUUID();
    const userId = "queue-recovery-owner";
    const actor = {
      type: "board",
      userId,
      orgIds: [orgId],
      source: "session",
      isInstanceAdmin: false,
      runId: null,
    };
    await db.insert(organizations).values({
      id: orgId,
      name: "Queue recovery route test",
      urlKey: deriveOrganizationUrlKey(`Queue recovery ${orgId}`),
      issuePrefix: `Q${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Queue recovery route test",
      issueCreationMode: "manual_approval",
      planMode: false,
      createdByUserId: userId,
    });
    await db.insert(chatGenerations).values({
      id: failedGenerationId,
      orgId,
      conversationId,
      status: "failed",
      terminalReason: "original_reader_failure",
      completedAt: new Date(),
    });
    const chatSvc = chatService(db);
    const queued = await chatSvc.createQueuedMessage({
      orgId,
      conversationId,
      clientMutationId: randomUUID(),
      payload: { body: "Continue this queued input once" },
      requestActor: { type: "board", source: "session", userId, orgIds: [orgId], isInstanceAdmin: false },
    });

    const failureDb = withFailingFirstActivityInsert(db);
    process.env.RUDDER_CHAT_QUEUE_WORKER_TEST = "true";
    const background = createPausedBackgroundRuntime();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as typeof req & { actor: typeof actor }).actor = actor;
      next();
    });
    app.use("/api", chatRoutes(failureDb.db, {} as never, background.runtime));
    app.use(errorHandler);
    const endpoint = `/api/chats/${conversationId}/queue/${queued.id}/continue`;
    const command = { version: queued.version, expectedFailedGenerationId: failedGenerationId, controlActionId };

    const failedResponse = await request(app).post(endpoint).send(command);
    expect(failedResponse.status).toBe(500);
    expect(background.getWakes()).toBe(0);
    const [authorizedQueueItem] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, queued.id));
    const [authorizedAction] = await db.select().from(chatControlActions).where(eq(chatControlActions.id, controlActionId));
    expect(authorizedQueueItem).toMatchObject({ controlActionId, version: queued.version + 1, status: "queued" });
    expect(authorizedAction).toMatchObject({
      id: controlActionId,
      actionKind: "continue",
      localDisposition: "continuation_pending",
      providerDisposition: "not_sent",
    });
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "chat.queue.continue_requested"))).toHaveLength(0);

    const retriedResponse = await request(app).post(endpoint).send(command);
    expect(retriedResponse.status).toBe(200);
    expect(retriedResponse.body).toMatchObject({ controlActionId, idempotent: true, item: { id: queued.id, version: queued.version + 1 } });
    expect(failureDb.getActivityInsertAttempts()).toBe(2);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "chat.queue.continue_requested"));
    expect(activity).toMatchObject({
      action: "chat.queue.continue_requested",
      entityId: conversationId,
      idempotencyKey: `chat.queue.continue:${controlActionId}`,
    });
    expect(background.getWakes()).toBe(1);

    const claims = await Promise.all(["recovery-worker-a", "recovery-worker-b", "recovery-worker-c"].map((workerId) =>
      chatSvc.claimNextServerQueuedMessage({ workerId, leaseMs: 30_000 }),
    ));
    const successfulClaims = claims.filter((claim) => claim !== null);
    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]?.item).toMatchObject({
      id: queued.id,
      controlActionId,
      status: "dequeue_claimed",
      deliveryAttempts: 1,
    });
    const [materializedQueueItem] = await db.select().from(chatQueuedMessages).where(eq(chatQueuedMessages.id, queued.id));
    expect(materializedQueueItem?.continuationMessageId).toBeTruthy();
    const materializedMessages = await db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId));
    expect(materializedMessages).toHaveLength(1);
    expect(materializedMessages[0]).toMatchObject({ role: "user", body: "Continue this queued input once" });

    await background.runtime.close();
  });
});
