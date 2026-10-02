import {
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  applyPendingMigrations,
  chatConversations,
  chatMessages,
  createDb,
  ensurePostgresDatabase,
  goals,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizations,
  organizationSkills,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { and, eq, isNull } from "drizzle-orm";
import express from "express";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { registerAgentInvocationInstructionsRoute } from "../routes/agents.management-invocation-instructions.ts";
import { chatAgentRunService } from "../services/chat-agent-runs.ts";
import { heartbeatService } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { readRunInstructionSnapshotForEvent } from "../services/run-instruction-snapshots.ts";
import { getRunSummary } from "../services/run-intelligence.ts";
import { createCursorTranscriptSupplementCapture } from "../services/runtime-kernel/cursor-transcript-supplement.ts";
import {
  attachRuntimeSpanSupplement,
  currentNativeSession,
  ensureRuntimeBinding,
  finishRunRuntimeSpan,
} from "../services/runtime-kernel/native-session.ts";
import { proveSealedNativeRunTranscript } from "../services/runtime-kernel/native-transcript-retention.ts";
import { persistNativeTransportProfile } from "../services/runtime-kernel/native-transport-profile.ts";
import { createTranscriptObjectReader, createTranscriptObjectStore, type TranscriptObjectStore } from "../services/runtime-kernel/transcript-object-store.ts";
import { createTranscriptReader, type NativeTranscriptReadInput } from "../services/runtime-kernel/transcript-reader.ts";
import * as unifiedRunIntegration from "../services/runtime-kernel/unified-agent-run.integration.ts";
import { createHeartbeatUnifiedAgentRunAdapter } from "../services/runtime-kernel/unified-agent-run.integration.ts";
import { getStorageService } from "../storage/index.ts";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.ts";
import { createStorageService } from "../storage/service.ts";
import type { ContentAddressedStorageService, PutFileInput, PutFileResult } from "../storage/types.ts";

async function expectSnapshotInstructions(event: any, text: string, storage = getStorageService()) {
  expect(event.payload).toMatchObject({ invocationInstructionSnapshot: { status: "available" },
    invocationInstructionTextReference: { source: "stored_snapshot" } });
  expect(event.payload).not.toHaveProperty("agentInstructionStack");
  await expect(readRunInstructionSnapshotForEvent({ db: snapshotTestDb, storage,
    orgId: event.orgId, runId: event.runId, eventId: event.id })).resolves.toMatchObject({ agentInstructionStack: text });
}
let snapshotTestDb: ReturnType<typeof createDb>;

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

function createInstructionSnapshotStorage() {
  const objects = new Map<string, Buffer>();
  const putContentAddressedFile = vi.fn(async (input: PutFileInput): Promise<PutFileResult> => {
    const sha256 = createHash("sha256").update(input.body).digest("hex");
    const objectKey = `${input.orgId}/${input.namespace}/${sha256}`;
    if (!objects.has(objectKey)) objects.set(objectKey, Buffer.from(input.body));
    return {
      provider: "local_disk",
      objectKey,
      contentType: input.contentType,
      byteSize: input.body.byteLength,
      sha256,
      originalFilename: input.originalFilename,
    };
  });
  const storage: ContentAddressedStorageService = {
    provider: "local_disk",
    putFile: putContentAddressedFile,
    putContentAddressedFile,
    async getObject(orgId, objectKey) {
      if (!objectKey.startsWith(`${orgId}/`)) throw new Error("organization mismatch");
      const body = objects.get(objectKey);
      if (!body) throw new Error("snapshot missing");
      return { stream: Readable.from([body]), contentLength: body.byteLength };
    },
    async headObject(orgId, objectKey) {
      return { exists: objectKey.startsWith(`${orgId}/`) && objects.has(objectKey) };
    },
    async deleteObject(orgId, objectKey) {
      if (objectKey.startsWith(`${orgId}/`)) objects.delete(objectKey);
    },
  };
  return { storage, objects, putContentAddressedFile };
}

async function getEmbeddedPostgresCtor(): Promise<EmbeddedPostgresCtor> {
  const mod = await import("embedded-postgres");
  return mod.default as EmbeddedPostgresCtor;
}

async function createExitedProcessPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid;
  if (!pid) throw new Error("Failed to start process-exit probe");
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let probeError: unknown;
  try {
    process.kill(pid, 0);
  } catch (error) {
    probeError = error;
  }
  if ((probeError as NodeJS.ErrnoException | undefined)?.code !== "ESRCH") {
    throw new Error(`Expected process ${pid} to be verifiably stopped`);
  }
  return pid;
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
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

async function startTempDatabase() {
  const externalConnectionString = process.env.RUDDER_CHAT_AGENT_RUNS_TEST_DATABASE_URL?.trim();
  if (externalConnectionString) {
    await applyPendingMigrations(externalConnectionString);
    return { connectionString: externalConnectionString, dataDir: "", instance: null };
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-agent-runs-"));
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

describe("chatAgentRunService", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof chatAgentRunService>;
  let instance: EmbeddedPostgresInstance | null = null;
  let dataDir = "";
  let objectDir = "";
  let objectStore: TranscriptObjectStore;

  beforeAll(async () => {
    const started = await startTempDatabase();
    console.info("W12 Chat caller isolated lease", { pgPort: new URL(started.connectionString).port, root: started.dataDir, pid: process.pid });
    db = createDb(started.connectionString);
    snapshotTestDb = db;
    objectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-transcript-objects-"));
    objectStore = createTranscriptObjectStore(objectDir);
    svc = chatAgentRunService(db, { transcriptObjectStore: objectStore });
    instance = started.instance;
    dataDir = started.dataDir;
  }, 20_000);

  afterEach(async () => {
    await db.delete(chatMessages);
    await db.delete(heartbeatRunEvents);
    await db.update(runRuntimeSpans).set({
      state: "unresolved",
      closedAt: new Date(),
      writerLeaseReleasedAt: new Date(),
    })
      .where(isNull(runRuntimeSpans.writerLeaseReleasedAt));
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(runRuntimeSpans);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(chatConversations);
    await db.delete(goals);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(organizationSkills);
    await db.delete(organizations);
  });

  afterAll(async () => {
    await instance?.stop();
    if (objectDir) fs.rmSync(objectDir, { recursive: true, force: true });
    if (dataDir) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  async function createChatRunFixture(
    label: string,
    maxConcurrentRuns?: number,
    runService = svc,
    runtimeType: "codex_local" | "claude_local" | "hermes_local" | "hermes_gateway" | "cursor" | "pi_local" | "opencode_local" = "codex_local",
    runContext?: Record<string, unknown>,
  ) {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const name = `${label} org`;
    await db.insert(organizations).values({
      id: orgId,
      name,
      urlKey: deriveOrganizationUrlKey(name),
      issuePrefix: "SUB",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: `${label} agent`,
      role: "engineer",
      status: "active",
      agentRuntimeType: runtimeType,
      agentRuntimeConfig: {},
      runtimeConfig: maxConcurrentRuns === undefined ? {} : { heartbeat: { maxConcurrentRuns } },
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: `${label} chat`,
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType,
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    return runService.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: randomUUID(),
      ...(runtimeType === "pi_local" ? { runContext: {
        transcriptSource: "legacy",
        runtimeProviderProfile: { runtimeType: "pi_local", providerVersion: "0.76.0" },
      } } : {}),
      ...(runContext ? { runContext } : {}),
    });
  }

  async function attestPiNativeTranscriptSource(run: Awaited<ReturnType<typeof createChatRunFixture>>) {
    await persistNativeTransportProfile(db, {
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch!,
      attemptId: run.runtimeAttemptRef!.id,
      nativeTranscriptAttested: true,
      profile: {
        runtimeType: "pi_local",
        command: "pi",
        cwd: "/workspace",
        sessionDir: "/managed/sessions",
        providerVersion: "0.76.0",
        rpcArgs: ["--extension", "/managed/rudder-tools.ts"],
        rpcEnv: { HOME: "/operator" },
      },
    });
  }

  it("captures Cursor updates with durable occurrence IDs on one fenced span across writer restart", async () => {
    const run = await createChatRunFixture("Cursor transcript capture", undefined, svc, "cursor");
    const scope = { orgId: run.orgId, runId: run.id, spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!, attemptEpoch: run.runtimeSpanAttemptEpoch! };
    const capture = createCursorTranscriptSupplementCapture(db, objectStore);
    const repeated = { kind: "assistant" as const, ts: "2026-09-24T00:00:00.000Z", text: "Again ", delta: true };
    await capture.append(scope, [repeated, repeated]);
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, scope.spanId));
    const ref = span!.supplementalObjectRef!;
    expect(ref).toBeTruthy();
    const input = { objectRef: ref, orgId: scope.orgId, runId: scope.runId,
      spanId: scope.spanId, ownerToken: scope.ownerToken };
    const first = await objectStore.readRange(input);
    expect(first.entries).toHaveLength(2);
    const ids = first.entries.map((entry) => entry.sourceEntryId);
    expect(new Set(ids).size).toBe(2);
    await expect(capture.append({ ...scope, ownerToken: "stale" }, [repeated])).rejects.toThrow("stale");
    await expect(capture.append({ ...scope, orgId: randomUUID() }, [repeated])).rejects.toThrow("stale");
    const resumed = createCursorTranscriptSupplementCapture(db, objectStore);
    await resumed.append(scope, [repeated]);
    await resumed.seal();
    const after = await objectStore.readRange(input);
    expect(after.entries.map((entry) => entry.sourceEntryId).slice(0, 2)).toEqual(ids);
    expect(new Set(after.entries.map((entry) => entry.sourceEntryId)).size).toBe(3);
    expect(after.completeness).toBe("partial");
    expect((await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id))).some(
      (event) => JSON.stringify(event).includes("Again "),
    )).toBe(false);
  });

  it("persists equal invoke text once while SQL events and Instructions snapshot retain actual text", async () => {
    const storage = createStorageService(createLocalDiskStorageProvider(fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-snapshot-"))));
    const invokeSvc = chatAgentRunService(db, { transcriptObjectStore: objectStore, instructionSnapshotStorage: storage });
    const run = await createChatRunFixture("Equal invoke snapshot", undefined, invokeSvc, "hermes_gateway");
    const prompt = "Instruction and debug input 原文🙂 " + "X".repeat(82_000);
    const meta = { agentRuntimeType: "hermes_gateway", command: "hermes", prompt, agentInstructionStack: prompt };
    await invokeSvc.appendAdapterInvoke(run, meta, []);
    const events = await heartbeatService(db).listEvents(run.id);
    const invoke = events.find(event => event.eventType === "adapter.invoke")!;
    expect(invoke.payload).toMatchObject({ invocationPromptReference: { sameAsInstructions: true }, invocationInstructionSnapshot: { status: "available" } });
    expect(invoke.payload).not.toHaveProperty("prompt");
    expect(invoke.payload).not.toHaveProperty("agentInstructionStack");
    const payload = invoke.payload as Record<string, unknown>;
    const serialized = JSON.stringify(payload);
    expect(Buffer.byteLength(JSON.stringify({ ...payload, prompt })) - Buffer.byteLength(serialized)).toBeGreaterThan(82_000);
    await expect(readRunInstructionSnapshotForEvent({ db, storage,
      orgId: run.orgId, runId: run.id, eventId: invoke.id })).resolves.toMatchObject({
      agentInstructionStack: prompt, sha256: createHash("sha256").update(prompt).digest("hex"), byteSize: Buffer.byteLength(prompt),
    });
    const app = express();
    app.use((req, _res, next) => { req.actor = { type: "board", source: "session", orgIds: [run.orgId] }; next(); });
    const router = express.Router();
    registerAgentInvocationInstructionsRoute({ router, db, storage, heartbeat: heartbeatService(db),
      resolveScope: () => ({ orgIds: [run.orgId] }), getCurrentUserRedactionOptions: async () => ({ enabled: false }) });
    app.use("/api", router);
    const response = await request(app).get(`/api/agent-runs/${run.id}/events/${invoke.id}/invocation-instructions`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: "stored_snapshot", completeness: "complete", agentInstructionStack: prompt });
    expect(response.headers["cache-control"]).toContain("no-store");
    const baseline = { ...payload, prompt };
    delete baseline.invocationInstructionTextReference;
    delete baseline.invocationPromptReference;
    console.info("snapshot-only new Chat SQL invoke bytes", { beforeBytes: Buffer.byteLength(JSON.stringify(baseline)),
      afterBytes: Buffer.byteLength(serialized), netSavedBytes: Buffer.byteLength(JSON.stringify(baseline)) - Buffer.byteLength(serialized) });
    expect(meta).toEqual({ agentRuntimeType: "hermes_gateway", command: "hermes", prompt, agentInstructionStack: prompt });
    await invokeSvc.sealSpan(run, { completeness: "unknown" });
    await invokeSvc.finalizeRun(run.id, { status: "failed", resultJson: { outcome: "test finished" } });
    const terminalResponse = await request(app).get(`/api/agent-runs/${run.id}/events/${invoke.id}/invocation-instructions`);
    expect(terminalResponse.status).toBe(200);
    expect(terminalResponse.body).toEqual(response.body);
    expect((await heartbeatService(db).listEvents(run.id)).filter(event => event.eventType === "adapter.invoke")).toHaveLength(1);
  });

  it("publishes the actual Chat invocation only after its event is committed", async () => {
    const storage = createStorageService(createLocalDiskStorageProvider(fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-committed-invoke-"))));
    const caller = chatAgentRunService(db, { transcriptObjectStore: objectStore, instructionSnapshotStorage: storage });
    const run = await createChatRunFixture("Committed Chat invocation", undefined, caller);
    const observed: Array<Promise<unknown[]>> = [];
    const unsubscribe = subscribeCompanyLiveEvents(run.orgId, event => {
      if (event.type === "heartbeat.run.event" && event.payload.runId === run.id && event.payload.eventType === "adapter.invoke") {
        // Start the independent connection read in the listener, not a lazy
        // query deferred until appendAdapterInvoke has already returned.
        observed.push((async () => await db.select().from(heartbeatRunEvents).where(and(
          eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.seq, event.payload.seq as number),
          eq(heartbeatRunEvents.eventType, "adapter.invoke"),
        )))());
      }
    });
    try {
      await caller.appendAdapterInvoke(run, { agentRuntimeType: "codex_local", command: "codex",
        prompt: "debug input", agentInstructionStack: "actual Instructions🙂" }, []);
      expect(observed).toHaveLength(1);
      expect(await observed[0]).toMatchObject([{ orgId: run.orgId, runId: run.id, payload: {
        invocationAttemptId: run.runtimeAttemptRef!.id, invocationSpanId: run.runtimeSpanId,
        invocationInstructionSnapshot: { status: "available" },
      } }]);
    } finally { unsubscribe(); caller.releaseOwnedRun(run.id); }
  });

  it.each(["takeover_after_renew", "stop_during_store"] as const)("rejects stale invocation through actual Chat caller: %s", async mode => {
    const storage = createStorageService(createLocalDiskStorageProvider(fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-owner-race-"))));
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let armed = false;
    const realFactory = unifiedRunIntegration.createHeartbeatUnifiedAgentRunAdapter;
    const factory = vi.spyOn(unifiedRunIntegration, "createHeartbeatUnifiedAgentRunAdapter").mockImplementation(database => {
      const adapter = realFactory(database);
      const renew = adapter.renewOwner.bind(adapter);
      adapter.renewOwner = async (...args) => {
        const result = await renew(...args);
        if (armed && mode === "takeover_after_renew") {
          armed = false;
          expect(result.ok).toBe(true);
          entered(); await held;
        }
        return result;
      };
      return adapter;
    });
    const realPut = storage.putContentAddressedFile.bind(storage);
    const put = mode === "stop_during_store" ? vi.spyOn(storage, "putContentAddressedFile").mockImplementation(async input => {
      entered(); await held; return realPut(input);
    }) : null;
    const caller = chatAgentRunService(db, { transcriptObjectStore: objectStore, instructionSnapshotStorage: storage });
    const run = await createChatRunFixture("Chat invocation race", undefined, caller);
    const published: unknown[] = [];
    const unsubscribe = subscribeCompanyLiveEvents(run.orgId, event => {
      if (event.type === "heartbeat.run.event" && event.payload.runId === run.id && event.payload.eventType === "adapter.invoke") published.push(event);
    });
    armed = true;
    const pending = caller.appendAdapterInvoke(run, { agentRuntimeType: "codex_local", command: "codex",
      prompt: "debug task", agentInstructionStack: "actual sanitized Instructions 原文🙂" }, []).then(() => null, error => error);
    try {
      await reached;
      if (mode === "takeover_after_renew") {
        const successor = randomUUID();
        await db.transaction(async tx => {
          await tx.update(heartbeatRuns).set({ executionOwnerToken: successor }).where(eq(heartbeatRuns.id, run.id));
          await tx.update(runRuntimeSpans).set({ ownerToken: successor }).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
          await tx.update(heartbeatRunAttempts).set({ ownerToken: successor }).where(eq(heartbeatRunAttempts.id, run.runtimeAttemptRef!.id));
        });
      } else {
        await caller.sealSpan(run, { completeness: "unknown" });
        await caller.finalizeRun(run.id, { status: "cancelled", resultJson: { outcome: "fixture Stop" } });
      }
      const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      const [spanBefore] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
      const [attemptBefore] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.id, run.runtimeAttemptRef!.id));
      release();
      const error = await pending;
      const invokes = (await heartbeatService(db).listEvents(run.id)).filter(event => event.eventType === "adapter.invoke");
      console.info("W12 Chat invocation race observed", { mode, orgId: run.orgId, runId: run.id, invokeCount: invokes.length, publishedCount: published.length });
      expect(invokes).toHaveLength(0);
      expect(published).toHaveLength(0);
      expect(error).toBeInstanceOf(Error);
      const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      const [spanAfter] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
      const [attemptAfter] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.id, run.runtimeAttemptRef!.id));
      expect(after).toEqual(before);
      expect(spanAfter).toEqual(spanBefore);
      expect(attemptAfter).toEqual(attemptBefore);
      console.info("W12 Chat invocation atomic guard", { mode, orgId: run.orgId, runId: run.id, invokeCount: 0, publishedCount: published.length });
    } finally { release(); await pending; unsubscribe(); caller.releaseOwnedRun(run.id); put?.mockRestore(); factory.mockRestore(); }
  }, 20_000);

  it.each(["offline", "timeout", "owner_loss", "store_timeout_resolve", "store_timeout_reject"] as const)("bounded snapshot caller keeps inline or rejects lost owner: %s", async mode => {
    const storage = createStorageService(createLocalDiskStorageProvider(fs.mkdtempSync(path.join(os.tmpdir(), "rudder-chat-caller-proof-"))));
    const realGet = storage.getObject.bind(storage);
    let acquired!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { acquired = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const storeTimeout = mode === "store_timeout_resolve" || mode === "store_timeout_reject";
    const realPut = storage.putContentAddressedFile.bind(storage);
    const put = storeTimeout ? vi.spyOn(storage, "putContentAddressedFile").mockImplementation(async input => {
      acquired(); await held;
      if (mode === "store_timeout_reject") throw new Error("late caller store rejection");
      return realPut(input);
    }) : null;
    const read = vi.spyOn(storage, "getObject").mockImplementation(async (org, key) => {
      if (storeTimeout) return realGet(org, key);
      acquired();
      if (mode === "offline") throw new Error("isolated offline storage");
      await held;
      return realGet(org, key);
    });
    const caller = chatAgentRunService(db, { transcriptObjectStore: objectStore, instructionSnapshotStorage: storage });
    const run = await createChatRunFixture("Bounded snapshot caller", undefined, caller);
    const prompt = "unique debug task";
    const stack = "Final sanitized Instructions 原文🙂";
    const pending = caller.appendAdapterInvoke(run, { agentRuntimeType: "codex_local", command: "codex",
      prompt, agentInstructionStack: stack }, []).then(() => null, error => error);
    await entered;
    try {
      if (mode === "owner_loss") {
        await db.update(heartbeatRuns).set({ executionOwnerToken: randomUUID() }).where(eq(heartbeatRuns.id, run.id));
        release();
        expect(await pending).toBeInstanceOf(Error);
        expect((await heartbeatService(db).listEvents(run.id)).filter(event => event.eventType === "adapter.invoke")).toHaveLength(0);
        console.info("W12 Chat owner-loss no-append", { orgId: run.orgId, runId: run.id });
        return;
      }
      expect(await pending).toBeNull();
      const before = (await heartbeatService(db).listEvents(run.id)).filter(event => event.eventType === "adapter.invoke");
      expect(before).toHaveLength(1);
      expect(before[0]!.payload).toMatchObject({ prompt, agentInstructionStack: stack,
        invocationInstructionSnapshot: { status: "unavailable", reason: storeTimeout ? "storage_unavailable" : "snapshot_readback_unavailable" } });
      expect(before[0]!.payload).not.toHaveProperty("invocationInstructionTextReference");
      release();
      if (put) {
        const lateStore = await put.mock.results[0]!.value.catch(() => null);
        if (mode === "store_timeout_resolve") {
          expect(lateStore).not.toBeNull();
          const object = await realGet(run.orgId, lateStore!.objectKey);
          const chunks = [];
          for await (const chunk of object.stream) chunks.push(Buffer.from(chunk));
          expect(Buffer.concat(chunks).toString("utf8")).toBe(stack);
        }
      }
      await caller.sealSpan(run, { completeness: "unknown" });
      await caller.finalizeRun(run.id, { status: "failed", resultJson: { outcome: "isolated proof finished" } });
      const after = (await heartbeatService(db).listEvents(run.id)).filter(event => event.eventType === "adapter.invoke");
      expect(after).toHaveLength(1);
      expect(after[0]!.payload).toEqual(before[0]!.payload);
      expect(read).toHaveBeenCalledTimes(storeTimeout ? 0 : 1);
      console.info("W12 Chat caller fallback terminal", { mode, orgId: run.orgId, runId: run.id, eventId: after[0]!.id });
    } finally { release(); read.mockRestore(); put?.mockRestore(); }
  }, 20_000);

  it.each([
    { prompt: "Instructions 原文🙂", agentInstructionStack: "Instructions 原文🙂", aliased: true, present: true },
    { prompt: "task", aliased: false, present: false },
    { prompt: "task", agentInstructionStack: null, aliased: false, present: false },
    { prompt: "task", agentInstructionStack: "", aliased: false, present: true },
    { prompt: "", agentInstructionStack: "", aliased: false, present: true },
    { prompt: "task", agentInstructionStack: "distinct Instructions", aliased: false, present: true },
    { prompt: "offline Instructions", agentInstructionStack: "offline Instructions", aliased: true, present: true, readbackUnavailable: true },
    { prompt: "distinct task", agentInstructionStack: "offline distinct Instructions", aliased: false, present: true, readbackUnavailable: true },
  ])("roundtrips persisted dedup metadata through the actual Chat compactor: %j", async ({ aliased, present, readbackUnavailable, ...fields }) => {
    const snapshots = createInstructionSnapshotStorage();
    if (readbackUnavailable) vi.spyOn(snapshots.storage, "getObject").mockRejectedValue(new Error("isolated readback unavailable"));
    const aliasSvc = chatAgentRunService(db, { transcriptObjectStore: objectStore, instructionSnapshotStorage: snapshots.storage,
      transcriptReaderFactory: database => createTranscriptReader(database as any, { nativeReader: { readRange: async () => ({
        items: [{ kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text: "native-only final" }],
        revision: "alias-native-r1", availability: "available", completeness: "complete",
      }) } }),
    });
    const run = await createChatRunFixture("Chat compactor alias", undefined, aliasSvc, "codex_local");
    const meta = { agentRuntimeType: "codex_local", command: "codex", ...fields };
    const original = structuredClone(meta);
    await aliasSvc.appendAdapterInvoke(run, meta as never, []);
    const before = (await heartbeatService(db).listEvents(run.id)).find(event => event.eventType === "adapter.invoke")!;
    const beforePayload = before.payload as Record<string, unknown>;
    if (aliased) expect(beforePayload.agentInstructionStackAlias).toMatchObject({ present: true, sameAsPrompt: true });
    else expect(beforePayload).not.toHaveProperty("agentInstructionStackAlias");
    // No stdout/transcript mirror is produced in this dedicated path. Existing
    // supplement fixtures remain intact and are denied cleanup in other cases.
    await aliasSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0, signal: null, timedOut: false, sessionId: "alias-thread", providerThreadId: "alias-thread",
      providerTurnId: "alias-turn", resultJson: { threadId: "alias-thread", turnId: "alias-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, { orgId: run.orgId, spanId: run.runtimeSpanId, ownerToken: run.runtimeSpanOwnerToken, attemptEpoch: run.runtimeSpanAttemptEpoch });
    await aliasSvc.finalizeRun(run.id, { status: "succeeded", resultJson: { outcome: "completed" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! } });
    const [final] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(final.contextSnapshot).toMatchObject({ nativeTranscriptRetention: { status: "reference_only" } });
    const after = (await heartbeatService(db).listEvents(run.id)).find(event => event.eventType === "adapter.invoke")!;
    const payload = after.payload as Record<string, unknown>;
    expect(after.id).toBe(before.id);
    if (aliased && !readbackUnavailable) expect(payload).not.toHaveProperty("prompt");
    else expect(payload.prompt).toBe(fields.prompt);
    if (typeof fields.agentInstructionStack === "string" && fields.agentInstructionStack.length > 0) {
      if (readbackUnavailable && !aliased) expect(payload.agentInstructionStack).toBe(fields.agentInstructionStack);
      else expect(payload).not.toHaveProperty("agentInstructionStack");
    } else if (Object.hasOwn(fields, "agentInstructionStack")) expect(payload.agentInstructionStack).toBe(fields.agentInstructionStack);
    const summary = (payload.invocationContent as Record<string, unknown>).agentInstructionStack;
    expect(summary).toMatchObject({ present });
    if (aliased) expect(summary).toEqual(beforePayload.agentInstructionStackAlias);
    else { expect(summary).not.toHaveProperty("sameAsPrompt"); expect(payload).not.toHaveProperty("agentInstructionStackAlias"); }
    if (readbackUnavailable) {
      expect(payload.invocationInstructionSnapshot).toMatchObject({ status: "unavailable", reason: "snapshot_readback_unavailable" });
      expect(payload).not.toHaveProperty("invocationInstructionTextReference");
    } else if (typeof fields.agentInstructionStack === "string" && fields.agentInstructionStack.length > 0) {
      await expect(readRunInstructionSnapshotForEvent({ db, storage: snapshots.storage, orgId: run.orgId,
        runId: run.id, eventId: after.id })).resolves.toMatchObject({ agentInstructionStack: fields.agentInstructionStack });
    }
    expect(meta).toEqual(original);
  });

  it("switches a live Cursor Run transcript source only for its current span owner", async () => {
    const run = await createChatRunFixture("Cursor source switch", undefined, svc, "cursor");
    const prompt = "Cursor transcript fallback keeps complete invocation evidence";
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "cursor", command: "cursor", prompt,
      agentInstructionStack: prompt, context: { fallbackReason: "profile transcript unavailable" },
    }, []);
    const stale = { ...run, runtimeSpanOwnerToken: randomUUID() };
    expect(await svc.markLegacyTranscriptSource(stale)).toBe(false);
    const [before] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect((before?.contextSnapshot as Record<string, unknown>)?.transcriptSource).not.toBe("legacy");

    expect(await svc.markLegacyTranscriptSource(run)).toBe(true);
    const [updated] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect((updated?.contextSnapshot as Record<string, unknown>)?.transcriptSource).toBe("legacy");

    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed" },
      transcriptDelivery: { source: "legacy", spanId: run.runtimeSpanId! },
    });
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    await expectSnapshotInstructions(invoke, prompt);
    expect(await svc.markLegacyTranscriptSource(run)).toBe(false);
  });

  it("attests a fresh Pi transcript only with a complete fenced Host RPC profile", async () => {
    const run = await createChatRunFixture("Pi first-run source", undefined, svc, "pi_local");
    const input = {
      orgId: run.orgId, runId: run.id, spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!, attemptEpoch: run.runtimeSpanAttemptEpoch!,
      attemptId: run.runtimeAttemptRef!.id, nativeTranscriptAttested: true,
      profile: { runtimeType: "pi_local", command: "pi", cwd: "/workspace",
        sessionDir: "/managed/sessions", rpcArgs: ["--extension", "/managed/rudder-tools.ts"],
        rpcEnv: { HOME: "/operator" } },
    };
    await expect(persistNativeTransportProfile(db, { ...input, profile: {
      ...input.profile, rpcArgs: [],
    } })).rejects.toThrow("complete Host RPC profile");
    await expect(persistNativeTransportProfile(db, { ...input, ownerToken: "stale" }))
      .rejects.toThrow("stale Run owner");
    const [before] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(before!.contextSnapshot?.transcriptSource).toBe("legacy");

    await persistNativeTransportProfile(db, input);
    const [after] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(after!.contextSnapshot).toMatchObject({
      transcriptSource: "native",
      runtimeProviderProfile: { ...input.profile, providerVersion: "0.76.0" },
    });
    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { outcome: "completed" } });
    await expect(persistNativeTransportProfile(db, input)).rejects.toThrow("stale Run owner");
  });

  it("retains invocation and full terminal result until a real native range read-back succeeds", async () => {
    const run = await createChatRunFixture("Native invocation retention", undefined, svc, "pi_local");
    const prompt = `Chat prompt ${"p".repeat(20_000)}`;
    const instructionStack = `Instruction stack ${"i".repeat(12_000)}`;
    const productReply = "Useful bounded product reply ".repeat(120);
    const earlierAttemptPrompt = "earlier fallback attempt remains fully auditable";
    // Distinct Instructions keep this case about raw-prompt retention, not
    // the separately tested equal-prompt snapshot alias optimization.
    const earlierInstructionStack = "earlier instructions remain independently auditable";
    const earlierRun = {
      ...run,
      runtimeAttemptRef: { ...run.runtimeAttemptRef! },
    };
    await svc.appendAdapterInvoke(earlierRun, {
      agentRuntimeType: "pi_local",
      command: "pi",
      prompt: earlierAttemptPrompt,
      agentInstructionStack: earlierInstructionStack,
      context: { fallbackAttempt: true },
    }, []);
    await svc.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "pre_submission",
      error: "fixture provider call was never made",
    });
    await svc.recordNativeExecutionResult(run.id, {
      exitCode: 1, signal: null, timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
      error: true,
    });
    await svc.beginRuntimeAttempt(run, {
      attemptIndex: 1, fallbackIndex: 1, runtimeType: "pi_local",
      model: null, isFallback: true, resumeSource: "pristine_replay",
    });
    expect(run.runtimeSpanId).not.toBe(earlierRun.runtimeSpanId);
    expect(run.runtimeAttemptRef!.id).not.toBe(earlierRun.runtimeAttemptRef.id);
    // A current Attempt cannot legitimize a foreign span; a real prior
    // Attempt/span also cannot append after the owned fence advances.
    for (const rejectedRun of [
      { ...run, runtimeSpanId: "foreign-attempt-span" },
      earlierRun,
    ]) {
      await expect(svc.appendAdapterInvoke(rejectedRun, {
        agentRuntimeType: "pi_local", command: "pi",
        prompt: "rejected stale invocation", agentInstructionStack: "rejected stale invocation",
      }, [])).rejects.toThrow("Chat invocation has no original local owner");
    }
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "pi_local",
      command: "pi",
      prompt,
      agentInstructionStack: instructionStack,
      context: { chatMode: true, privatePromptContext: "private context marker" },
      loadedSkills: [{ key: "run-skill", name: "Run skill" }],
      usedSkills: [{ key: "proof-skill", name: "Proof skill" }],
    }, [{ key: "run-skill", runtimeName: "run-skill", name: "Run skill", description: "Loaded for this run" }]);

    const stagedEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const stagedEvent = stagedEvents.find((event) => event.payload?.invocationAttemptId === run.runtimeAttemptRef!.id);
    const stagedEarlierEvent = stagedEvents.find((event) => event.payload?.invocationAttemptId === earlierRun.runtimeAttemptRef.id);
    expect(stagedEvents).toHaveLength(2);
    expect(stagedEvents.map((event) => event.payload?.invocationAttemptId).sort()).toEqual([
      earlierRun.runtimeAttemptRef.id, run.runtimeAttemptRef!.id,
    ].sort());
    expect(stagedEvent?.payload).toMatchObject({ prompt });
    expect(stagedEarlierEvent?.payload).toMatchObject({ prompt: earlierAttemptPrompt });
    await expectSnapshotInstructions(stagedEarlierEvent, earlierInstructionStack);
    await expectSnapshotInstructions(stagedEvent, instructionStack);
    expect(stagedEvent?.seq).toBeTruthy();

    await attestPiNativeTranscriptSource(run);
    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: {
        outcome: "completed",
        kind: "message",
        body: productReply,
        generatedAttachmentCount: 2,
      },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const compactedEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const retainedEvent = compactedEvents.find((event) => event.payload?.invocationAttemptId === run.runtimeAttemptRef!.id);
    const earlierInvoke = compactedEvents.find((event) => event.payload?.invocationAttemptId === earlierRun.runtimeAttemptRef.id);
    const payload = retainedEvent?.payload as Record<string, unknown>;
    const [finalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const retainedResult = finalizedRun?.resultJson as Record<string, unknown>;

    expect(retainedEvent?.seq).toBe(stagedEvent?.seq);
    expect(earlierInvoke?.payload).toMatchObject({
      prompt: earlierAttemptPrompt,
    });
    expect(earlierInvoke?.id).toBe(stagedEarlierEvent?.id);
    expect(earlierInvoke?.seq).toBe(stagedEarlierEvent?.seq);
    await expectSnapshotInstructions(earlierInvoke, earlierInstructionStack);
    expect(payload).toMatchObject({ prompt });
    await expectSnapshotInstructions(retainedEvent, instructionStack);
    expect(payload.context).toMatchObject({ chatMode: true, privatePromptContext: "private context marker" });
    expect(payload.desiredSkillKeys).toEqual(["run-skill"]);
    expect(payload.usedSkillKeys).toEqual(["proof-skill"]);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeGreaterThan(8_000);
    expect(retainedResult).toMatchObject({
      outcome: "completed",
      kind: "message",
      body: productReply,
    });
    expect((finalizedRun?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "incomplete",
    });
  });

  it("marks an unresolved terminal span incomplete and keeps its raw transcript", async () => {
    const run = await createChatRunFixture("Unresolved Chat retention proof");
    const entry = {
      kind: "assistant" as const,
      ts: new Date().toISOString(),
      text: "recoverable raw transcript without an exact native boundary",
    };
    await svc.appendTranscriptEntry(run, entry, { persistRaw: true, spanId: run.runtimeSpanId });

    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "product reply remains intact" },
      transcriptDelivery: { source: "legacy", runId: run.id, spanId: run.runtimeSpanId! },
    });

    const [finalized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const transcriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    expect(span?.state).toBe("unresolved");
    expect(finalized?.resultJson).toEqual({ outcome: "completed", body: "product reply remains intact" });
    expect(finalized?.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: { status: "incomplete", reason: "span_attempt_identity_incomplete" },
    });
    expect(transcriptEvents).toHaveLength(1);
    expect(transcriptEvents[0]?.payload).toMatchObject({ text: entry.text, spanId: run.runtimeSpanId });
  });

  it("marks stale Chat terminalization incomplete without deleting recovery events", async () => {
    const run = await createChatRunFixture("Stale Chat retention terminal");
    const entry = {
      kind: "assistant" as const,
      ts: new Date().toISOString(),
      text: "stale terminal raw recovery event",
    };
    await svc.appendTranscriptEntry(run, entry, { persistRaw: true, spanId: run.runtimeSpanId });
    const now = new Date();
    await db.update(heartbeatRuns).set({
      executionLeaseExpiresAt: new Date(now.getTime() - 1_000),
      updatedAt: new Date(now.getTime() - 60_000),
    }).where(eq(heartbeatRuns.id, run.id));

    await expect(svc.finalizeStaleRuns({
      olderThanMs: 0,
      now,
      recoveryCutoff: now,
    })).resolves.toBe(1);

    const [finalized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const transcriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    expect(finalized?.status).toBe("timed_out");
    expect(finalized?.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: {
        status: "incomplete",
        reason: "chat_run_stale_terminal_without_reader_proof",
      },
    });
    expect(transcriptEvents).toHaveLength(1);
    expect(transcriptEvents[0]?.payload).toMatchObject({ text: entry.text, spanId: run.runtimeSpanId });
  });

  it.each([
    ["codex_local", { resultJson: { threadId: "codex-thread" } }],
    ["claude_local", { resultJson: { transcriptBoundary: { status: "exact" } } }],
    ["hermes_gateway", { resultJson: { transcriptBoundary: { status: "exact" } } }],
    ["opencode_local", { resultJson: {
      userMessageId: "opencode-user",
      transcriptBoundary: { status: "exact", observedAssistantMessageIds: ["opencode-assistant"] },
    } }],
    ["pi_local", { resultJson: { leafId: "pi-leaf" } }],
    ["cursor", { resultJson: { nativeRangeRef: "cursor-range" } }],
  ] as const)("applies source-aware retention to a %s Chat Run without a native-source precondition", async (runtimeType, providerResult) => {
    const readSpans: string[] = [];
    const proofSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async (input) => {
          readSpans.push(`${input.run.id}:${input.span.id}`);
          return {
            items: [{ kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text: `${runtimeType} native transcript` }],
            revision: `${runtimeType}-reader-r1`,
            availability: "available",
            completeness: "complete",
          };
        } },
      }),
    });
    const run = await createChatRunFixture(
      `${runtimeType} legacy-source proof`,
      undefined,
      proofSvc,
      runtimeType,
      { transcriptSource: "legacy" },
    );
    const entry = {
      kind: "assistant" as const,
      ts: new Date().toISOString(),
      text: `W12_CHAT_NATIVE_${runtimeType}_${randomUUID()} ${"raw transcript duplicate ".repeat(500)}`,
    };
    await proofSvc.appendTranscriptEntry(run, entry, {
      persistRaw: false,
      persistSupplement: true,
      spanId: run.runtimeSpanId,
    });
    const [supplementSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    expect(supplementSpan?.supplementalObjectRef).toEqual(expect.any(String));
    const supplement = await objectStore.readRange({
      objectRef: supplementSpan!.supplementalObjectRef!,
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
    });
    expect(supplement.entries.map((item) => item.text)).toContain(entry.text);
    const preProofTranscriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    expect(preProofTranscriptEvents).toEqual([]);
    expect(JSON.stringify(preProofTranscriptEvents)).not.toContain(entry.text);
    await proofSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: `${runtimeType}-session`,
      providerTurnId: `${runtimeType}-terminal`,
      ...providerResult,
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });

    await proofSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: `${runtimeType} product reply` },
      transcriptDelivery: { source: "legacy", runId: run.id, spanId: run.runtimeSpanId! },
    });

    const [finalized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [cleanedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const transcriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    if (runtimeType === "cursor") {
      // Cursor's captured object is the durable history source. A hypothetical
      // native reader must not justify deleting the only complete transcript.
      expect(readSpans).toEqual([]);
      expect(finalized?.contextSnapshot).toMatchObject({
        nativeTranscriptRetention: { status: "incomplete", reason: "native_range_read_incomplete" },
      });
      expect(cleanedSpan?.supplementalObjectRef).toBe(supplementSpan!.supplementalObjectRef);
      expect((await objectStore.readRange({
        objectRef: cleanedSpan!.supplementalObjectRef!, orgId: run.orgId,
        runId: run.id, spanId: run.runtimeSpanId!, ownerToken: run.runtimeSpanOwnerToken!,
      })).entries.map((item) => item.text)).toContain(entry.text);
      expect(transcriptEvents).toHaveLength(0);
      return;
    }
    expect(new Set(readSpans)).toEqual(new Set([`${run.id}:${run.runtimeSpanId}`]));
    expect(finalized?.contextSnapshot).toMatchObject({
      transcriptSource: "legacy",
      nativeTranscriptRetention: { status: "cleanup_failed", reason: "supplement_native_coverage_unproven" },
    });
    expect(cleanedSpan?.supplementalObjectRef).toBe(supplementSpan!.supplementalObjectRef);
    expect(fs.existsSync(path.join(objectDir, "transcript-objects", `${supplementSpan!.supplementalObjectRef}.ndjson`))).toBe(true);
    expect(transcriptEvents).toHaveLength(0);
    expect(JSON.stringify({ finalized, transcriptEvents, cleanedSpan })).not.toContain(entry.text);
  });

  it("keeps Hermes local recovery evidence when shared Reader identity rejects its selector", async () => {
    const run = await createChatRunFixture(
      "Hermes local Reader identity blocker",
      undefined,
      svc,
      "hermes_local",
      { transcriptSource: "legacy" },
    );
    const entry = {
      kind: "assistant" as const,
      ts: new Date().toISOString(),
      text: "preserve Hermes local recovery evidence",
    };
    await svc.appendTranscriptEntry(run, entry, { persistRaw: true, spanId: run.runtimeSpanId });
    await svc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });

    await expect(svc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "hermes-local-session",
      providerTurnId: "hermes-local-execution",
      resultJson: { transcriptBoundary: { status: "exact" } },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    })).rejects.toThrow("selector.runtimeType=hermes_gateway");

    await expect(svc.finalizeRun(run.id, {
      status: "failed",
      resultJson: { outcome: "failed", recoverable: true },
      transcriptDelivery: { source: "legacy", runId: run.id, spanId: run.runtimeSpanId! },
    })).rejects.toThrow("selector.runtimeType=hermes_gateway");

    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const transcriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    expect(stillRunning?.status).toBe("running");
    expect(transcriptEvents).toHaveLength(1);
    expect(transcriptEvents[0]?.payload).toMatchObject({ text: entry.text, spanId: run.runtimeSpanId });
    await expect(objectStore.readRange({
      objectRef: span!.supplementalObjectRef!,
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
      allowOwnerRecovery: true,
    })).resolves.toMatchObject({ completeness: "partial", entries: [entry] });
  });

  it("retains Chat supplements despite stable paginated native proof and keeps Instructions readable", async () => {
    let nativeRevision = "native-chat-proof-r1";
    const instructionSnapshots = createInstructionSnapshotStorage();
    const readNativeEntries = async (input: NativeTranscriptReadInput) => {
      const offset = input.cursor ? Number(String(input.cursor).replace("proof-offset:", "")) : 0;
      const items = nativeEntries.slice(offset, offset + (input.limit ?? 200));
      const nextCursor = offset + items.length < nativeEntries.length ? `proof-offset:${offset + items.length}` : null;
      return { items, nextCursor, revision: nativeRevision, availability: "available" as const,
        completeness: nextCursor ? "partial" as const : "complete" as const };
    };
    const proofSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      instructionSnapshotStorage: instructionSnapshots.storage,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: readNativeEntries },
      }),
    });
    const run = await createChatRunFixture("Native Chat retention proof", undefined, proofSvc, "codex_local", {
      transcriptSource: "native",
    });
    const prompt = `retained prompt ${"x".repeat(5_000)}`;
    const instructionStack = "Actual injected Chat instructions: preserve the selected task context.";
    const reply = `native reply ${"y".repeat(2_500)}`;
    const nativeEntries = Array.from({ length: 225 }, (_, index) => ({
      kind: "assistant" as const,
      ts: new Date().toISOString(),
      text: index === 0 ? reply : `native detail ${index}`,
    }));
    await proofSvc.appendAdapterInvoke(run, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: instructionStack,
      context: { chatMode: true },
    }, []);
    for (const entry of nativeEntries) {
      await proofSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    }
    await proofSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-thread",
      providerThreadId: "native-chat-thread",
      providerTurnId: "native-chat-turn",
      resultJson: { threadId: "native-chat-thread", turnId: "native-chat-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    const objectRef = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!)).then((rows) => rows[0]?.supplementalObjectRef);
    expect(objectRef).toBeTruthy();
    await proofSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", kind: "message", body: reply },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const [finalized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const invokes = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(finalized?.resultJson).toMatchObject({
      outcome: "completed",
      kind: "message",
      body: reply,
    });
    expect(finalized?.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: { status: "cleanup_failed", reason: "supplement_native_coverage_unproven" },
    });
    expect(span?.supplementalObjectRef).toBe(objectRef);
    expect(invokes).toHaveLength(1);
    expect(invokes[0]?.payload).toMatchObject({
      invocationAttemptId: run.runtimeAttemptRef!.id,
      invocationSpanId: run.runtimeSpanId,
      invocationInstructionSnapshot: { status: "available" },
    });
    expect(invokes[0]?.payload).toMatchObject({ prompt });
    await expectSnapshotInstructions(invokes[0], instructionStack, instructionSnapshots.storage);
    expect(instructionSnapshots.putContentAddressedFile).toHaveBeenCalledTimes(1);
    await expect(readRunInstructionSnapshotForEvent({
      db,
      storage: instructionSnapshots.storage,
      orgId: run.orgId,
      runId: run.id,
      eventId: invokes[0]!.id,
    })).resolves.toMatchObject({
      agentInstructionStack: instructionStack,
      sha256: createHash("sha256").update(instructionStack).digest("hex"),
      byteSize: Buffer.byteLength(instructionStack),
    });
    expect(fs.existsSync(path.join(objectDir, "transcript-objects", `${objectRef}.ndjson`))).toBe(true);

    const reread = createTranscriptReader(db as any, {
      nativeReader: { readRange: readNativeEntries },
    });
    const rereadPages: Array<Awaited<ReturnType<typeof reread.readRun>>> = [];
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const page = await reread.readRun({
        orgId: run.orgId,
        runId: run.id,
        spanId: run.runtimeSpanId,
        principal: { type: "board", orgId: run.orgId, authorized: true },
        cursor,
        limit: 200,
      });
      rereadPages.push(page);
      cursor = page.nextCursor ?? null;
      if (!cursor) break;
    }
    const rereadItems = rereadPages.flatMap((page) => page.items);
    expect(cursor).toBeNull();
    expect(rereadPages).toHaveLength(2);
    expect(rereadPages.every((page) => page.source === "native"
      && page.availability === "available"
      && (page.completeness === "complete" || (page.completeness === "partial" && page.nextCursor)))).toBe(true);
    expect(rereadPages.at(-1)?.completeness).toBe("complete");
    expect(rereadItems).toHaveLength(225);
    expect(rereadItems[0]).toMatchObject({ runId: run.id, spanId: run.runtimeSpanId, text: reply });
  });

  it("attempts exact Reader proof for a legacy recovered source but retains unproven raw events", async () => {
    const requestedSpans: string[] = [];
    const sourceSvc = chatAgentRunService(db, { transcriptObjectStore: objectStore });
    const run = await createChatRunFixture("Legacy recovered Chat proof", undefined, sourceSvc, "codex_local", {
      transcriptSource: "legacy",
    });
    const prompt = "retain until the recovered Run span is proved";
    await sourceSvc.appendAdapterInvoke(run, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true },
    }, []);
    await sourceSvc.appendTranscriptEntry(run, {
      kind: "assistant",
      ts: new Date().toISOString(),
      text: "recoverable raw transcript",
    }, { persistRaw: true, spanId: run.runtimeSpanId });

    await db.update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, run.id));
    const recoveryClaim = await createHeartbeatUnifiedAgentRunAdapter(db).claimOwner(run.id);
    expect(recoveryClaim.ok).toBe(true);
    if (!recoveryClaim.ok) throw new Error(`expected recovery owner, got ${recoveryClaim.reason}`);
    sourceSvc.releaseOwnedRun(run.id, run.runtimeSpanOwnerToken);

    const proofSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async (input) => {
          requestedSpans.push(`${input.run.id}:${input.span.id}`);
          return {
            items: [{ kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text: "reader-owned transcript" }],
            revision: "legacy-recovery-native-r1",
            availability: "available",
            completeness: "complete",
          };
        } },
      }),
    });
    const recoveredRun = await proofSvc.adoptRecoveredRun(run.id, recoveryClaim.value.ownerToken);
    expect(recoveredRun).not.toBeNull();
    if (!recoveredRun) throw new Error("expected recovered Chat Run");
    expect(recoveredRun.runtimeSpanId).toBe(run.runtimeSpanId);
    expect(recoveredRun.runtimeSpanOwnerToken).not.toBe(run.runtimeSpanOwnerToken);

    await proofSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "legacy-recovery-thread",
      providerThreadId: "legacy-recovery-thread",
      providerTurnId: "legacy-recovery-turn",
      resultJson: { threadId: "legacy-recovery-thread", turnId: "legacy-recovery-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: recoveredRun.runtimeSpanId,
      ownerToken: recoveredRun.runtimeSpanOwnerToken,
      attemptEpoch: recoveredRun.runtimeSpanAttemptEpoch,
    });

    await proofSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "retained product reply" },
      transcriptDelivery: { source: "legacy", runId: run.id, spanId: recoveredRun.runtimeSpanId! },
    });

    const [finalized] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const transcriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    const invokes = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(requestedSpans.length).toBeGreaterThan(1);
    expect(new Set(requestedSpans)).toEqual(new Set([`${run.id}:${recoveredRun.runtimeSpanId}`]));
    expect(transcriptEvents).toHaveLength(1);
    await expectSnapshotInstructions(invokes[0], prompt);
    expect(finalized?.contextSnapshot).toMatchObject({
      transcriptSource: "legacy",
      nativeTranscriptRetention: { status: "cleanup_failed", reason: "transcript_events_native_coverage_unproven" },
    });
  });

  it("preserves Chat fallback copies when the full-page native read is incomplete", async () => {
    const failingSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async () => ({
          items: [entry],
          revision: "native-chat-partial-r1",
          availability: "available",
          completeness: "partial",
        }) },
        objectReader: createTranscriptObjectReader(objectStore),
      }),
    });
    const run = await createChatRunFixture("Native Chat partial proof", undefined, failingSvc, "codex_local", {
      transcriptSource: "native",
    });
    const prompt = `keep this prompt ${"p".repeat(1_000)}`;
    await failingSvc.appendAdapterInvoke(run, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true },
    }, []);
    const entry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "saved supplement" };
    await failingSvc.appendTranscriptEntry(run, entry, { persistRaw: true, spanId: run.runtimeSpanId });
    await failingSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    await failingSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-partial-thread",
      providerThreadId: "native-chat-partial-thread",
      providerTurnId: "native-chat-partial-turn",
      resultJson: { threadId: "native-chat-partial-thread", turnId: "native-chat-partial-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    const objectRef = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!)).then((rows) => rows[0]!.supplementalObjectRef!);
    const rawResult = { outcome: "completed", body: "fallback result" };
    await failingSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: rawResult,
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const rawTranscriptEvents = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    expect(persisted?.resultJson).toEqual(rawResult);
    expect(persisted?.contextSnapshot).toMatchObject({ nativeTranscriptRetention: { status: "incomplete" } });
    expect(span?.supplementalObjectRef).toBe(objectRef);
    await expectSnapshotInstructions(invoke, prompt);
    expect(rawTranscriptEvents).toHaveLength(1);
    expect(rawTranscriptEvents[0]?.payload).toMatchObject({ text: entry.text, spanId: run.runtimeSpanId });
    await expect(objectStore.readRange({
      objectRef,
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
      allowOwnerRecovery: true,
    })).resolves.toMatchObject({ completeness: "partial", entries: [entry] });
  });

  it("keeps full identity-fenced Chat transcript events until native Reader proof succeeds", async () => {
    const unavailableSvc = chatAgentRunService(db, {
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async () => ({
          items: [],
          revision: "native-chat-offline-r1",
          availability: "offline",
          completeness: "unknown",
        }) },
      }),
    });
    const run = await createChatRunFixture("Native Chat event fallback", undefined, unavailableSvc, "pi_local", {
      transcriptSource: "native",
    });
    const fullText = `complete transcript event ${"chat fallback ".repeat(400)}`;
    await unavailableSvc.appendTranscriptEntry(run, {
      kind: "assistant",
      ts: new Date().toISOString(),
      text: fullText,
    }, { persistRaw: true, spanId: run.runtimeSpanId });
    await unavailableSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-fallback-thread",
      providerThreadId: "native-chat-fallback-thread",
      providerTurnId: "native-chat-fallback-turn",
      resultJson: { threadId: "native-chat-fallback-thread", turnId: "native-chat-fallback-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    await unavailableSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "business result stays full" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "transcript.entry"),
    ));
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(event?.payload).toMatchObject({
      kind: "assistant",
      text: fullText,
      spanId: run.runtimeSpanId,
      attemptId: run.runtimeAttemptRef?.id,
    });
    expect(persisted?.resultJson).toEqual({ outcome: "completed", body: "business result stays full" });
    expect(persisted?.contextSnapshot).toMatchObject({ nativeTranscriptRetention: { status: "incomplete" } });
  });

  it("preserves Chat fallback copies when the native revision changes during read-back", async () => {
    let readCount = 0;
    const changingRevisionSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async () => ({
          items: [{ kind: "assistant", ts: new Date().toISOString(), text: "native response" }],
          revision: readCount++ === 0 ? "native-chat-revision-r1" : "native-chat-revision-r2",
          availability: "available",
          completeness: "complete",
        }) },
      }),
    });
    const run = await createChatRunFixture("Native Chat changing revision", undefined, changingRevisionSvc, "codex_local", {
      transcriptSource: "native",
    });
    const prompt = `preserve until revision is stable ${"r".repeat(500)}`;
    const entry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "recoverable supplement" };
    await changingRevisionSvc.appendAdapterInvoke(run, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true },
    }, []);
    await changingRevisionSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    await changingRevisionSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-changing-thread",
      providerThreadId: "native-chat-changing-thread",
      providerTurnId: "native-chat-changing-turn",
      resultJson: { threadId: "native-chat-changing-thread", turnId: "native-chat-changing-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    const [before] = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const rawResult = { outcome: "completed", body: "full fallback" };
    await changingRevisionSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: rawResult,
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(readCount).toBe(2);
    expect(persisted?.resultJson).toEqual(rawResult);
    expect(persisted?.contextSnapshot).toMatchObject({ nativeTranscriptRetention: { status: "incomplete" } });
    expect(span?.supplementalObjectRef).toBe(before?.supplementalObjectRef);
    await expectSnapshotInstructions(invoke, prompt);
  });

  it("rejects a sealed native proof bound to another owner and Attempt", async () => {
    const run = await createChatRunFixture("Native Chat proof owner fence", undefined, svc, "codex_local", {
      transcriptSource: "native",
    });
    await svc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-owner-thread",
      providerThreadId: "native-chat-owner-thread",
      providerTurnId: "native-chat-owner-turn",
      resultJson: { threadId: "native-chat-owner-thread", turnId: "native-chat-owner-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "keep full result" },
    });
    const reader = createTranscriptReader(db, {
      nativeReader: { readRange: async () => ({
        items: [{ kind: "assistant", ts: new Date().toISOString(), text: "native response" }],
        revision: "native-chat-owner-r1",
        availability: "available",
        completeness: "complete",
      }) },
    });
    await expect(proveSealedNativeRunTranscript({
      db,
      reader,
      orgId: run.orgId,
      runId: run.id,
      expectedOwner: {
        spanId: run.runtimeSpanId!,
        ownerToken: "different-owner",
        attemptEpoch: run.runtimeSpanAttemptEpoch!,
        attemptId: "different-attempt",
      },
    })).resolves.toMatchObject({ ok: false, reason: "owner_fence_mismatch" });
    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persisted?.resultJson).toEqual({ outcome: "completed", body: "keep full result" });
  });

  it("keeps Chat fallback state without attempting unproven supplemental deletion", async () => {
    const stageRemoval = vi.fn(async () => { throw new Error("simulated object staging failure"); });
    const failingObjectStore: TranscriptObjectStore = {
      ...objectStore,
      stageSealedRemoval: stageRemoval,
    };
    const deletionFailureSvc = chatAgentRunService(db, {
      transcriptObjectStore: failingObjectStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async () => ({
          items: [{ kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text: "native complete" }],
          revision: "native-chat-delete-failure-r1",
          availability: "available",
          completeness: "complete",
        }) },
      }),
    });
    const run = await createChatRunFixture("Native Chat object cleanup failure", undefined, deletionFailureSvc, "codex_local", {
      transcriptSource: "native",
    });
    const prompt = `preserve invocation ${"z".repeat(500)}`;
    const entry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "recoverable object transcript" };
    await deletionFailureSvc.appendAdapterInvoke(run, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true },
    }, []);
    await deletionFailureSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    await deletionFailureSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-object-failure-thread",
      providerThreadId: "native-chat-object-failure-thread",
      providerTurnId: "native-chat-object-failure-turn",
      resultJson: { threadId: "native-chat-object-failure-thread", turnId: "native-chat-object-failure-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    const [before] = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const rawResult = { outcome: "completed", body: "preserved Chat result" };
    await deletionFailureSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: rawResult,
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(persisted?.resultJson).toEqual(rawResult);
    expect(persisted?.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: { status: "cleanup_failed", reason: "supplement_native_coverage_unproven" },
    });
    expect(stageRemoval).not.toHaveBeenCalled();
    expect(span?.supplementalObjectRef).toBe(before?.supplementalObjectRef);
    await expectSnapshotInstructions(invoke, prompt);
    await expect(objectStore.readRange({
      objectRef: before!.supplementalObjectRef!,
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
      allowOwnerRecovery: true,
    })).resolves.toMatchObject({ completeness: "partial", entries: [entry] });
  });

  it("keeps a sealed supplement-only object without entering final purge", async () => {
    let staged: { objectRef: string; stageId: string } | null = null;
    const failingPurgeStore: TranscriptObjectStore = {
      ...objectStore,
      purgeStagedRemoval: async (input) => {
        staged = input;
        const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
        expect((pending?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
          status: "cleanup_pending",
          recovery: [{ kind: "transcript_object", objectRef: input.objectRef, stageId: input.stageId }],
        });
        throw new Error("simulated final object purge failure");
      },
    };
    const proofSvc = chatAgentRunService(db, {
      transcriptObjectStore: failingPurgeStore,
      transcriptReaderFactory: (database) => createTranscriptReader(database as any, {
        nativeReader: { readRange: async () => ({
          items: [{ kind: "assistant", ts: "2026-09-28T00:00:00.000Z", text: "verified native response" }],
          revision: "native-chat-object-purge-r1",
          availability: "available",
          completeness: "complete",
        }) },
      }),
    });
    const run = await createChatRunFixture("Native Chat final object purge failure", undefined, proofSvc, "codex_local", {
      transcriptSource: "native",
    });
    const recoveryText = "recoverable raw Chat supplement";
    await proofSvc.appendTranscriptEntry(run, {
      kind: "assistant",
      ts: new Date().toISOString(),
      text: recoveryText,
    }, { persistRaw: false, spanId: run.runtimeSpanId });
    await proofSvc.recordNativeExecutionResult(run.id, {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "native-chat-purge-thread",
      providerThreadId: "native-chat-purge-thread",
      providerTurnId: "native-chat-purge-turn",
      resultJson: { threadId: "native-chat-purge-thread", turnId: "native-chat-purge-turn" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
    });
    await proofSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "business reply" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    expect(staged).toBeNull();
    expect(persisted?.contextSnapshot).toMatchObject({
      nativeTranscriptRetention: { status: "cleanup_failed", reason: "supplement_native_coverage_unproven" },
    });
    expect(span?.supplementalObjectRef).toEqual(expect.any(String));
    const payload = path.join(objectDir, "transcript-objects", `${span!.supplementalObjectRef}.ndjson`);
    expect(fs.readFileSync(payload, "utf8")).toContain(recoveryText);

  });

  it.each(["partial", "unknown", "missing", "terminal_only"] as const)(
    "keeps OpenCode %s native history and invocation recovery evidence after successful exit",
    async (boundaryStatus) => {
      const run = await createChatRunFixture("OpenCode partial boundary", undefined, svc, "opencode_local", {
        transcriptSource: "native",
      });
      const prompt = `OpenCode invocation recovery ${"p".repeat(2_000)}`;
      await svc.appendAdapterInvoke(run, {
        agentRuntimeType: "opencode_local",
        command: "opencode",
        prompt,
        agentInstructionStack: prompt,
        context: { nativeTranscriptBoundary: "partial" },
      }, []);
      const supplementMarker = `W12_CHAT_RECOVERY_${randomUUID()} ${"supplemented recovery detail ".repeat(1_000)}`;
      await svc.appendTranscriptEntry(run, {
        kind: "tool_result",
        ts: new Date().toISOString(),
        text: supplementMarker,
      }, { persistRaw: false, spanId: run.runtimeSpanId });

      const span = await finishRunRuntimeSpan(db, {
        orgId: run.orgId,
        runId: run.id,
        spanId: run.runtimeSpanId,
        ownerToken: run.runtimeSpanOwnerToken!,
        attemptEpoch: run.runtimeSpanAttemptEpoch,
        runtimeType: "opencode_local",
        result: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
          sessionId: "opencode-session-r1",
          providerTurnId: "opencode-turn-r1",
          resultJson: {
            userMessageId: "opencode-user-r1",
            transcriptBoundary: {
              status: boundaryStatus,
              observedAssistantMessageIds: ["opencode-assistant-r1"],
            },
          },
        },
      });
      expect(span).toMatchObject({
        state: "sealed",
        completeness: "partial",
      });
      if (boundaryStatus === "partial") {
        expect(span?.selectorJson).toMatchObject({
          kind: "opencode_input",
          completeness: "partial",
          observedAssistantMessageIds: ["opencode-assistant-r1"],
          boundaryStatus: "partial",
        });
      }

      await svc.finalizeRun(run.id, {
        status: "succeeded",
        resultJson: { outcome: "completed" },
        transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
      });
      const [finalizedRun] = await db.select({
        resultJson: heartbeatRuns.resultJson,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
        .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      expect(finalizedRun?.resultJson).toEqual({ outcome: "completed" });
      expect(finalizedRun?.contextSnapshot).toMatchObject({
        nativeTranscriptRetention: {
          status: "incomplete",
          recovery: [expect.objectContaining({
            kind: "transcript_supplement",
            objectRef: expect.any(String),
            spanId: run.runtimeSpanId,
          })],
        },
      });
      const [retainedSpan] = await db.select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
        .from(runRuntimeSpans).where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
      expect(retainedSpan?.supplementalObjectRef).toBeTruthy();
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.filter((event) => event.eventType === "transcript.entry")).toEqual([]);
      expect(JSON.stringify({ finalizedRun, events, retainedSpan })).not.toContain(supplementMarker);
      const supplement = await objectStore.readRange({
        objectRef: retainedSpan!.supplementalObjectRef!,
        orgId: run.orgId,
        runId: run.id,
        spanId: run.runtimeSpanId!,
        ownerToken: run.runtimeSpanOwnerToken!,
      });
      expect(supplement.entries.map((item) => item.text)).toContain(supplementMarker);

      const reader = createTranscriptReader(db, {
        nativeReader: { readRange: async () => ({
          items: [{ kind: "assistant", ts: new Date().toISOString(), text: "observed partial native response" }],
          revision: "opencode-partial-r1",
          availability: "available",
          completeness: "partial",
        }) },
        objectReader: createTranscriptObjectReader(objectStore),
      });
      const page = await reader.readRun({
        orgId: run.orgId,
        runId: run.id,
        principal: { type: "board", orgId: run.orgId, authorized: true },
      });
      expect(page).toMatchObject({ source: "native_plus_objects", availability: "available", completeness: "partial" });
      expect(page.items.map((item) => item.text)).toEqual(expect.arrayContaining([
        "observed partial native response",
        supplementMarker,
      ]));

      const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.runId, run.id),
        eq(heartbeatRunEvents.eventType, "adapter.invoke"),
      ));
      await expectSnapshotInstructions(invoke, prompt);
      expect(invoke?.payload).not.toHaveProperty("prompt");
    },
  );

  it.each([
    ["partial", "partial"],
    ["unknown", "unknown"],
    ["missing", "missing"],
    ["terminal_only", "terminal_only"],
    ["legacy selector without boundary attestation", null],
  ] as const)("does not prove or compact an OpenCode span with a %s boundary", async (_label, boundaryStatus) => {
    const run = await createChatRunFixture("OpenCode selector proof fence", undefined, svc, "opencode_local", {
      transcriptSource: "native",
    });
    const prompt = `Retain invocation when selector boundary is ${boundaryStatus ?? "unattested"}`;
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "opencode_local",
      command: "opencode",
      prompt,
      agentInstructionStack: prompt,
      context: { nativeTranscriptBoundary: boundaryStatus ?? "absent" },
    }, []);
    await finishRunRuntimeSpan(db, {
      orgId: run.orgId,
      runId: run.id,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
      runtimeType: "opencode_local",
      result: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "opencode-session-proof-fence",
        providerTurnId: "opencode-turn-proof-fence",
        resultJson: {
          userMessageId: "opencode-user-proof-fence",
          ...(boundaryStatus ? { transcriptBoundary: {
            status: boundaryStatus,
            observedAssistantMessageIds: ["opencode-assistant-proof-fence"],
          } } : {}),
        },
      },
    });
    const legacySelector = {
      kind: "opencode_input",
      sessionId: "opencode-session-proof-fence",
      userMessageId: "opencode-user-proof-fence",
      terminalMessageIds: ["opencode-turn-proof-fence"],
    };
    await db.update(runRuntimeSpans).set({
      ...(boundaryStatus === null ? { selectorJson: legacySelector } : {}),
      completeness: "complete",
    })
      .where(eq(runRuntimeSpans.id, run.runtimeSpanId!));

    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });

    const [finalizedRun] = await db.select({ resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    const [invoke] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    expect(finalizedRun?.resultJson).toEqual({ outcome: "completed" });
    await expectSnapshotInstructions(invoke, prompt);
  });

  it("does not trust a preflight native hint or compact failure evidence", async () => {
    const run = await createChatRunFixture("Unattested invocation retention");
    const prompt = "full invocation audit remains until final source is attested";
    const preflightMarkedRun = {
      ...run,
      contextSnapshot: { ...run.contextSnapshot, transcriptSource: "native" },
    };
    await svc.appendAdapterInvoke(preflightMarkedRun, {
      agentRuntimeType: "codex_local",
      command: "codex",
      prompt,
      agentInstructionStack: prompt,
      context: { chatMode: true, privatePromptContext: "preserve until final policy" },
    }, []);
    await svc.sealSpan(run, { completeness: "complete" });
    await svc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { outcome: "completed", body: "unattested result stays full" },
      transcriptDelivery: { source: "native", spanId: run.runtimeSpanId! },
    });
    let [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    await expectSnapshotInstructions(event, prompt);
    let [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(savedRun?.resultJson).toMatchObject({ body: "unattested result stays full" });
  });

  it("keeps complete invocation and failure result evidence when final status is failed", async () => {
    const failedRun = await createChatRunFixture("Failed native invocation retention", undefined, svc, "pi_local");
    const failurePrompt = "failure audit prompt must remain complete";
    await svc.appendAdapterInvoke(failedRun, {
      agentRuntimeType: "pi_local", command: "pi", prompt: failurePrompt,
      agentInstructionStack: failurePrompt, context: { failureContext: "retain" },
    }, []);
    await attestPiNativeTranscriptSource(failedRun);
    await svc.sealSpan(failedRun, { completeness: "complete" });
    await svc.finalizeRun(failedRun.id, {
      status: "failed",
      resultJson: { outcome: "failed", partialBody: "failure body remains complete" },
      transcriptDelivery: { source: "native", spanId: failedRun.runtimeSpanId! },
    });
    const [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, failedRun.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    await expectSnapshotInstructions(event, failurePrompt);
    const [savedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, failedRun.id));
    expect(savedRun?.resultJson).toMatchObject({ partialBody: "failure body remains complete" });
  });

  it("keeps the full invocation durable while a native Run waits for network recovery", async () => {
    const run = await createChatRunFixture("Network pending invocation", undefined, svc, "pi_local");
    const prompt = "persist complete invocation while waiting for provider recovery";
    await svc.appendAdapterInvoke(run, {
      agentRuntimeType: "pi_local", command: "pi", prompt,
      agentInstructionStack: prompt, context: { retryContext: "preserve" },
    }, []);
    await attestPiNativeTranscriptSource(run);
    await svc.markWaitingForNetwork(run, {
      kind: "network_unavailable",
      submissionPhase: "indeterminate",
      continuation: "resume_same_session",
      transport: "stream_disconnect",
      provider: "pi",
      model: "test-model",
      modelOutputObserved: false,
      toolActivityObserved: false,
      sideEffectRisk: "none",
      message: "provider stream disconnected",
    }, run.runtimeSpanOwnerToken!);

    const [event] = await db.select().from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.eventType, "adapter.invoke"),
    ));
    const [waitingRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    await expectSnapshotInstructions(event, prompt);
    expect(waitingRun).toMatchObject({ status: "running", runningSubstate: "waiting_for_network" });
    expect(waitingRun?.resultJson).toBeNull();
    svc.releaseOwnedRun(run.id, run.runtimeSpanOwnerToken);
  });

  it("creates one active run per conversation, finalizes stale runs, and links assistant messages", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    const goalId = randomUUID();
    const foreignOrgId = randomUUID();
    const foreignGoalId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(organizations).values({
      id: foreignOrgId,
      name: "Other Rudder",
      urlKey: deriveOrganizationUrlKey("Other Rudder"),
      issuePrefix: "OTH",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(goals).values([
      { id: goalId, orgId, title: "Conversation Goal" },
      { id: foreignGoalId, orgId: foreignOrgId, title: "Foreign Goal" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "pi_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Run-backed chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "pi_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const conversation = {
      id: conversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      userMessageId: messageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: goalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: messageId,
      runtimeModel: null,
    });

    expect(firstRun.status).toBe("running");
    expect(firstRun.invocationSource).toBe("chat");
    expect(firstRun.sessionReuseScope).toBe("none");
    expect(firstRun.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "chat_conversation",
      targetId: conversationId,
      conversationId,
      messageId,
      userMessageId: messageId,
      goalId,
    });
    expect(firstRun.goalId).toBe(goalId);
    const transportInput = {
      orgId, runId: firstRun.id, spanId: firstRun.runtimeSpanId!,
      ownerToken: firstRun.runtimeSpanOwnerToken!,
      attemptEpoch: firstRun.runtimeSpanAttemptEpoch!,
      attemptId: firstRun.runtimeAttemptRef!.id,
      profile: { runtimeType: "pi_local", cwd: "/trusted/workspace" },
    };
    await persistNativeTransportProfile(db, transportInput);
    for (const override of [
      { ownerToken: "stale" }, { attemptEpoch: transportInput.attemptEpoch + 1 },
      { attemptId: randomUUID() }, { orgId: foreignOrgId },
      { profile: { runtimeType: "codex_local", cwd: "/foreign/workspace" } },
    ]) {
      await expect(persistNativeTransportProfile(db, { ...transportInput, ...override })).rejects.toThrow("Native transport profile rejected");
    }
    const [profileRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(profileRun!.contextSnapshot?.runtimeProviderProfile).toEqual(transportInput.profile);
    const observed = { kind: "assistant" as const, ts: new Date().toISOString(), text: "native supplement marker" };
    await svc.appendTranscriptEntry(firstRun, observed, { persistRaw: false, spanId: firstRun.runtimeSpanId });
    const [spanWithObject] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, firstRun.runtimeSpanId!));
    expect(spanWithObject?.supplementalObjectRef).toBeTruthy();
    const competingAttachment = await attachRuntimeSpanSupplement(db, {
      orgId, runId: firstRun.id, spanId: firstRun.runtimeSpanId!,
      ownerToken: firstRun.runtimeSpanOwnerToken!, attemptEpoch: spanWithObject!.attemptEpoch,
      objectRef: "competing-object-must-not-replace-evidence",
    });
    expect(competingAttachment?.supplementalObjectRef).toBe(spanWithObject!.supplementalObjectRef);
    const objectInput = { objectRef: spanWithObject!.supplementalObjectRef!, orgId, runId: firstRun.id,
      spanId: spanWithObject!.id, ownerToken: firstRun.runtimeSpanOwnerToken! };
    const objectPage = await objectStore.readRange(objectInput);
    expect(objectPage.entries).toContainEqual(expect.objectContaining(observed));
    expect(objectPage.source).toBe("native_plus_objects");
    expect(objectPage.completeness).toBe("partial");
    const reader = createTranscriptReader(db, {
      nativeReader: { readRange: async () => ({ items: [], revision: "native-offline", availability: "offline", completeness: "unknown" }) },
      objectReader: createTranscriptObjectReader(objectStore),
    });
    const readerPage = await reader.readRun({ orgId, runId: firstRun.id,
      principal: { type: "board", orgId, authorized: true, scopeRef: "user:operator" } });
    expect(readerPage.source).toBe("native_plus_objects");
    expect(readerPage.items).toEqual(expect.arrayContaining([expect.objectContaining({ runId: firstRun.id, spanId: firstRun.runtimeSpanId, text: observed.text })]));
    await expect(objectStore.readRange({ ...objectInput, orgId: foreignOrgId })).rejects.toThrow();
    const persistedEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, firstRun.id));
    expect(JSON.stringify(persistedEvents)).not.toContain(observed.text);
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      linkedGoalId: foreignGoalId,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("same organization");
    const firstRunSummary = await getRunSummary(db, firstRun.id, { orgIds: [orgId] });
    expect(firstRunSummary?.sessionReuseScope).toBe("none");
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    })).rejects.toThrow("already active");

    await expect(svc.finalizeStaleRuns({
      conversationId,
      olderThanMs: 0,
      error: "test stale chat run",
      errorCode: "test_chat_run_stale",
    })).resolves.toBe(0);

    const recoveryNow = new Date(Date.now() + 10 * 60_000);
    const exitedProviderPid = await createExitedProcessPid();
    await db
      .update(heartbeatRuns)
      .set({
        executionLeaseExpiresAt: new Date(recoveryNow.getTime() - 1),
        processExitedAt: recoveryNow,
        processPid: exitedProviderPid,
      })
      .where(eq(heartbeatRuns.id, firstRun.id));
    const recoveryResults = await Promise.all([
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
      heartbeatService(db).reapOrphanedRuns({ now: recoveryNow, recoveryCutoff: recoveryNow }),
    ]);
    expect(recoveryResults.reduce((total, result) => total + result.reaped, 0)).toBe(1);

    const [timedOutRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(timedOutRun?.status).toBe("failed");
    expect(timedOutRun?.errorCode).toBe("process_lost_acceptance_unresolved");
    const [reapedAttempt] = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, firstRun.id));
    const [reapedSpan] = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, firstRun.id));
    expect(reapedAttempt).toMatchObject({ status: "failed", id: firstRun.runtimeAttemptRef?.id });
    expect(reapedSpan).toMatchObject({
      state: "unresolved",
      completeness: "unknown",
      attemptId: reapedAttempt?.id,
      closedAt: expect.any(Date),
      writerLeaseReleasedAt: expect.any(Date),
    });

    await svc.finalizeRun(firstRun.id, {
      status: "succeeded",
      resultJson: { summary: "late chat completion" },
      usageJson: { inputTokens: 10, outputTokens: 2 },
    });
    const [lateFinalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, firstRun.id));
    expect(lateFinalizedRun).toMatchObject({
      status: "failed",
      errorCode: "process_lost_acceptance_unresolved",
      resultJson: { summary: "late chat completion" },
    });

    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      inputCorrelationRef: randomUUID(),
    });

    await expect(svc.linkAssistantMessage(secondRun.id, conversationId, randomUUID())).resolves.toBeNull();
    const eventsBeforeLink = await db
      .select()
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(eventsBeforeLink.some((event) => event.eventType === "chat.message_linked")).toBe(false);

    await db.insert(chatMessages).values({
      id: messageId,
      orgId,
      conversationId,
      role: "assistant",
      kind: "message",
      status: "completed",
      body: "Done.",
      replyingAgentId: agentId,
    });

    await svc.linkAssistantMessage(secondRun.id, conversationId, messageId);

    const [message] = await db.select().from(chatMessages).where(eq(chatMessages.id, messageId));
    expect(message?.runId).toBe(secondRun.id);

    const [linkedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(linkedRun?.chatConversationId).toBe(conversationId);
    expect(linkedRun?.contextSnapshot).toMatchObject({ assistantMessageId: messageId, messageId });

    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, secondRun.id));
    expect(events.some((event) => event.eventType === "chat.message_linked")).toBe(true);

    const largeRawResult = "x".repeat(200_000);
    await svc.finalizeRun(secondRun.id, {
      status: "succeeded",
      resultJson: {
        summary: "s".repeat(800),
        costUsd: 0.42,
        raw: largeRawResult,
      },
    });
    const [finalizedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, secondRun.id));
    expect(finalizedRun?.resultJson).toMatchObject({ raw: largeRawResult });
    expect(finalizedRun?.resultSummaryJson).toEqual({
      summary: "s".repeat(500),
      costUsd: 0.42,
    });
  });

  it("gives an older queued heartbeat Run priority over repeated Chat stream arrivals", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const secondConversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Cross-scene capacity org",
      urlKey: deriveOrganizationUrlKey("Cross-scene capacity org"),
      issuePrefix: "CSC",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Capacity-limited Chat Runner",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
    });
    await db.insert(chatConversations).values([
      {
        id: conversationId,
        orgId,
        title: "Stream race",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: secondConversationId,
        orgId,
        title: "Capacity rejection",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const [runtimeBinding, secondBinding] = await Promise.all([
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
      ensureRuntimeBinding(db, {
        orgId,
        conversationId: secondConversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
    ]);
    const [nativeSession, secondSession] = await Promise.all([
      currentNativeSession(db, runtimeBinding),
      currentNativeSession(db, secondBinding),
    ]);

    let enterClaim!: () => void;
    let releaseClaim!: () => void;
    const claimEntered = new Promise<void>((resolve) => { enterClaim = resolve; });
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const heartbeat = heartbeatService(db, {
      beforeRunClaim: async () => {
        enterClaim();
        await claimGate;
      },
    });
    const wakeupPromise = heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "chat_stream_capacity_race",
      contextSnapshot: {},
    });

    try {
      await claimEntered;
      const queuedRun = await db
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "queued")))
        .then((rows) => rows[0] ?? null);
      expect(queuedRun).toBeTruthy();

      for (const [targetConversationId, binding, segment] of [
        [conversationId, runtimeBinding, nativeSession.segment],
        [secondConversationId, secondBinding, secondSession.segment],
        [conversationId, runtimeBinding, nativeSession.segment],
      ] as const) {
        await expect(svc.createRun({
          conversation: { id: targetConversationId, orgId, primaryIssueId: null, planMode: false },
          agentId,
          triggerDetail: "chat_assistant_reply_stream",
          userMessageId: randomUUID(),
          linkedIssueIds: [],
          linkedProjectId: null,
          runtimeBinding: binding,
          runtimeSegment: segment,
          inputCorrelationRef: randomUUID(),
          scene: "chat",
        })).rejects.toThrow("older due queued run");
      }

      releaseClaim();
      await wakeupPromise;

      const agentRuns = await db
        .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, agentId));
      expect(agentRuns).toHaveLength(1);
      expect(agentRuns[0]).toMatchObject({ id: queuedRun!.id });
      expect(agentRuns[0]?.status).not.toBe("queued");
      await vi.waitFor(async () => {
        const [attempt] = await db.select({ id: heartbeatRunAttempts.id })
          .from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, queuedRun!.id));
        const [settled] = await db.select({
          status: heartbeatRuns.status,
          terminalEffectsPending: heartbeatRuns.terminalEffectsPending,
        }).from(heartbeatRuns).where(eq(heartbeatRuns.id, queuedRun!.id));
        expect(attempt).toBeTruthy();
        expect(settled?.status).not.toBe("running");
        expect(settled?.terminalEffectsPending).toBe(false);
      }, { timeout: 10_000 });
    } finally {
      releaseClaim();
      await wakeupPromise.catch(() => undefined);
    }
  });

  it("keeps a Chat-first admission running when a heartbeat wakeup arrives later", async () => {
    const streamRun = await createChatRunFixture("Chat wins first", 1);
    const queuedRun = await heartbeatService(db).wakeup(streamRun.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "after_chat_admission",
      contextSnapshot: { taskKey: "later-heartbeat-work" },
    });
    const agentRuns = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, streamRun.agentId));
    expect(agentRuns).toEqual(expect.arrayContaining([
      { id: streamRun.id, status: "running" },
      { id: queuedRun.id, status: "queued" },
    ]));
  });

  it("does not signal lease loss to the live stream after committing Run success", async () => {
    const run = await createChatRunFixture("Successful Chat stream owner");
    const execution = svc.beginOwnedRunExecution(run);
    try {
      await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { outcome: "completed" } });
      expect(execution.signal.aborted).toBe(false);
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, run.id)))[0]?.status).toBe("succeeded");
    } finally {
      execution.release();
    }
  });

  it("holds capacity for a live Chat provider through expiry and owner loss until execution settles", async () => {
    const ownedSvc = chatAgentRunService(db, {
      transcriptObjectStore: objectStore,
      leaseRenewIntervalMs: 20,
    });
    const run = await createChatRunFixture("Held Chat provider", 1, ownedSvc);
    const execution = ownedSvc.beginOwnedRunExecution(run);
    let settleProvider!: () => void;
    const providerSettled = new Promise<void>((resolve) => { settleProvider = resolve; });
    let providerWorkCount = 0;
    const providerWork = (async () => {
      providerWorkCount += 1;
      await providerSettled;
    })();
    const queued = await heartbeatService(db).wakeup(run.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "queued_during_held_chat_provider",
      contextSnapshot: { taskKey: "waiting-for-held-chat" },
    });
    const recovery = heartbeatService(db);
    try {
      const now = new Date();
      await db.update(heartbeatRuns).set({ executionLeaseExpiresAt: new Date(now.getTime() - 1) })
        .where(eq(heartbeatRuns.id, run.id));
      expect(await recovery.reapOrphanedRuns({ now, recoveryCutoff: now })).toMatchObject({ reaped: 0 });
      expect(execution.signal.aborted).toBe(false);
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued.id)))[0]?.status).toBe("queued");

      await db.update(heartbeatRuns).set({
        executionOwnerToken: randomUUID(),
        executionLeaseExpiresAt: new Date(Date.now() - 1),
      }).where(eq(heartbeatRuns.id, run.id));
      await vi.waitFor(() => expect(execution.signal.aborted).toBe(true), { timeout: 5_000 });
      expect(await recovery.reapOrphanedRuns({ now: new Date(), recoveryCutoff: new Date() }))
        .toMatchObject({ reaped: 0 });
      expect((await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queued.id)))[0]?.status).toBe("queued");
      expect(await db.select({ id: heartbeatRunAttempts.id }).from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, queued.id))).toHaveLength(0);
      expect(providerWorkCount).toBe(1);

      settleProvider();
      await providerWork;
      execution.release();
      const exitedProviderPid = await createExitedProcessPid();
      await db.update(heartbeatRuns).set({
        processPid: exitedProviderPid,
        processExitedAt: new Date(),
      })
        .where(eq(heartbeatRuns.id, run.id));
      expect(await recovery.reapOrphanedRuns({ now: new Date(), recoveryCutoff: new Date() }))
        .toMatchObject({ reaped: 1 });
      expect(providerWorkCount).toBe(1);
      await vi.waitFor(async () => {
        const [attempt] = await db.select({ id: heartbeatRunAttempts.id })
          .from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, queued.id));
        const [settled] = await db.select({ status: heartbeatRuns.status, terminalEffectsPending: heartbeatRuns.terminalEffectsPending })
          .from(heartbeatRuns).where(eq(heartbeatRuns.id, queued.id));
        expect(attempt).toBeTruthy();
        expect(settled?.status).not.toBe("running");
        expect(settled?.terminalEffectsPending).toBe(false);
      }, { timeout: 10_000 });
    } finally {
      settleProvider();
      await providerWork;
      execution.release();
    }
  });

  it("stores automation run target metadata on chat-backed agent runs", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const automationRunId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Rudder",
      urlKey: deriveOrganizationUrlKey("Rudder"),
      issuePrefix: "RDR",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Chat Runner",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Automation chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);

    const run = await svc.createRun({
      conversation: {
        id: conversationId,
        orgId,
        primaryIssueId: null,
        planMode: false,
      },
      agentId,
      triggerDetail: "chat_assistant_reply_stream",
      userMessageId,
      linkedIssueIds: [],
      linkedProjectId: null,
      runContext: {
        targetType: "automation_run",
        targetId: automationRunId,
        automationRunId,
      },
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: userMessageId,
    });

    expect(run.contextSnapshot).toMatchObject({
      scene: "chat",
      targetType: "automation_run",
      targetId: automationRunId,
      automationRunId,
      conversationId,
      messageId: userMessageId,
      userMessageId,
    });
  });

  it("persists and validates the exact source Run span selector", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const sourceConversationId = randomUUID();
    const targetConversationId = randomUUID();
    const sourceRunId = randomUUID();
    const sourceSpanId = randomUUID();
    const createdAt = new Date("2026-09-23T01:00:00.000Z");
    const sealedAt = new Date("2026-09-23T01:01:00.000Z");
    const selectorJson = {
      kind: "codex_turn",
      threadId: "source-thread",
      turnId: "source-turn",
      inputCorrelationRef: "source-message",
    };

    await db.insert(organizations).values({
      id: orgId,
      name: "Source span metadata org",
      urlKey: deriveOrganizationUrlKey("Source span metadata org"),
      issuePrefix: "SSM",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Source span metadata agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values([
      {
        id: sourceConversationId,
        orgId,
        title: "Source chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
      {
        id: targetConversationId,
        orgId,
        title: "Side chat",
        issueCreationMode: "manual_approval",
        planMode: false,
      },
    ]);
    const sourceBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId: sourceConversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const sourceSession = await currentNativeSession(db, sourceBinding);
    await db.update(nativeSegments).set({
      nativeSessionId: "source-thread",
      rootSessionId: "source-thread",
      state: "open",
      providerStateJson: { sessionId: "source-thread" },
      updatedAt: createdAt,
    }).where(eq(nativeSegments.id, sourceSession.segment.id));
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      orgId,
      agentId,
      invocationSource: "chat",
      status: "succeeded",
      chatConversationId: sourceConversationId,
      sessionReuseScope: "explicit",
      sessionIdAfter: "source-thread",
      startedAt: createdAt,
      finishedAt: sealedAt,
    });
    await db.insert(runRuntimeSpans).values({
      id: sourceSpanId,
      orgId,
      runId: sourceRunId,
      bindingId: sourceBinding.id,
      segmentId: sourceSession.segment.id,
      attemptRef: "source-attempt",
      attemptEpoch: 1,
      ownerToken: "source-owner",
      ordinal: 0,
      relation: "primary",
      nativeExecutionRef: "source-turn",
      inputCorrelationRef: "source-message",
      selectorJson,
      state: "sealed",
      completeness: "complete",
      openedAt: createdAt,
      closedAt: sealedAt,
      updatedAt: sealedAt,
    });

    const targetBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId: targetConversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const targetSession = await currentNativeSession(db, targetBinding);
    const targetConversation = {
      id: targetConversationId,
      orgId,
      primaryIssueId: null,
      planMode: false,
    };

    await expect(svc.createRun({
      conversation: targetConversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: targetBinding,
      runtimeSegment: targetSession.segment,
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: { ...selectorJson, turnId: "wrong-turn" },
      inputCorrelationRef: "target-message-invalid",
    })).rejects.toThrow("selectorJson does not match");

    const targetRun = await svc.createRun({
      conversation: targetConversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: targetBinding,
      runtimeSegment: targetSession.segment,
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
      inputCorrelationRef: "target-message",
    });
    expect(targetRun.contextSnapshot).toMatchObject({
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
    });
    const [persistedTarget] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, targetRun.id));
    expect(persistedTarget?.contextSnapshot).toMatchObject({
      sourceRunId,
      sourceSpanId,
      sourceSelectorJson: selectorJson,
    });
  });

  it("binds each chat run to one fenced native span and rejects a late owner", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Native span org",
      urlKey: deriveOrganizationUrlKey("Native span org"),
      issuePrefix: "NSP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Native span agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Native span chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const bindingResults = await Promise.all([
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
      ensureRuntimeBinding(db, {
        orgId,
        conversationId,
        principalScopeRef: "user:operator",
        agentId,
        runtimeType: "codex_local",
      }),
    ]);
    expect(bindingResults[0].id).toBe(bindingResults[1].id);
    const nativeSession = await currentNativeSession(db, bindingResults[0]);
    const conversation = { id: conversationId, orgId, primaryIssueId: null, planMode: false };

    // A stale caller-selected segment must fail closed, not silently resolve
    // whichever segment is currently on the conversation binding.
    await expect(svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: { ...nativeSession.segment, id: randomUUID() },
      inputCorrelationRef: "stale-segment-message",
    })).rejects.toThrow();

    const firstRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "message-1",
    });
    expect(firstRun.runtimeSpanId).toBeTruthy();

    const firstResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "codex-thread-1",
      sessionDisplayId: "codex-thread-1",
      sessionParams: { sessionId: "codex-thread-1", cwd: "/tmp/native-span" },
      resultJson: { turnId: "turn-1" },
      nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
    };
    await svc.recordNativeExecutionResult(firstRun.id, firstResult, {
      orgId,
      spanId: firstRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: firstRun.runtimeSpanAttemptEpoch,
    });
    const [sealedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, firstRun.runtimeSpanId!));
    expect(sealedSpan).toMatchObject({ state: "sealed", completeness: "complete", nativeExecutionRef: "turn-1" });
    const [firstSegment] = await db.select().from(nativeSegments).where(eq(nativeSegments.id, sealedSpan!.segmentId));
    expect(firstSegment?.nativeSessionId).toBe("codex-thread-1");

    await svc.finalizeRun(firstRun.id, { status: "succeeded", resultJson: { summary: "first" } });
    const nextSession = await currentNativeSession(db, bindingResults[0]);
    const secondRun = await svc.createRun({
      conversation,
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding: bindingResults[0],
      runtimeSegment: nextSession.segment,
      nativeSessionId: nextSession.sessionId,
      nativeSessionParams: nextSession.sessionParams,
      inputCorrelationRef: "message-2",
    });
    await expect(svc.recordNativeExecutionResult(secondRun.id, firstResult, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: firstRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    const [stillOpen] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, secondRun.runtimeSpanId!));
    expect(stillOpen?.state).toBe("open");
    await svc.recordNativeExecutionResult(secondRun.id, {
      ...firstResult,
      resultJson: { turnId: "turn-2" },
    }, {
      orgId,
      spanId: secondRun.runtimeSpanId,
      ownerToken: secondRun.runtimeSpanOwnerToken,
      attemptEpoch: secondRun.runtimeSpanAttemptEpoch,
    });
    await svc.finalizeRun(secondRun.id, { status: "succeeded", resultJson: { summary: "second" } });
    const bindings = await db.select().from(runtimeBindings).where(eq(runtimeBindings.orgId, orgId));
    expect(bindings).toHaveLength(1);
  });

  it("fails closed for stale owners and stale attempt refs across every Chat Run write", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();

    await db.insert(organizations).values({
      id: orgId,
      name: "Owner fencing org",
      urlKey: deriveOrganizationUrlKey("Owner fencing org"),
      issuePrefix: "OFG",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Owner fencing agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Owner fencing chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });
    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const run = await svc.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "owner-fencing-message",
    });
    const preRecoveryEntry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "before owner recovery" };
    await svc.appendTranscriptEntry(run, preRecoveryEntry, { persistRaw: false, spanId: run.runtimeSpanId });
    const [spanBeforeRecovery] = await db
      .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    const originalSupplementRef = spanBeforeRecovery?.supplementalObjectRef;
    expect(originalSupplementRef).toBeTruthy();
    const staleRun = {
      ...run,
      runtimeAttemptRef: run.runtimeAttemptRef ? { ...run.runtimeAttemptRef } : null,
    };
    const staleResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "stale-owner-thread",
      sessionDisplayId: "stale-owner-thread",
      sessionParams: { sessionId: "stale-owner-thread" },
      resultJson: { turnId: "stale-owner-turn" },
    };

    await db
      .update(heartbeatRuns)
      .set({ executionLeaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(heartbeatRuns.id, run.id));
    const adapter = createHeartbeatUnifiedAgentRunAdapter(db);
    const claimed = await adapter.claimOwner(run.id);
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) throw new Error(`expected recovery claim, got ${claimed.reason}`);

    await expect(svc.beginRuntimeAttempt(staleRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.markRuntimeAttemptWaiting(staleRun, {
      submissionPhase: "indeterminate",
      providerThreadId: "stale-owner-thread",
      error: "late owner",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.finishRuntimeAttempt(staleRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "stale-owner-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(svc.recordNativeExecutionResult(run.id, staleResult, {
      orgId,
      spanId: staleRun.runtimeSpanId,
      ownerToken: staleRun.runtimeSpanOwnerToken!,
      attemptEpoch: staleRun.runtimeSpanAttemptEpoch,
    })).resolves.toBeNull();
    await expect(svc.acceptSubmission(staleRun, { providerTurnId: "stale-owner-turn" })).resolves.toBeNull();
    await expect(svc.markAcceptanceUnknown(staleRun, { reason: "stale owner" })).resolves.toBeNull();
    await expect(svc.sealSpan(staleRun, { completeness: "complete" })).resolves.toBeNull();

    await svc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "stale-owner" } });
    const [stillRunning] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stillRunning?.status).toBe("running");
    expect(stillRunning?.executionOwnerToken).toBe(claimed.value.ownerToken);

    const recoveredSvc = chatAgentRunService(db, { transcriptObjectStore: objectStore });
    const recoveredRun = await recoveredSvc.adoptRecoveredRun(run.id, claimed.value.ownerToken);
    expect(recoveredRun).not.toBeNull();
    if (!recoveredRun) throw new Error("expected recovered Chat run");
    const postRecoveryEntry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "after owner recovery" };
    await recoveredSvc.appendTranscriptEntry(recoveredRun, postRecoveryEntry, {
      persistRaw: false,
      spanId: recoveredRun.runtimeSpanId,
    });
    const [spanAfterRecovery] = await db
      .select({ supplementalObjectRef: runRuntimeSpans.supplementalObjectRef })
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, recoveredRun.runtimeSpanId!));
    expect(spanAfterRecovery?.supplementalObjectRef).toBe(originalSupplementRef);
    const oldOwnerPage = await objectStore.readRange({
      objectRef: originalSupplementRef!,
      orgId,
      runId: run.id,
      spanId: recoveredRun.runtimeSpanId!,
      ownerToken: run.runtimeSpanOwnerToken!,
    });
    expect(oldOwnerPage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining(preRecoveryEntry),
      expect.objectContaining(postRecoveryEntry),
    ]));
    const recoveryReader = createTranscriptObjectReader(objectStore);
    const recoveredPage = await recoveryReader.readRange!({
      readonly: true,
      scope: "run",
      orgId,
      run: { id: run.id },
      span: {
        id: recoveredRun.runtimeSpanId!,
        ownerToken: recoveredRun.runtimeSpanOwnerToken!,
        supplementalObjectRef: originalSupplementRef,
      },
    } as unknown as NativeTranscriptReadInput);
    expect(recoveredPage.entries).toEqual(expect.arrayContaining([
      expect.objectContaining(preRecoveryEntry),
      expect.objectContaining(postRecoveryEntry),
    ]));
    await recoveredSvc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });
    await recoveredSvc.reconcileAcceptance(recoveredRun, {
      state: "rejected",
      reason: "provider confirmed that the first submission was not accepted",
    });
    await recoveredSvc.finishRuntimeAttempt(recoveredRun, {
      status: "failed",
    });
    await recoveredSvc.recordNativeExecutionResult(recoveredRun.id, {
      exitCode: 1, signal: null, timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    }, {
      orgId: recoveredRun.orgId,
      spanId: recoveredRun.runtimeSpanId,
      ownerToken: recoveredRun.runtimeSpanOwnerToken!,
      attemptEpoch: recoveredRun.runtimeSpanAttemptEpoch,
      error: true,
    });
    const staleAttemptRun = {
      ...recoveredRun,
      runtimeAttemptRef: recoveredRun.runtimeAttemptRef ? { ...recoveredRun.runtimeAttemptRef } : null,
    };
    const secondAttemptRef = await recoveredSvc.beginRuntimeAttempt(recoveredRun, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    });
    expect(secondAttemptRef.attemptIndex).toBe(1);
    await expect(recoveredSvc.finishRuntimeAttempt(staleAttemptRun, {
      status: "failed",
      submissionPhase: "accepted",
      providerTurnId: "late-first-attempt-turn",
    })).rejects.toThrow("immutable owner/attempt fence");
    await expect(recoveredSvc.acceptSubmission(staleAttemptRun, { providerTurnId: "late-first-attempt-turn" })).resolves.toBeNull();
    await expect(recoveredSvc.sealSpan(staleAttemptRun, { completeness: "complete" })).resolves.toBeNull();

    const attempts = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts.find((attempt) => attempt.attemptIndex === 1)?.status).toBe("started");
    await recoveredSvc.finishRuntimeAttempt(recoveredRun, {
      status: "succeeded",
      submissionPhase: "accepted",
      providerTurnId: "second-attempt-turn",
    });
    await expect(recoveredSvc.sealSpan(recoveredRun, {
      completeness: "complete",
      visibilityCutoffRef: "second-attempt-turn",
    })).resolves.toMatchObject({ state: "sealed", completeness: "complete" });
    await recoveredSvc.finalizeRun(run.id, { status: "succeeded", resultJson: { source: "current-owner" } });
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(finished?.status).toBe("succeeded");
  });

  it("records an explicit pre-submission finish as rejected and retryable", async () => {
    const run = await createChatRunFixture("Pre-submission");
    await svc.beginRuntimeAttempt(run, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });

    const finished = await svc.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "pre_submission",
      error: "provider call was never made",
    });

    expect(finished).toMatchObject({
      status: "failed",
      submission: {
        state: "rejected",
        phase: "pre_submission",
        retry: "allowed",
        reason: "provider call was never made",
      },
    });
    await expect(svc.getSubmissionState(run.id, run.orgId)).resolves.toBe("rejected");
    await expect(svc.getSubmissionState(run.id, randomUUID())).resolves.toBeNull();
    // Rejection permits retry only after the invocation writer has stopped.
    await expect(svc.beginRuntimeAttempt(run, {
      attemptIndex: 1, fallbackIndex: 1, runtimeType: "codex_local",
      model: "fallback-model", isFallback: true, resumeSource: "pristine_replay",
    })).rejects.toThrow("prior native writer is confirmed quiescent");
    await svc.recordNativeExecutionResult(run.id, {
      exitCode: 1, signal: null, timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    }, {
      orgId: run.orgId,
      spanId: run.runtimeSpanId,
      ownerToken: run.runtimeSpanOwnerToken!,
      attemptEpoch: run.runtimeSpanAttemptEpoch,
      error: true,
    });
    await expect(svc.beginRuntimeAttempt(run, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    })).resolves.toMatchObject({ attemptIndex: 1 });
  });

  it("keeps acceptance-unknown Chat attempts fenced from duplicate retries", async () => {
    const run = await createChatRunFixture("Acceptance unknown");
    await svc.beginRuntimeAttempt(run, {
      attemptIndex: 0,
      fallbackIndex: null,
      runtimeType: "codex_local",
      model: null,
      isFallback: false,
      resumeSource: "fresh",
    });

    const finished = await svc.finishRuntimeAttempt(run, {
      status: "failed",
      submissionPhase: "indeterminate",
      providerThreadId: "provider-thread-unknown",
      error: "connection closed after provider submission",
    });

    expect(finished).toMatchObject({
      status: "failed",
      submission: {
        state: "acceptance_unknown",
        phase: "indeterminate",
        retry: "blocked_until_reconciled",
        providerThreadId: "provider-thread-unknown",
      },
    });
    await expect(svc.getSubmissionState(run.id, run.orgId)).resolves.toBe("acceptance_unknown");
    await expect(svc.beginRuntimeAttempt(run, {
      attemptIndex: 1,
      fallbackIndex: 1,
      runtimeType: "codex_local",
      model: "fallback-model",
      isFallback: true,
      resumeSource: "pristine_replay",
    })).rejects.toThrow("cannot create a retry attempt before reconciling provider acceptance");
    const attempts = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, run.id));
    expect(attempts).toHaveLength(1);
  });

  it("keeps the runtime terminal outcome when supplement sealing fails", async () => {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const conversationId = randomUUID();
    await db.insert(organizations).values({
      id: orgId,
      name: "Supplement seal failure org",
      urlKey: deriveOrganizationUrlKey("Supplement seal failure org"),
      issuePrefix: "SSF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "Supplement seal failure agent",
      role: "engineer",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
    });
    await db.insert(chatConversations).values({
      id: conversationId,
      orgId,
      title: "Supplement seal failure chat",
      issueCreationMode: "manual_approval",
      planMode: false,
    });

    const runtimeBinding = await ensureRuntimeBinding(db, {
      orgId,
      conversationId,
      principalScopeRef: "user:operator",
      agentId,
      runtimeType: "codex_local",
    });
    const nativeSession = await currentNativeSession(db, runtimeBinding);
    const failingStore: TranscriptObjectStore = {
      ...objectStore,
      finalize: async () => {
        throw new Error("simulated transcript seal failure");
      },
    };
    const failingSvc = chatAgentRunService(db, { transcriptObjectStore: failingStore });
    const run = await failingSvc.createRun({
      conversation: { id: conversationId, orgId, primaryIssueId: null, planMode: false },
      agentId,
      triggerDetail: "chat_assistant_reply",
      linkedIssueIds: [],
      linkedProjectId: null,
      runtimeBinding,
      runtimeSegment: nativeSession.segment,
      nativeSessionId: nativeSession.sessionId,
      nativeSessionParams: nativeSession.sessionParams,
      inputCorrelationRef: "supplement-seal-failure",
    });
    const entry = { kind: "assistant" as const, ts: new Date().toISOString(), text: "retained evidence" };
    await failingSvc.appendTranscriptEntry(run, entry, { persistRaw: false, spanId: run.runtimeSpanId });
    const terminal = await failingSvc.finalizeRun(run.id, {
      status: "succeeded",
      resultJson: { source: "runtime", retained: true },
    });
    expect(terminal?.status).toBe("succeeded");

    const [persistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(persistedRun).toMatchObject({
      status: "succeeded",
      resultJson: { source: "runtime", retained: true },
    });
    const [span] = await db
      .select()
      .from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.id, run.runtimeSpanId!));
    expect(span?.supplementalObjectRef).toBeTruthy();
    await expect(objectStore.readRange({
      objectRef: span!.supplementalObjectRef!,
      orgId,
      runId: run.id,
      spanId: span!.id,
      ownerToken: run.runtimeSpanOwnerToken!,
    })).resolves.toMatchObject({
      completeness: "partial",
      entries: [entry],
    });
  });
});
