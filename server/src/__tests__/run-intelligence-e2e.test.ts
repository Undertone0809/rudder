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
import { eq } from "drizzle-orm";
import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";
import { getRunLogStore } from "../services/run-log-store.js";

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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_RUN_INTELLIGENCE_E2E_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-intelligence-e2e-db-"));
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

function createApp(db: ReturnType<typeof createDb>, allowedOrgId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "run-intelligence-e2e-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: [allowedOrgId],
    };
    next();
  });
  app.use("/api", runIntelligenceRoutes(db));
  app.use(errorHandler);
  return app;
}

function transcriptEvent(input: {
  orgId: string;
  runId: string;
  agentId: string;
  seq: number;
  payload: Record<string, unknown>;
}) {
  return {
    orgId: input.orgId,
    runId: input.runId,
    agentId: input.agentId,
    seq: input.seq,
    eventType: "transcript.entry",
    stream: "system",
    level: input.payload.isError ? "error" : "info",
    payload: input.payload,
    createdAt: new Date(`2026-07-14T10:00:0${input.seq}.000Z`),
  };
}

describe("run intelligence real route workflow", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let logDir = "";
  const previousLogBasePath = process.env.RUN_LOG_BASE_PATH;

  beforeAll(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-intelligence-e2e-logs-"));
    process.env.RUN_LOG_BASE_PATH = logDir;
    const started = await startTempDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
    if (previousLogBasePath === undefined) delete process.env.RUN_LOG_BASE_PATH;
    else process.env.RUN_LOG_BASE_PATH = previousLogBasePath;
  });

  it("walks summary, errors, bounded evidence, and detail without crossing org boundaries", async () => {
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const runId = randomUUID();
    const otherRunId = randomUUID();

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Run Intelligence E2E",
        urlKey: deriveOrganizationUrlKey(`Run Intelligence E2E ${orgId}`),
        issuePrefix: "RIE",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Run Intelligence Other Org",
        urlKey: deriveOrganizationUrlKey(`Run Intelligence Other Org ${otherOrgId}`),
        issuePrefix: "RIO",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        orgId,
        name: "Performance Agent",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
      {
        id: otherAgentId,
        orgId: otherOrgId,
        name: "Private Agent",
        role: "engineer",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
      },
    ]);

    const startedAt = new Date("2026-07-14T10:00:00.000Z");
    const finishedAt = new Date("2026-07-14T10:00:07.000Z");
    await db.insert(heartbeatRuns).values([
      {
        id: runId,
        orgId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "failed",
        startedAt,
        finishedAt,
        error: "command failed",
        errorCode: "command_error",
        usageJson: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 30, costUsd: 0.02 },
        resultJson: { summary: "Fix failed", raw: "raw-result-marker".repeat(20_000) },
        resultSummaryJson: { summary: "Fix failed", costUsd: 0.02 },
        contextSnapshot: { targetType: "issue", targetId: "RIE-1" },
        createdAt: startedAt,
        updatedAt: finishedAt,
      },
      {
        id: otherRunId,
        orgId: otherOrgId,
        agentId: otherAgentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "succeeded",
        startedAt,
        finishedAt,
        resultSummaryJson: { summary: "Private result" },
        createdAt: startedAt,
        updatedAt: finishedAt,
      },
    ]);

    const entries = [
      { kind: "assistant", ts: "2026-07-14T10:00:01.000Z", text: "I will run the check." },
      {
        kind: "tool_call",
        ts: "2026-07-14T10:00:02.000Z",
        name: "exec_command",
        toolUseId: "tool-1",
        input: { cmd: "pnpm test" },
      },
      {
        kind: "tool_result",
        ts: "2026-07-14T10:00:03.000Z",
        toolUseId: "tool-1",
        toolName: "exec_command",
        content: `failure-marker:${"E".repeat(4_000)}`,
        isError: true,
      },
      {
        kind: "result",
        ts: "2026-07-14T10:00:04.000Z",
        text: "First turn failed",
        inputTokens: 100,
        outputTokens: 10,
        cachedTokens: 0,
        costUsd: 0.01,
        subtype: "error",
        isError: true,
        errors: ["command failed"],
      },
      { kind: "assistant", ts: "2026-07-14T10:00:05.000Z", text: "second-turn-marker" },
      {
        kind: "result",
        ts: "2026-07-14T10:00:06.000Z",
        text: "Second turn ended",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 50,
        costUsd: 0.01,
        subtype: "success",
        isError: false,
        errors: [],
      },
    ];
    await db.insert(heartbeatRunEvents).values(entries.map((payload, index) => transcriptEvent({
      orgId,
      runId,
      agentId,
      seq: index + 1,
      payload,
    })));

    const logStore = getRunLogStore();
    const logHandle = await logStore.begin({ orgId, agentId, runId });
    for (let index = 0; index < 6; index += 1) {
      // Empty chunks keep the raw log pageable while transcript reconstruction uses durable events.
      await logStore.append(logHandle, {
        stream: "system",
        chunk: "",
        ts: `2026-07-14T10:00:0${index + 1}.000Z`,
      });
    }
    const finalizedLog = await logStore.finalize(logHandle);
    await db.update(heartbeatRuns).set({
      logStore: logHandle.store,
      logRef: logHandle.logRef,
      logBytes: finalizedLog.bytes,
      logSha256: finalizedLog.sha256,
    }).where(eq(heartbeatRuns.id, runId));

    const app = createApp(db, orgId);

    const summary = await request(app)
      .get(`/api/run-intelligence/orgs/${orgId}/runs`)
      .query({ projection: "summary", limit: "1" });
    expect(summary.status).toBe(200);
    expect(summary.body.items).toHaveLength(1);
    expect(summary.body.items[0]).toMatchObject({
      id: runId,
      orgId,
      status: "failed",
      outcome: "Fix failed",
      error: "command_error",
      hasLog: true,
      logBytes: finalizedLog.bytes,
    });
    expect(JSON.stringify(summary.body)).not.toContain("raw-result-marker");

    const firstEvents = await request(app)
      .get(`/api/run-intelligence/runs/${runId}/events`)
      .query({ limit: "2" });
    expect(firstEvents.status).toBe(200);
    expect(firstEvents.body.items.map((event: { seq: number }) => event.seq)).toEqual([1, 2]);
    expect(firstEvents.body.page).toEqual({
      afterSeq: 0,
      limit: 2,
      hasMore: true,
      nextAfterSeq: 2,
    });

    const nextEvents = await request(app)
      .get(`/api/run-intelligence/runs/${runId}/events`)
      .query({ afterSeq: String(firstEvents.body.page.nextAfterSeq), limit: "2" });
    expect(nextEvents.status).toBe(200);
    expect(nextEvents.body).toHaveProperty("items");
    expect(nextEvents.body.items.map((event: { seq: number }) => event.seq)).toEqual([3, 4]);
    expect(nextEvents.body.page).toMatchObject({ afterSeq: 2, nextAfterSeq: 4, hasMore: true });

    const errors = await request(app)
      .get(`/api/run-intelligence/runs/${runId}/errors`)
      .query({ maxChars: "80" });
    expect(errors.status).toBe(200);
    const transcriptError = errors.body.errors.find((error: { type: string }) => error.type === "tool_result");
    expect(transcriptError).toMatchObject({
      id: "step-3",
      output: { clipped: true, originalLength: 4015 },
    });

    const transcript = await request(app)
      .get(`/api/run-intelligence/runs/${runId}/transcript`)
      .query({
        aroundError: transcriptError.id,
        contextTurns: "1",
        output: "full",
        order: "oldest",
        turnLimit: "1",
      });
    expect(transcript.status).toBe(200);
    expect(transcript.body.page).toMatchObject({
      order: "oldest",
      turnLimit: 1,
      hasMore: true,
      nextCursor: "step-4",
      returnedSteps: 4,
    });
    expect(transcript.body.entries.map((entry: { id: string }) => entry.id)).toEqual([
      "step-1",
      "step-2",
      "step-3",
      "step-4",
    ]);
    expect(transcript.body.transcript).toBeUndefined();
    expect(JSON.stringify(transcript.body)).not.toContain("second-turn-marker");

    let offset = 0;
    let reconstructedLog = "";
    let finalLogPage: Record<string, unknown> | null = null;
    for (let pageCount = 0; pageCount < 20; pageCount += 1) {
      const logPage = await request(app)
        .get(`/api/run-intelligence/runs/${runId}/log`)
        .query({ offset: String(offset), limitBytes: "73" });
      expect(logPage.status).toBe(200);
      expect(logPage.body.page.offset).toBe(offset);
      expect(logPage.body.page.endOffset).toBeGreaterThan(offset);
      expect(logPage.body.page.endOffset - offset).toBe(Buffer.byteLength(logPage.body.content, "utf8"));
      reconstructedLog += logPage.body.content;
      finalLogPage = logPage.body.page;
      if (logPage.body.page.eof) break;
      expect(logPage.body.page.nextOffset).toBe(logPage.body.page.endOffset);
      offset = logPage.body.page.nextOffset;
    }
    expect(finalLogPage).toMatchObject({ eof: true, nextOffset: null, endOffset: finalizedLog.bytes });
    expect(Buffer.byteLength(reconstructedLog, "utf8")).toBe(finalizedLog.bytes);

    const detail = await request(app).get(`/api/run-intelligence/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.run).toMatchObject({ id: runId, orgId, status: "failed" });
    expect(detail.body.run.resultJson.raw).toContain("raw-result-marker");

    const otherOrgList = await request(app)
      .get(`/api/run-intelligence/orgs/${otherOrgId}/runs`)
      .query({ projection: "summary" });
    expect(otherOrgList.status).toBe(403);
    expect(otherOrgList.body.error).toContain("does not have access");

    const otherOrgDetail = await request(app).get(`/api/run-intelligence/runs/${otherRunId}`);
    expect(otherOrgDetail.status).toBe(403);
    expect(otherOrgDetail.body.error).toContain("does not have access");

    const otherOrgLog = await request(app).get(`/api/run-intelligence/runs/${otherRunId}/log`);
    expect(otherOrgLog.status).toBe(403);
    expect(otherOrgLog.body.error).toContain("does not have access");
  });
});
