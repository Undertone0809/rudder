import {
  applyPendingMigrations,
  chatConversations,
  chatGenerationEvents,
  chatGenerations,
  createDb,
  ensurePostgresDatabase,
  organizations,
} from "@rudderhq/db";
import { eq, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChatGenerationProtocolTransaction } from "./chat-generation-protocol.helpers.js";
import { chatGenerationProtocolService } from "./chat-generation-protocol.js";
import { visibleGenerationProjectionThrough } from "./chat-generation-provenance.js";

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
  initdbFlags: string[];
  onLog: (message: unknown) => void;
  onError: (message: unknown) => void;
}) => EmbeddedPostgresInstance;

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
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

describe("chat generation provenance projection", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-provenance-"));
    const port = await availablePort();
    const mod = await import("embedded-postgres");
    const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
    instance = new EmbeddedPostgres({
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
    const adminUrl = "postgres://rudder:rudder@127.0.0.1:" + port + "/postgres";
    await ensurePostgresDatabase(adminUrl, "rudder");
    const connectionString = "postgres://rudder:rudder@127.0.0.1:" + port + "/rudder";
    await applyPendingMigrations(connectionString);
    db = createDb(connectionString);
  }, 60_000);

  afterAll(async () => {
    await instance?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  async function seedGeneration(acceptedThroughSeq: number) {
    const orgId = randomUUID();
    const conversationId = randomUUID();
    const generationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Provenance test",
      urlKey: "provenance-" + orgId.slice(0, 8),
      issuePrefix: "P" + orgId.slice(0, 7).toUpperCase(),
    });
    await db.insert(chatConversations).values({ id: conversationId, orgId, title: "Projection" });
    await db.insert(chatGenerations).values({
      id: generationId,
      orgId,
      conversationId,
      status: "stopped",
      acceptedThroughSeq,
    });
    return { orgId, conversationId, generationId };
  }

  it("pages durable events while retaining a bounded latest transcript window", async () => {
    const scope = await seedGeneration(240);
    const transcriptEvents = Array.from({ length: 200 }, (_, index) => ({
      orgId: scope.orgId,
      generationId: scope.generationId,
      generationSeq: index + 1,
      attemptEpoch: 1,
      eventKind: "transcript" as const,
      payload: {
        entry: {
          kind: "tool_call",
          ts: "2026-03-26T08:01:01.000Z",
          name: "read_file",
          toolUseId: "legacy-tool-" + index,
          input: { detail: "x".repeat(2_048) },
        },
      },
    }));
    const bodyEvents = Array.from({ length: 40 }, (_, index) => ({
      orgId: scope.orgId,
      generationId: scope.generationId,
      generationSeq: transcriptEvents.length + index + 1,
      attemptEpoch: 1,
      eventKind: "assistant_delta" as const,
      payload: { delta: "reply" },
    }));
    await db.insert(chatGenerationEvents).values([...transcriptEvents, ...bodyEvents]);

    const projection = await db.transaction((tx) => visibleGenerationProjectionThrough(
      tx, scope.generationId, 240,
    ));
    const transcriptBytes = projection.transcript.reduce(
      (total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8"),
      0,
    );
    const durableSequences = await db
      .select({ generationSeq: chatGenerationEvents.generationSeq })
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, scope.generationId));

    expect(durableSequences).toHaveLength(240);
    expect(projection.body).toBe("reply".repeat(bodyEvents.length));
    expect(projection.transcript.length).toBeLessThanOrEqual(128);
    expect(transcriptBytes).toBeLessThanOrEqual(128 * 1024);
    expect(projection.transcript.at(-1)).toMatchObject({ toolUseId: "legacy-tool-199" });
    expect(projection.transcript[0]).not.toMatchObject({ toolUseId: "legacy-tool-0" });
  });

  it("does not fetch one oversized legacy transcript event during frozen Stop projection", async () => {
    const scope = await seedGeneration(4);
    const oversizedContent = "z".repeat(256 * 1024);
    const fullBody = "body".repeat(48 * 1024);
    await db.insert(chatGenerationEvents).values([
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 1,
        attemptEpoch: 1, eventKind: "transcript",
        payload: { entry: { kind: "tool_call", ts: "2026-03-26T08:01:01.000Z", toolUseId: "before" } },
      },
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 2,
        attemptEpoch: 1, eventKind: "transcript",
        payload: { entry: {
          kind: "tool_result", ts: "2026-03-26T08:01:02.000Z",
          toolUseId: "oversized", content: oversizedContent,
        } },
      },
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 3,
        attemptEpoch: 1, eventKind: "transcript",
        payload: { entry: { kind: "tool_call", ts: "2026-03-26T08:01:03.000Z", toolUseId: "after" } },
      },
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 4,
        attemptEpoch: 1, eventKind: "assistant_delta", payload: { delta: fullBody },
      },
    ]);

    const selectedFields: Record<string, unknown>[] = [];
    const guardedProjection = await db.transaction((tx) => visibleGenerationProjectionThrough({
      select: (fields?: Record<string, unknown>) => {
        if (!fields) throw new Error("Stop projection selected full event rows");
        selectedFields.push(fields);
        return tx.select(fields as any);
      },
    } as unknown as ChatGenerationProtocolTransaction, scope.generationId, 4));
    const entrySelection = selectedFields.find((fields) => "entry" in fields);
    const entrySql = new PgDialect().sqlToQuery(entrySelection?.entry as SQL).sql;
    expect(entrySql).toContain("octet_length");
    expect(entrySql).toContain("case when");
    expect(selectedFields.every((fields) => !("payload" in fields))).toBe(true);

    const frozen = await chatGenerationProtocolService(db).getFrozenVisibleProjection({
      orgId: scope.orgId,
      conversationId: scope.conversationId,
      generationId: scope.generationId,
    });
    expect(frozen.generation.acceptedThroughSeq).toBe(4);
    expect(frozen.projection).toEqual(guardedProjection);
    expect(frozen.projection.body).toBe(fullBody);
    expect(frozen.projection.transcript).toEqual([
      expect.objectContaining({ toolUseId: "after" }),
    ]);

    const durableEvents = await db
      .select({ generationSeq: chatGenerationEvents.generationSeq, payload: chatGenerationEvents.payload })
      .from(chatGenerationEvents)
      .where(eq(chatGenerationEvents.generationId, scope.generationId));
    expect(durableEvents).toHaveLength(4);
    expect((durableEvents[1]?.payload.entry as { content: string }).content).toBe(oversizedContent);
  });

  it("prunes adjacent text deltas before constructing an oversized coalesced entry", async () => {
    const scope = await seedGeneration(2);
    const firstText = "a".repeat(80 * 1024);
    const latestText = "b".repeat(80 * 1024);
    await db.insert(chatGenerationEvents).values([
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 1,
        attemptEpoch: 1, eventKind: "transcript",
        payload: { entry: {
          kind: "assistant", ts: "2026-03-26T08:01:01.000Z", text: firstText, delta: true,
        } },
      },
      {
        orgId: scope.orgId, generationId: scope.generationId, generationSeq: 2,
        attemptEpoch: 1, eventKind: "transcript",
        payload: { entry: {
          kind: "assistant", ts: "2026-03-26T08:01:02.000Z", text: latestText, delta: true,
        } },
      },
    ]);

    const projection = await db.transaction((tx) => visibleGenerationProjectionThrough(
      tx, scope.generationId, 2,
    ));
    expect(projection.transcript).toEqual([
      expect.objectContaining({
        text: latestText,
        generationSeqStart: 2,
        generationSeqEnd: 2,
      }),
    ]);
    expect(Buffer.byteLength(JSON.stringify(projection.transcript[0]), "utf8"))
      .toBeLessThanOrEqual(128 * 1024);
  });
});
