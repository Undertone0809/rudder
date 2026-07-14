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
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRunSummaries } from "../services/run-intelligence.ts";

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

async function availablePort() {
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

async function startDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-run-summary-"));
  const port = await availablePort();
  const module = await import("embedded-postgres");
  const EmbeddedPostgres = module.default as EmbeddedPostgresCtor;
  const instance = new EmbeddedPostgres({
    databaseDir: path.join(dataDir, "pgdata"),
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
  return { connectionString, dataDir, instance };
}

describe("listRunSummaries", () => {
  let db!: ReturnType<typeof createDb>;
  let instance!: EmbeddedPostgresInstance;
  let dataDir = "";
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const sharedCreatedAt = new Date("2026-07-14T01:00:00.000Z");
  const largeText = "payload".repeat(100_000);

  beforeAll(async () => {
    const started = await startDatabase();
    db = createDb(started.connectionString);
    instance = started.instance;
    dataDir = started.dataDir;

    const migration = fs.readFileSync(
      new URL("../../../packages/db/src/migrations/0101_bizarre_morlun.sql", import.meta.url),
      "utf8",
    );
    const createBackfillFunction = migration.split("--> statement-breakpoint")[1]?.trim();
    if (!createBackfillFunction) throw new Error("Missing run summary backfill function migration statement");
    await db.execute(sql.raw(createBackfillFunction));

    await db.insert(organizations).values([
      {
        id: orgId,
        name: "Summary Org",
        urlKey: deriveOrganizationUrlKey(`summary-${orgId}`),
        issuePrefix: "SUM",
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherOrgId,
        name: "Other Org",
        urlKey: deriveOrganizationUrlKey(`other-${otherOrgId}`),
        issuePrefix: "OTH",
        requireBoardApprovalForNewAgents: false,
      },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        orgId,
        name: "Summary Agent",
        role: "engineer",
        status: "idle",
        agentRuntimeType: "codex_local",
        agentRuntimeConfig: { secret: "must-not-load" },
        runtimeConfig: { huge: "x".repeat(100_000) },
        permissions: {},
      },
      {
        id: otherAgentId,
        orgId: otherOrgId,
        name: "Other Agent",
        role: "engineer",
        status: "idle",
        agentRuntimeType: "process",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    const orderedIds = [
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ];
    await db.insert(heartbeatRuns).values(orderedIds.map((id, index) => ({
      id,
      orgId,
      agentId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "failed",
      startedAt: new Date(sharedCreatedAt.getTime() - 2_000),
      finishedAt: sharedCreatedAt,
      error: `failure-${index}-${largeText}`,
      errorCode: `failure_${index}`,
      usageJson: {
        inputTokens: 100 + index,
        cachedInputTokens: 20,
        outputTokens: 10,
        costUsd: 0.25,
        provider: "openai",
        model: "gpt-test",
        raw: largeText,
      },
      resultSummaryJson: { summary: `result-${index}`, costUsd: 0.25 },
      resultJson: { summary: `result-${index}-${largeText}`, raw: largeText },
      stdoutExcerpt: largeText,
      stderrExcerpt: largeText,
      contextSnapshot: {
        targetType: "chat_conversation",
        targetId: `conversation-${index}`,
        raw: largeText,
      },
      logStore: "local_file",
      logRef: `run-${index}.log`,
      logBytes: 1_000_000 + index,
      createdAt: sharedCreatedAt,
      updatedAt: sharedCreatedAt,
    })));
    await db.insert(heartbeatRunEvents).values({
      orgId,
      runId: orderedIds[0]!,
      agentId,
      seq: 1,
      eventType: "adapter.skill_usage",
      stream: "system",
      level: "info",
      payload: {
        usedSkillKeys: ["performance-review"],
        usedSkills: [{ key: "performance-review", label: "Performance Review" }],
      },
    });
    await db.insert(heartbeatRuns).values([
      {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        orgId,
        agentId,
        status: "succeeded",
        createdAt: new Date("2026-07-14T00:59:00.000Z"),
        updatedAt: new Date("2026-07-14T00:59:00.000Z"),
      },
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        orgId: otherOrgId,
        agentId: otherAgentId,
        status: "failed",
        createdAt: new Date("2026-07-14T01:01:00.000Z"),
        updatedAt: new Date("2026-07-14T01:01:00.000Z"),
      },
    ]);
    const pressureText = "p".repeat(200_000);
    await db.insert(heartbeatRuns).values(Array.from({ length: 50 }, (_, index) => ({
      id: randomUUID(),
      orgId,
      agentId,
      status: "succeeded",
      usageJson: { inputTokens: index + 1, outputTokens: 5, raw: pressureText },
      resultSummaryJson: { summary: `pressure-result-${index}` },
      resultJson: { summary: `pressure-result-${index}`, raw: pressureText },
      contextSnapshot: { targetType: "chat_conversation", targetId: `pressure-chat-${index}`, raw: pressureText },
      createdAt: new Date(sharedCreatedAt.getTime() - 60_000 - index),
      updatedAt: new Date(sharedCreatedAt.getTime() - 60_000 - index),
    })));
  }, 60_000);

  afterAll(async () => {
    await db.execute(sql.raw('DROP FUNCTION IF EXISTS "rudder_backfill_run_result_summary"(jsonb)'));
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("paginates equal timestamps by id without duplicates or omissions", async () => {
    const first = await listRunSummaries(db, {
      orgId,
      status: "failed",
      createdBefore: new Date("2026-07-14T02:00:00.000Z"),
      limit: 2,
    });
    const second = await listRunSummaries(db, {
      orgId,
      status: "failed",
      createdBefore: new Date("2026-07-14T02:00:00.000Z"),
      cursor: first.page.nextCursor,
      limit: 2,
    });

    expect(first.items.map((item) => item.id)).toEqual([
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ]);
    expect(first.page).toMatchObject({ limit: 2, hasMore: true });
    expect(second.items.map((item) => item.id)).toEqual([
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ]);
    expect(second.page).toEqual({ limit: 2, hasMore: false, nextCursor: null });
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);

    const beforeBoundary = await listRunSummaries(db, {
      orgId,
      status: "failed",
      createdBefore: sharedCreatedAt,
      limit: 2,
    });
    expect(beforeBoundary.items).toEqual([]);
  });

  it("keeps the response on a strict lightweight allowlist for production-shaped large payloads", async () => {
    const page = await listRunSummaries(db, {
      orgId,
      agentId,
      runtime: "codex_local",
      status: "failed",
      limit: 1,
    });
    const item = page.items[0]!;
    const serialized = JSON.stringify(page);

    expect(item).toMatchObject({
      orgId,
      agentId,
      runtime: "codex_local",
      durationMs: 2_000,
      target: { type: "chat_conversation", id: "conversation-0" },
      usage: {
        inputTokens: 100,
        cachedInputTokens: 20,
        outputTokens: 10,
        totalTokens: 110,
        costUsd: 0.25,
        provider: "openai",
        model: "gpt-test",
      },
      hasLog: true,
      logBytes: 1_000_000,
      error: "failure_0",
      outcome: "result-0",
      skillEvidence: {
        evidenceType: "used",
        matchedSkillKey: "performance-review",
        matchedSkillLabel: "Performance Review",
      },
    });
    expect(item.outcome?.length).toBeLessThanOrEqual(500);
    expect(serialized.length).toBeLessThan(5_000);
    for (const forbidden of [
      "resultJson",
      "contextSnapshot",
      "stdoutExcerpt",
      "stderrExcerpt",
      "sessionIdBefore",
      "processPid",
      "agentConfigFingerprint",
      "runtimeConfigFingerprint",
      largeText.slice(0, 1_000),
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("rejects malformed cursors", async () => {
    await expect(listRunSummaries(db, {
      orgId,
      cursor: "not-a-valid-cursor",
      limit: 10,
    })).rejects.toMatchObject({ status: 400, message: "Invalid run summary cursor." });

    const invalidIdCursor = Buffer.from(JSON.stringify({
      createdAt: "2026-07-14T01:00:00.000Z",
      id: "not-a-uuid",
    }), "utf8").toString("base64url");
    await expect(listRunSummaries(db, {
      orgId,
      cursor: invalidIdCursor,
      limit: 10,
    })).rejects.toMatchObject({ status: 400, message: "Invalid run summary cursor." });
  });

  it("keeps a 50-row production-shaped page below 150 KB", async () => {
    const page = await listRunSummaries(db, {
      orgId,
      limit: 50,
    });

    expect(page.items).toHaveLength(50);
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(150_000);
  });

  it("backfills bounded outcomes from chat bodies and terminal stdout events", async () => {
    const payloads = [
      { body: "Chat completed successfully." },
      {
        stdout: [
          JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex final answer." } }),
          JSON.stringify({ type: "turn.completed" }),
        ].join("\n"),
      },
      {
        stdout: JSON.stringify({
          type: "agent_end",
          messages: [{ role: "assistant", content: [{ type: "text", text: "Pi final answer." }] }],
        }),
        costUsd: { raw: "x".repeat(100_000) },
      },
      { summary: "Bounded cost migration.", costUsd: "1e999999" },
    ];

    const summaries = await Promise.all(payloads.map(async (payload) => {
      const rows = await db.execute(sql<{ summary: Record<string, unknown> | null }>`
        SELECT "rudder_backfill_run_result_summary"(${JSON.stringify(payload)}::jsonb) AS "summary"
      `);
      return rows[0]?.summary ?? null;
    }));

    expect(summaries).toEqual([
      { result: "Chat completed successfully." },
      { result: "Codex final answer." },
      { result: "Pi final answer." },
      { summary: "Bounded cost migration." },
    ]);
  });
});
