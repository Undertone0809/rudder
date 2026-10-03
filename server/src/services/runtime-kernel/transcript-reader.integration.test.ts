import {
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunEvents,
  heartbeatRuns,
  organizations,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTranscriptReader } from "./transcript-reader.js";

type EmbeddedPostgresInstance = {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
};

type EmbeddedPostgresCtor = new (options: {
  databaseDir: string;
  user: string;
  password: string;
  port: number;
  persistent: boolean;
  initdbFlags?: string[];
  onLog?: (message: unknown) => void;
  onError?: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate transcript-reader PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startDisposablePostgres(databaseDir: string) {
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  const port = await availablePort();
  const instance = new EmbeddedPostgres({
    databaseDir,
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
  const adminUrl = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminUrl, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { instance, connectionString };
}

describe("transcript reader PostgreSQL integration", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let testRoot = "";

  beforeAll(async () => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-transcript-reader-"));
    const databaseDir = path.join(testRoot, "postgres");
    fs.mkdirSync(databaseDir, { recursive: true });
    const started = await startDisposablePostgres(databaseDir);
    instance = started.instance;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    if (db) await db.$client.end();
    await instance?.stop();
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it("pages 10,000 durable events in stable order without crossing Run scope", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();
    const orgName = `Transcript reader integration ${orgId}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `TR${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Transcript reader integration agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      { id: runId, orgId, agentId, invocationSource: "chat", status: "succeeded" },
      { id: otherRunId, orgId, agentId, invocationSource: "chat", status: "succeeded" },
    ]);

    const total = 10_000;
    const batchSize = 500;
    for (let start = 0; start < total; start += batchSize) {
      const events = Array.from({ length: batchSize }, (_, offset) => {
        const index = start + offset;
        return {
          orgId,
          runId,
          agentId,
          seq: Math.floor(index / 2) + 1,
          eventType: "transcript.entry",
          payload: {
            entry: {
              kind: "assistant",
              ts: "2026-09-28T00:00:00.000Z",
              text: `entry-${String(index).padStart(5, "0")} 世界`,
            },
          },
        };
      });
      await db.insert(heartbeatRunEvents).values(events);
    }
    await db.insert(heartbeatRunEvents).values({
      orgId,
      runId: otherRunId,
      agentId,
      seq: 1,
      eventType: "transcript.entry",
      payload: { entry: { kind: "assistant", ts: "2026-09-28T00:00:00.000Z", text: "out-of-run" } },
    });

    const input = {
      orgId,
      runId,
      principal: { type: "board", orgId, authorized: true },
      limit: 100,
    };
    const first = await createTranscriptReader(db).readRun(input);
    const restartedReader = createTranscriptReader(db);
    const texts = first.items.map((item) => item.text ?? "");
    const revision = first.revision;
    let cursor = first.nextCursor;
    let pages = 1;
    let completeness = first.completeness;

    while (cursor) {
      const page = await restartedReader.readRun({ ...input, cursor });
      expect(page.revision).toBe(revision);
      expect(page.items.length).toBeLessThanOrEqual(input.limit);
      texts.push(...page.items.map((item) => item.text ?? ""));
      cursor = page.nextCursor;
      pages += 1;
      completeness = page.completeness;
      expect(pages).toBeLessThanOrEqual(101);
    }

    expect(pages).toBe(100);
    expect(texts).toEqual(Array.from({ length: total }, (_, index) =>
      `entry-${String(index).padStart(5, "0")} 世界`));
    expect(completeness).toBe("complete");
  });
});
