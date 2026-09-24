import {
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const fakeNativeProvider = vi.hoisted(() => {
  type Fixture = { sessionId: string; turnId: string; rawTranscript: string; decoy: string };
  const fixtures = new Map<string, Fixture>();
  const sessions = new Map<string, Array<{ runId: string; turnId: string; entry: Record<string, unknown> }>>();
  const executedRunIds: string[] = [];
  const readInputs: any[] = [];
  const sessionCodec = {
    deserialize: (raw: unknown) =>
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? raw as Record<string, unknown>
        : null,
    serialize: (params: Record<string, unknown> | null) => params,
    getDisplayId: (params: Record<string, unknown> | null) =>
      typeof params?.sessionId === "string" ? params.sessionId : null,
  };
  const adapter = {
    type: "codex_local",
    sessionCodec,
    supportsLocalAgentJwt: false,
    parseStdoutLine: (line: string, ts: string) => [{ kind: "assistant", ts, text: line }],
    execute: async (context: any) => {
      const fixture = fixtures.get(context.runId);
      if (!fixture) throw new Error(`No fake native fixture for Run ${context.runId}`);
      executedRunIds.push(context.runId);
      const history = sessions.get(fixture.sessionId) ?? [];
      sessions.set(fixture.sessionId, [
        ...history,
        {
          runId: `out-of-scope-${context.runId}`,
          turnId: `prior-${fixture.turnId}`,
          entry: {
            kind: "assistant",
            ts: "2026-09-24T00:00:00.000Z",
            text: fixture.decoy,
          },
        },
        {
          runId: context.runId,
          turnId: fixture.turnId,
          entry: {
            kind: "assistant",
            ts: "2026-09-24T00:00:01.000Z",
            text: fixture.rawTranscript,
          },
        },
      ]);
      await context.onLog?.("stdout", `${fixture.rawTranscript}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: fixture.sessionId,
        sessionDisplayId: fixture.sessionId,
        sessionParams: { sessionId: fixture.sessionId },
        providerThreadId: fixture.sessionId,
        providerTurnId: fixture.turnId,
        summary: "bounded fake provider summary",
        resultJson: {
          summary: "bounded fake provider summary",
          stdout: fixture.rawTranscript,
          stderr: fixture.rawTranscript,
          output: fixture.rawTranscript,
          transcript: [{ kind: "assistant", ts: "2026-09-24T00:00:01.000Z", text: fixture.rawTranscript }],
          events: [{ eventType: "transcript.entry", payload: { text: fixture.rawTranscript } }],
        },
      };
    },
  };

  return {
    fixtures,
    sessions,
    executedRunIds,
    readInputs,
    adapter,
    reset() {
      fixtures.clear();
      sessions.clear();
      executedRunIds.length = 0;
      readInputs.length = 0;
    },
    register(runId: string, fixture: Fixture) {
      fixtures.set(runId, fixture);
    },
    async readRange(input: any) {
      readInputs.push(input);
      const selector = input.selector;
      if (selector?.kind !== "codex_turn" || !selector.threadId || !selector.turnId || !selector.runId) {
        return { items: [], revision: "fake-native-invalid-selector", availability: "missing", completeness: "unknown" };
      }
      const entries = (sessions.get(selector.threadId) ?? [])
        .filter((candidate) => candidate.runId === selector.runId && candidate.turnId === selector.turnId)
        .map((candidate) => candidate.entry);
      return {
        items: entries,
        revision: `fake-native:${selector.turnId}`,
        source: "native",
        availability: "available",
        completeness: "complete",
      };
    },
  };
});

const fakeTerminalEffect = vi.hoisted(() => {
  type Gate = {
    entered: Promise<void>;
    markEntered: () => void;
    blocked: Promise<void>;
    release: () => void;
  };
  let nextGate: Gate | null = null;
  return {
    arm() {
      let markEntered!: () => void;
      let release!: () => void;
      const gate: Gate = {
        entered: new Promise<void>((resolve) => { markEntered = resolve; }),
        markEntered: () => markEntered(),
        blocked: new Promise<void>((resolve) => { release = resolve; }),
        release: () => release(),
      };
      nextGate = gate;
      return { entered: gate.entered, release: gate.release };
    },
    async publish() {
      const gate = nextGate;
      if (!gate) return null;
      nextGate = null;
      gate.markEntered();
      await gate.blocked;
      return null;
    },
    releasePending() {
      nextGate?.release();
      nextGate = null;
    },
  };
});

const mockBudgetService = vi.hoisted(() => ({
  getInvocationBlock: vi.fn(),
}));

vi.mock("../automation-chat-output.js", () => ({
  publishAutomationRunOutputToChat: (..._args: unknown[]) => fakeTerminalEffect.publish(),
}));

vi.mock("../budgets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../budgets.js")>();
  return { ...actual, budgetService: () => mockBudgetService };
});

vi.mock("../../agent-runtimes/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent-runtimes/index.js")>();
  const evidence = {
    status: "supported" as const,
    reason: "W12 fake provider reads exact accepted turns",
    transport: "w12-fake-native",
    profileBound: true,
    profileRequired: true,
  };
  return {
    ...actual,
    getServerAdapter: vi.fn(() => fakeNativeProvider.adapter),
    findServerAdapter: vi.fn(() => fakeNativeProvider.adapter),
    createProfileBoundRuntimeProviderCapabilityResolverFromConfig: vi.fn(() => (
      runtimeType: string,
      binding: Record<string, unknown> | null,
    ) => ({
      adapter: {
        runtimeType,
        transcript: {
          evidence,
          readRange: async ({ readerInput }: { readerInput: unknown }) => fakeNativeProvider.readRange(readerInput),
        },
      },
      binding,
      profileResolved: Boolean(binding),
    })),
    runningProcesses: new Map(),
  };
});

import { heartbeatService } from "../heartbeat.js";
import { createTranscriptReader } from "./transcript-reader.js";

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
        server.close(() => reject(new Error("Failed to allocate W12 PostgreSQL port")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startDisposablePostgres(databaseDir: string) {
  const mod = await import("embedded-postgres");
  const EmbeddedPostgres = mod.default as EmbeddedPostgresCtor;
  const port = await getAvailablePort();
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
  const adminConnectionString = `postgres://rudder:rudder@127.0.0.1:${port}/postgres`;
  await ensurePostgresDatabase(adminConnectionString, "rudder");
  const connectionString = `postgres://rudder:rudder@127.0.0.1:${port}/rudder`;
  await applyPendingMigrations(connectionString);
  return { instance, connectionString };
}

async function waitForCondition(check: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the W12 heartbeat Run");
}

async function filesBelow(directory: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof fsp.readdir>>;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  }));
  return nested.flat();
}

async function readAllFiles(directory: string): Promise<string> {
  const files = await filesBelow(directory);
  return (await Promise.all(files.map((file) => fsp.readFile(file, "utf8")))).join("\n");
}

describe("heartbeat native transcript retention integration", () => {
  let db!: ReturnType<typeof createDb>;
  let instance: EmbeddedPostgresInstance | null = null;
  let testRoot = "";
  let runLogRoot = "";
  let transcriptObjectRoot = "";
  let originalEnvironment: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["RUDDER_HOME", "RUN_LOG_BASE_PATH", "RUDDER_TRANSCRIPT_OBJECT_BASE_PATH"]) {
      originalEnvironment[key] = process.env[key];
    }
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rudder-w12-transcript-retention-"));
    runLogRoot = path.join(testRoot, "run-logs");
    transcriptObjectRoot = path.join(testRoot, "transcript-objects");
    process.env.RUDDER_HOME = path.join(testRoot, "rudder-home");
    process.env.RUN_LOG_BASE_PATH = runLogRoot;
    process.env.RUDDER_TRANSCRIPT_OBJECT_BASE_PATH = transcriptObjectRoot;
    fs.mkdirSync(path.join(testRoot, "postgres"), { recursive: true });
    const started = await startDisposablePostgres(path.join(testRoot, "postgres"));
    instance = started.instance;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    fakeNativeProvider.reset();
    fakeTerminalEffect.releasePending();
    if (!db) return;
    await db.delete(heartbeatRunEvents);
    await db.delete(runRuntimeSpans);
    await db.delete(heartbeatRunAttempts);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(organizations);
  });

  afterAll(async () => {
    fakeTerminalEffect.releasePending();
    await instance?.stop();
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (testRoot) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  async function seedAgent() {
    const orgId = randomUUID();
    const agentId = randomUUID();
    const orgName = `W12 transcript retention ${orgId}`;
    await db.insert(organizations).values({
      id: orgId,
      name: orgName,
      urlKey: deriveOrganizationUrlKey(orgName),
      issuePrefix: `W${orgId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      orgId,
      name: "W12 native transcript test agent",
      role: "engineer",
      status: "active",
      agentRuntimeType: "codex_local",
      agentRuntimeConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { orgId, agentId };
  }

  async function queueRun(agentId: string) {
    const run = await heartbeatService(db).wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "w12_transcript_retention",
      contextSnapshot: {},
      startImmediately: false,
    });
    if (!run) throw new Error("Expected a queued W12 Run");
    const context = run.contextSnapshot as Record<string, any>;
    const admission = context.unifiedAgentRun as Record<string, unknown> | undefined;
    const bindingId = admission?.runtimeBindingId;
    const segmentId = admission?.runtimeSegmentId;
    if (typeof bindingId !== "string" || typeof segmentId !== "string") {
      throw new Error("Queued heartbeat Run is missing its native binding and segment identity");
    }
    return { run, bindingId, segmentId };
  }

  async function waitForTerminalEffectsPending(runId: string) {
    await waitForCondition(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return Boolean(run && run.status === "succeeded" && run.terminalEffectsPending);
    });
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0]!);
  }

  async function waitForTerminalEffectsComplete(runId: string) {
    await waitForCondition(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return Boolean(run && run.status === "succeeded" && !run.terminalEffectsPending);
    });
  }

  it("omits duplicate raw evidence for an accepted native Run and keeps it on legacy fallback", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    const { orgId, agentId } = await seedAgent();
    const sessionId = `w12-native-session-${randomUUID()}`;
    const native = await queueRun(agentId);
    const nativeToken = `W12_NATIVE_RAW_${randomUUID()}`;
    const nativeRaw = `${nativeToken}::${"native transcript payload ".repeat(1_750)}`;
    const nativeTurnId = `turn-${native.run.id}`;
    fakeNativeProvider.register(native.run.id, {
      sessionId,
      turnId: nativeTurnId,
      rawTranscript: nativeRaw,
      decoy: `OUT_OF_SCOPE_${randomUUID()}`,
    });
    await db.update(nativeSegments)
      .set({ nativeSessionId: sessionId, rootSessionId: sessionId, state: "open" })
      .where(eq(nativeSegments.id, native.segmentId));

    const nativeTerminalGate = fakeTerminalEffect.arm();
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await nativeTerminalGate.entered;

      const nativeRun = await waitForTerminalEffectsPending(native.run.id);
      const [binding] = await db.select().from(runtimeBindings).where(eq(runtimeBindings.id, native.bindingId));
      const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
      const attempts = await db.select().from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, native.run.id));
      const events = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, native.run.id));

      expect(binding?.continuity).toBe("native");
      expect(nativeRun.resultJson).toMatchObject({
        retention: {
          transcriptSource: "native",
          rawTranscriptPersisted: false,
          rawTranscriptEventPersisted: false,
          rawLogPersisted: false,
          rawResultPersisted: false,
        },
      });
      expect(nativeRun).toMatchObject({ status: "succeeded", logRef: null, logStore: null });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        submissionPhase: "accepted",
        providerThreadId: sessionId,
        providerTurnId: nativeTurnId,
      });
      expect(span?.selectorJson).toMatchObject({
        kind: "codex_turn",
        threadId: sessionId,
        turnId: nativeTurnId,
        runId: native.run.id,
      });
      expect(nativeRun.terminalEffectsJson).toMatchObject({
        automation: { transcript: [], transcriptSource: "native" },
      });

      const sqlEvidence = JSON.stringify({ run: nativeRun, attempts, events, span });
      expect(sqlEvidence).not.toContain(nativeRaw);
      expect(await filesBelow(runLogRoot)).toEqual([]);
      expect(await filesBelow(path.join(transcriptObjectRoot, "transcript-objects"))).toEqual([]);

      const readerInputs: any[] = [];
      const transcriptReader = createTranscriptReader(db, {
        nativeReader: {
          readRange: async (input) => {
            readerInputs.push(input);
            return fakeNativeProvider.readRange(input);
          },
        },
      });
      const page = await transcriptReader.readRun({
        orgId,
        runId: native.run.id,
        spanId: span!.id,
        principal: { orgId, principalScopeRef: `org:${orgId}`, authorized: true },
      });
      expect(page).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
      expect(page.items.map((item) => item.text)).toEqual([nativeRaw]);
      expect(page.items.map((item) => item.text)).not.toContain(`OUT_OF_SCOPE_${randomUUID()}`);
      expect(readerInputs).toHaveLength(1);
      expect(readerInputs[0]).toMatchObject({
        readonly: true,
        scope: "run",
        orgId,
        run: { id: native.run.id },
        span: { id: span!.id },
        selector: { kind: "codex_turn", threadId: sessionId, turnId: nativeTurnId, runId: native.run.id },
      });
    } finally {
      nativeTerminalGate.release();
    }
    await waitForTerminalEffectsComplete(native.run.id);

    const legacy = await queueRun(agentId);
    const legacyToken = `W12_LEGACY_RAW_${randomUUID()}`;
    const legacyRaw = `${legacyToken}::${"legacy transcript payload ".repeat(1_750)}`;
    const legacyTurnId = `turn-${legacy.run.id}`;
    fakeNativeProvider.register(legacy.run.id, {
      sessionId,
      turnId: legacyTurnId,
      rawTranscript: legacyRaw,
      decoy: `OUT_OF_SCOPE_${randomUUID()}`,
    });
    const [legacySegmentBefore] = await db.select().from(nativeSegments)
      .where(eq(nativeSegments.id, legacy.segmentId));
    expect(legacySegmentBefore?.nativeSessionId).toBeNull();

    const legacyTerminalGate = fakeTerminalEffect.arm();
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(legacy.run.id));
      await legacyTerminalGate.entered;
      const legacyRun = await waitForTerminalEffectsPending(legacy.run.id);
      expect(legacyRun.resultJson).toMatchObject({
        stdout: legacyRaw,
        stderr: legacyRaw,
        output: legacyRaw,
        transcript: [{ text: legacyRaw }],
        events: [{ payload: { text: legacyRaw } }],
        retention: { transcriptSource: "legacy" },
      });
      expect(legacyRun.logRef).toEqual(expect.any(String));
      expect((legacyRun.terminalEffectsJson as any).automation).toMatchObject({
        transcriptSource: "legacy",
        transcript: [{ kind: "assistant", text: legacyRaw }],
      });
      expect(await readAllFiles(runLogRoot)).toContain(legacyRaw);
    } finally {
      legacyTerminalGate.release();
    }
    await waitForTerminalEffectsComplete(legacy.run.id);
  }, 60_000);
});
