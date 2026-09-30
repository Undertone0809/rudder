import {
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  applyPendingMigrations,
  createDb,
  ensurePostgresDatabase,
  heartbeatRunAttempts,
  heartbeatRunEvents,
  heartbeatRuns,
  nativeSegments,
  organizationSkills,
  organizations,
  runRuntimeSpans,
  runtimeBindings,
} from "@rudderhq/db";
import { deriveOrganizationUrlKey } from "@rudderhq/shared";
import { desc, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { releaseTerminalRunRuntimeSpanWriters } from "./native-session.js";
import {
  cleanSealedNativeTranscriptMirrors,
  proveSealedNativeRunTranscript,
} from "./native-transcript-retention.js";
import type { NativeTranscriptReadResult } from "./transcript-reader.js";

const fakeNativeProvider = vi.hoisted(() => {
  type Fixture = {
    sessionId: string;
    turnId: string;
    rawTranscript: string;
    decoy: string;
    readProofFault?: "partial" | "throw";
  };
  const fixtures = new Map<string, Fixture>();
  const sessions = new Map<string, Array<{ runId: string; turnId: string; entry: Record<string, unknown> }>>();
  const executedRunIds: string[] = [];
  const readInputs: any[] = [];
  let profileMode: "supported" | "unsupported" | "unresolved" | "missing_reader" = "supported";
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
        nativeWriterQuiescence: { status: "confirmed", source: "provider_terminal" },
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
    profileMode: () => profileMode,
    setProfileMode(mode: typeof profileMode) {
      profileMode = mode;
    },
    reset() {
      fixtures.clear();
      sessions.clear();
      executedRunIds.length = 0;
      readInputs.length = 0;
      profileMode = "supported";
    },
    register(runId: string, fixture: Fixture) {
      fixtures.set(runId, fixture);
    },
    async readRange(input: any): Promise<NativeTranscriptReadResult> {
      readInputs.push(input);
      const selector = input.selector;
      if (selector?.kind !== "codex_turn" || !selector.threadId || !selector.turnId || !selector.runId) {
        return { items: [], revision: "fake-native-invalid-selector", availability: "missing", completeness: "unknown" };
      }
      const entries = (sessions.get(selector.threadId) ?? [])
        .filter((candidate) => candidate.runId === selector.runId && candidate.turnId === selector.turnId)
        .map((candidate) => candidate.entry);
      const fixture = fixtures.get(selector.runId);
      if (fixture?.readProofFault === "throw") throw new Error("simulated native transcript read failure");
      return {
        items: entries,
        revision: `fake-native:${selector.turnId}`,
        source: "native",
        availability: "available",
        completeness: fixture?.readProofFault === "partial" ? "partial" : "complete",
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
  return {
    ...actual,
    getServerAdapter: vi.fn(() => fakeNativeProvider.adapter),
    findServerAdapter: vi.fn(() => fakeNativeProvider.adapter),
    createProfileBoundRuntimeProviderCapabilityResolverFromConfig: vi.fn((config: { resolutionMode?: string } = {}) => (
      runtimeType: string,
      binding: Record<string, unknown> | null,
    ) => {
      const mode = config.resolutionMode === "historical" ? "supported" : fakeNativeProvider.profileMode();
      const status = mode === "unsupported" ? "unsupported" : mode === "unresolved" ? "unknown" : "supported";
      const profileBound = mode !== "unresolved";
      return {
        adapter: {
          runtimeType,
          transcript: {
            evidence: {
              status,
              reason: "W12 fake provider reads exact accepted turns",
              transport: "w12-fake-native",
              profileBound,
              profileRequired: true,
            },
            ...(mode === "missing_reader" ? {} : {
              readRange: async ({ readerInput }: { readerInput: unknown }) => fakeNativeProvider.readRange(readerInput),
            }),
          },
        },
        binding,
        profileResolved: Boolean(binding) && profileBound,
      };
    }),
    runningProcesses: new Map(),
  };
});

// The historical consumer uses Run Detail's native Reader. Keep this synthetic
// provider behind that current seam as well; invoking the installed Codex CLI
// for its invented fixture thread IDs would not test retention or quiescence.
vi.mock("../run-intelligence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../run-intelligence.js")>();
  return {
    ...actual,
    createHistoricalRunNativeTranscriptReader: vi.fn(() => ({
      readRange: (input: unknown) => fakeNativeProvider.readRange(input),
    })),
  };
});

import { heartbeatService } from "../heartbeat.js";
import { getRunLogStore } from "../run-log-store.js";
import { runRuntimeRetentionMaintenance } from "./runtime-retention.js";
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
  let entries: import("node:fs").Dirent[];
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

function countOccurrences(value: string, marker: string): number {
  return marker ? value.split(marker).length - 1 : 0;
}

type W12BenchmarkPage = {
  source: string;
  availability: string;
  completeness: string;
  items: Array<{ text?: string | null }>;
};

function percentile(values: number[], fraction: number): number {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] ?? 0;
}

async function benchmarkEquivalentReaders(input: {
  native: () => Promise<W12BenchmarkPage>;
  legacy: () => Promise<W12BenchmarkPage>;
  expectedText: string;
}) {
  const warmupsPerArm = 3;
  const measuredReadsPerArm = 20;
  const arms = ["native", "legacy"] as const;
  const samplesMs: Record<(typeof arms)[number], number[]> = { native: [], legacy: [] };
  let peakSampledRssBytes = 0;

  const read = async (arm: (typeof arms)[number], record: boolean) => {
    peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
    const started = process.hrtime.bigint();
    const page = await input[arm]();
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const text = page.items.map((item) => item.text ?? "").join("");
    if (page.source !== arm || page.availability !== "available" || page.completeness !== "complete" || text !== input.expectedText) {
      throw new Error(`${arm} Reader benchmark lost or misclassified the equivalent payload`);
    }
    peakSampledRssBytes = Math.max(peakSampledRssBytes, process.memoryUsage().rss);
    if (record) samplesMs[arm].push(Number(elapsedMs.toFixed(3)));
  };

  for (let index = 0; index < warmupsPerArm; index += 1) {
    const order = index % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) await read(arm, false);
  }
  const rssBeforeBytes = process.memoryUsage().rss;
  peakSampledRssBytes = rssBeforeBytes;
  for (let index = 0; index < measuredReadsPerArm; index += 1) {
    const order = index % 2 === 0 ? arms : [...arms].reverse();
    for (const arm of order) await read(arm, true);
  }
  const rssAfterBytes = process.memoryUsage().rss;

  const summarize = (values: number[]) => ({
    count: values.length,
    p50Ms: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    samplesMs: values,
  });

  return {
    warmupsPerArm,
    measuredReadsPerArm,
    order: "alternating native-first and legacy-first",
    latency: { native: summarize(samplesMs.native), legacy: summarize(samplesMs.legacy) },
    processRss: {
      processRole: "Vitest integration worker running Rudder server-side services",
      metric: "process.memoryUsage().rss",
      sampling: "before and after each Reader call; peak is the maximum boundary sample",
      rssBeforeBytes,
      peakSampledRssBytes,
      rssAfterBytes,
      peakDeltaBytes: peakSampledRssBytes - rssBeforeBytes,
      afterDeltaBytes: rssAfterBytes - rssBeforeBytes,
    },
  };
}

async function writeW12BenchmarkReceipt(outputPath: string, receipt: unknown) {
  const resolvedPath = path.resolve(outputPath);
  if (!resolvedPath.startsWith(`${path.resolve("/tmp")}${path.sep}`)) {
    throw new Error("W12 benchmark receipts must be written under /tmp");
  }
  await fsp.writeFile(resolvedPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
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
    const spans = await db.select().from(runRuntimeSpans);
    for (const span of spans) {
      if (span.writerLeaseReleasedAt) continue;
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, span.runId));
      const [latestAttempt] = await db.select().from(heartbeatRunAttempts).where(eq(heartbeatRunAttempts.runId, span.runId))
        .orderBy(desc(heartbeatRunAttempts.attemptIndex)).limit(1);
      if (!run?.processExitedAt || !latestAttempt || span.attemptId !== latestAttempt.id) {
        throw new Error(`Cannot clean test writer without exact terminal-attempt proof for span ${span.id}`);
      }
      const releasedSpanIds = await releaseTerminalRunRuntimeSpanWriters(db, {
        orgId: span.orgId,
        runId: span.runId,
        spanId: span.id,
        proof: {
          exitCode: null,
          signal: "process-exit-confirmed",
          timedOut: false,
          nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
        },
      });
      if (!releasedSpanIds.includes(span.id)) {
        throw new Error(`Test writer release did not acknowledge exact span ${span.id}`);
      }
    }
    await db.delete(heartbeatRunEvents);
    await db.delete(runRuntimeSpans);
    await db.delete(heartbeatRunAttempts);
    await db.delete(nativeSegments);
    await db.delete(runtimeBindings);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(organizationSkills);
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

  async function waitForNativeRetentionComplete(runId: string) {
    await waitForCondition(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      const retention = (run?.contextSnapshot as Record<string, any> | null)?.nativeTranscriptRetention;
      return retention?.status === "reference_only" || retention?.status === "incomplete" || retention?.status === "cleanup_failed";
    });
  }

  it("releases only the current attempt span when its process-exit proof names that span", async () => {
    const { orgId, agentId } = await seedAgent();
    const queued = await queueRun(agentId);
    const exitedAt = new Date();
    const closedAt = new Date(Date.now() + 1_000);
    const existingAttempts = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, queued.run.id));
    const firstAttemptIndex = existingAttempts.reduce((max, attempt) => Math.max(max, attempt.attemptIndex), -1) + 1;
    const previousAttemptId = randomUUID();
    const currentAttemptId = randomUUID();
    const [previousAttempt, currentAttempt] = await db.insert(heartbeatRunAttempts).values([
      {
        id: previousAttemptId,
        orgId,
        runId: queued.run.id,
        agentId,
        attemptIndex: firstAttemptIndex,
        runtimeType: "codex_local",
        status: "succeeded",
        ownerToken: `previous-attempt-${previousAttemptId}`,
        attemptEpoch: firstAttemptIndex + 1,
        finishedAt: exitedAt,
      },
      {
        id: currentAttemptId,
        orgId,
        runId: queued.run.id,
        agentId,
        attemptIndex: firstAttemptIndex + 1,
        runtimeType: "codex_local",
        status: "timed_out",
        ownerToken: `current-attempt-${currentAttemptId}`,
        attemptEpoch: firstAttemptIndex + 2,
        finishedAt: exitedAt,
      },
    ]).returning();
    expect(previousAttempt?.id).toBe(previousAttemptId);
    expect(currentAttempt?.id).toBe(currentAttemptId);
    await db.update(heartbeatRuns).set({
      status: "timed_out",
      processPid: null,
      processExitedAt: exitedAt,
      terminalEffectsPending: true,
    }).where(eq(heartbeatRuns.id, queued.run.id));
    const [historicalSpan] = await db.insert(runRuntimeSpans).values({
      orgId,
      runId: queued.run.id,
      bindingId: queued.bindingId,
      segmentId: queued.segmentId,
      attemptRef: `legacy-span-${randomUUID()}`,
      attemptId: previousAttempt!.id,
      attemptEpoch: firstAttemptIndex + 1,
      ownerToken: `legacy-owner-${randomUUID()}`,
      ordinal: 0,
      state: "sealed",
      completeness: "unknown",
      closedAt,
      writerLeaseReleasedAt: exitedAt,
    }).returning();
    const [currentSpan] = await db.insert(runRuntimeSpans).values({
      orgId,
      runId: queued.run.id,
      bindingId: queued.bindingId,
      segmentId: queued.segmentId,
      attemptRef: `current-span-${randomUUID()}`,
      attemptId: currentAttempt!.id,
      attemptEpoch: firstAttemptIndex + 2,
      ownerToken: `current-owner-${randomUUID()}`,
      ordinal: 1,
      relation: "continuation",
      state: "sealed",
      completeness: "unknown",
      closedAt,
    }).returning();

    const processExitProof = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      nativeWriterQuiescence: { status: "confirmed", source: "process_exit" },
    } as const;
    await expect(releaseTerminalRunRuntimeSpanWriters(db, {
      orgId,
      runId: queued.run.id,
      proof: processExitProof,
    })).resolves.toEqual([]);

    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, queued.run.id));
    await expect(releaseTerminalRunRuntimeSpanWriters(db, {
      orgId,
      runId: queued.run.id,
      proof: processExitProof,
    })).resolves.toEqual([]);

    await db.update(heartbeatRuns).set({ processPid: 987654321 }).where(eq(heartbeatRuns.id, queued.run.id));
    await expect(releaseTerminalRunRuntimeSpanWriters(db, {
      orgId,
      runId: queued.run.id,
      proof: processExitProof,
    })).resolves.toEqual([]);
    await expect(releaseTerminalRunRuntimeSpanWriters(db, {
      orgId,
      runId: queued.run.id,
      spanId: currentSpan!.id,
      proof: processExitProof,
    })).resolves.toEqual([currentSpan!.id]);
    const [releasedSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, currentSpan!.id));
    const [unchangedHistoricalSpan] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.id, historicalSpan!.id));
    expect(releasedSpan?.writerLeaseReleasedAt).toBeInstanceOf(Date);
    expect(unchangedHistoricalSpan?.writerLeaseReleasedAt).toEqual(exitedAt);
  });

  it("avoids raw mirrors for a verified native profile and retains native read-back authority", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    const { orgId, agentId } = await seedAgent();
    const sessionId = `w12-native-session-${randomUUID()}`;
    const native = await queueRun(agentId);
    const nativeToken = `W12_NATIVE_RAW_${randomUUID()}`;
    // The legacy stdout parser trims terminal whitespace; keep the same byte size with a final period.
    const nativeRaw = `${nativeToken}::${"native transcript payload 你好 🐕 ".repeat(1_399)}native transcript payload 你好 🐕.`;
    const nativePayloadBytes = Buffer.byteLength(nativeRaw, "utf8");
    expect(nativePayloadBytes).toBe(53_253);
    const nativeTurnId = `turn-${native.run.id}`;
    const subagentTurnId = `${nativeTurnId}-subagent`;
    const subagentRaw = `W12_NATIVE_SUBAGENT_RAW_${randomUUID()}`;
    const nativeDecoy = `OUT_OF_SCOPE_${randomUUID()}`;
    fakeNativeProvider.register(native.run.id, {
      sessionId,
      turnId: nativeTurnId,
      rawTranscript: nativeRaw,
      decoy: nativeDecoy,
    });

    const nativeTerminalGate = fakeTerminalEffect.arm();
    let nativeRevision = "";
    let primarySpanId: string | null = null;
    let nativeRunLogBytesWhilePending = 0;
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await nativeTerminalGate.entered;

      const nativeRun = await waitForTerminalEffectsPending(native.run.id);
      const [binding] = await db.select().from(runtimeBindings).where(eq(runtimeBindings.id, native.bindingId));
      const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
      primarySpanId = span!.id;
      const attempts = await db.select().from(heartbeatRunAttempts)
        .where(eq(heartbeatRunAttempts.runId, native.run.id));
      const events = await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, native.run.id));
      const subagentSpanId = randomUUID();
      const closedAtForSubagent = new Date();
      fakeNativeProvider.sessions.set(sessionId, [
        ...(fakeNativeProvider.sessions.get(sessionId) ?? []),
        {
          runId: native.run.id,
          turnId: subagentTurnId,
          entry: {
            kind: "assistant",
            ts: "2026-09-24T00:00:02.000Z",
            text: subagentRaw,
          },
        },
      ]);
      const [subagentSpan] = await db.insert(runRuntimeSpans).values({
        id: subagentSpanId,
        orgId,
        runId: native.run.id,
        bindingId: native.bindingId,
        segmentId: native.segmentId,
        attemptId: attempts[0]!.id,
        attemptRef: `native-subagent-${subagentSpanId}`,
        attemptEpoch: span!.attemptEpoch,
        ownerToken: span!.ownerToken,
        ordinal: span!.ordinal + 1,
        relation: "native_subagent",
        nativeExecutionRef: `execution:${subagentTurnId}`,
        inputCorrelationRef: `input:${subagentTurnId}`,
        selectorJson: {
          kind: "codex_turn",
          threadId: sessionId,
          turnId: subagentTurnId,
          runId: native.run.id,
        },
        state: "sealed",
        completeness: "complete",
        openedAt: new Date(Date.now() - 1_000),
        closedAt: closedAtForSubagent,
        writerLeaseReleasedAt: closedAtForSubagent,
      }).returning();

      expect(binding?.continuity).toBe("native");
      expect(nativeRun.resultJson).toMatchObject({
        summary: "bounded fake provider summary",
        retention: {
          transcriptSource: "native",
          rawTranscriptPersisted: false,
          rawTranscriptEventPersisted: false,
          rawLogPersisted: false,
          rawResultPersisted: false,
        },
      });
      expect(nativeRun).toMatchObject({
        status: "succeeded",
        logRef: null,
        logStore: null,
        stdoutExcerpt: null,
        stderrExcerpt: null,
      });
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
      expect(span?.supplementalObjectRef).toEqual(expect.any(String));
      expect(await readAllFiles(transcriptObjectRoot)).toContain(nativeRaw);
      expect(nativeRun.terminalEffectsJson).toMatchObject({
        automation: { output: "bounded fake provider summary" },
      });
      expect(JSON.stringify(nativeRun.terminalEffectsJson)).not.toContain(nativeRaw);

      const sqlEvidence = JSON.stringify({ run: nativeRun, attempts, events, span, subagentSpan });
      expect(sqlEvidence).not.toContain(nativeRaw);
      expect(countOccurrences(sqlEvidence, nativeToken)).toBe(0);
      expect(sqlEvidence).not.toContain(subagentRaw);
      expect(events.filter((event) => ["transcript.entry", "transcript.run"].includes(event.eventType))).toEqual([]);
      const runLogText = await readAllFiles(runLogRoot);
      expect(runLogText).not.toContain(nativeRaw);
      expect(countOccurrences(runLogText, nativeToken)).toBe(0);
      const nativeRunLogPath = path.join(runLogRoot, orgId, agentId, `${native.run.id}.ndjson`);
      const nativeRunLogStat = await fsp.stat(nativeRunLogPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      nativeRunLogBytesWhilePending = nativeRunLogStat?.size ?? 0;
      expect(nativeRun.logBytes ?? 0).toBe(nativeRunLogBytesWhilePending);
      expect(nativeRunLogBytesWhilePending).toBe(0);

      const nativeSourceEntries = (fakeNativeProvider.sessions.get(sessionId) ?? [])
        .filter((entry) => entry.runId === native.run.id && entry.turnId === nativeTurnId);
      expect(nativeSourceEntries).toHaveLength(1);
      const nativeSourceText = String(nativeSourceEntries[0]?.entry.text ?? "");
      expect(nativeSourceText).toBe(nativeRaw);
      expect(Buffer.byteLength(nativeSourceText, "utf8")).toBe(nativePayloadBytes);
      expect(nativePayloadBytes).toBeGreaterThan(50_000);
      expect(nativePayloadBytes).toBeGreaterThan(nativeRaw.length);
      expect(countOccurrences(nativeSourceText, nativeToken)).toBe(1);

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
      const readerText = page.items.map((item) => item.text ?? "").join("");
      expect(readerText).toBe(nativeRaw);
      expect(Buffer.byteLength(readerText, "utf8")).toBe(nativePayloadBytes);
      expect(countOccurrences(readerText, nativeToken)).toBe(1);
      expect(readerText).not.toContain(nativeDecoy);
      expect(readerInputs).toHaveLength(1);
      expect(readerInputs[0]).toMatchObject({
        readonly: true,
        scope: "run",
        orgId,
        run: { id: native.run.id },
        span: { id: span!.id },
        selector: { kind: "codex_turn", threadId: sessionId, turnId: nativeTurnId, runId: native.run.id },
      });
      expect(page.revision).toEqual(expect.any(String));
      nativeRevision = page.revision;
    } finally {
      nativeTerminalGate.release();
      await waitForTerminalEffectsComplete(native.run.id);
    }

    await waitForNativeRetentionComplete(native.run.id);
    if (!primarySpanId) throw new Error("Expected the native primary span to be recorded");
    const [cleanedNativeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    const cleanedNativeSpans = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
    const cleanedNativeSpan = cleanedNativeSpans.find((candidate) => candidate.id === primarySpanId);
    const cleanedSubagentSpan = cleanedNativeSpans.find((candidate) => candidate.relation === "native_subagent");
    const cleanedNativeEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, native.run.id));
    const cleanedSqlEvidence = JSON.stringify({ run: cleanedNativeRun, spans: cleanedNativeSpans, events: cleanedNativeEvents });
    expect(cleanedNativeRun, JSON.stringify({
      retention: (cleanedNativeRun?.contextSnapshot as Record<string, unknown>)?.nativeTranscriptRetention,
      writers: cleanedNativeSpans.map((span) => ({
        relation: span.relation,
        state: span.state,
        writerReleased: Boolean(span.writerLeaseReleasedAt),
      })),
    })).toMatchObject({
      status: "succeeded",
      logRef: null,
      logStore: null,
      stdoutExcerpt: null,
      stderrExcerpt: null,
      resultJson: { retention: { transcriptSource: "native", rawResultPersisted: false, rawLogPersisted: false } },
      contextSnapshot: { nativeTranscriptRetention: { status: "reference_only", itemCount: 2 } },
    });
    expect(cleanedNativeSpans).toHaveLength(2);
    expect(cleanedSubagentSpan?.id).toEqual(expect.any(String));
    expect(cleanedNativeSpan?.supplementalObjectRef).toBeNull();
    expect(cleanedSubagentSpan?.supplementalObjectRef).toBeNull();
    expect(cleanedNativeEvents.filter((event) => ["transcript.entry", "transcript.run"].includes(event.eventType))).toEqual([]);
    expect(cleanedSqlEvidence).not.toContain(nativeRaw);
    expect(countOccurrences(cleanedSqlEvidence, nativeToken)).toBe(0);
    expect(JSON.stringify(cleanedNativeEvents)).not.toContain(subagentRaw);
    expect(await filesBelow(runLogRoot)).toEqual([]);
    expect(await filesBelow(path.join(transcriptObjectRoot, "transcript-objects"))).toEqual([]);

    const rereadAfterCleanup = createTranscriptReader(db, {
      nativeReader: { readRange: async (input) => await fakeNativeProvider.readRange(input) },
    });
    const rereadPage = await rereadAfterCleanup.readRun({
      orgId,
      runId: native.run.id,
      spanId: cleanedNativeSpan!.id,
      principal: { orgId, principalScopeRef: `org:${orgId}`, authorized: true },
    });
    expect(rereadPage).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(rereadPage.items.map((item) => item.text)).toEqual([nativeRaw]);
    const rereadText = rereadPage.items.map((item) => item.text ?? "").join("");
    expect(Buffer.byteLength(rereadText, "utf8")).toBe(nativePayloadBytes);
    expect(countOccurrences(rereadText, nativeToken)).toBe(1);
    expect(rereadPage.revision).toBe(nativeRevision);

    const rereadSubagentPage = await rereadAfterCleanup.readRun({
      orgId,
      runId: native.run.id,
      spanId: cleanedSubagentSpan!.id,
      principal: { orgId, principalScopeRef: `org:${orgId}`, authorized: true },
    });
    expect(rereadSubagentPage).toMatchObject({ source: "native", availability: "available", completeness: "complete" });
    expect(rereadSubagentPage.items.map((item) => item.text)).toEqual([subagentRaw]);

    const verifiedProof = await proveSealedNativeRunTranscript({
      db,
      reader: rereadAfterCleanup,
      orgId,
      runId: native.run.id,
    });
    expect(verifiedProof.ok).toBe(true);
    if (!verifiedProof.ok) throw new Error(`Expected complete native proof, got ${verifiedProof.reason}`);

    // A terminal primary process does not prove its native child writer has
    // stopped. Neither the initial proof nor a previously obtained proof may
    // authorize cleanup while any selected span retains its writer lease.
    expect(cleanedSubagentSpan?.writerLeaseReleasedAt).toBeInstanceOf(Date);
    await db.update(runRuntimeSpans).set({ writerLeaseReleasedAt: null })
      .where(eq(runRuntimeSpans.id, cleanedSubagentSpan!.id));
    try {
      await expect(proveSealedNativeRunTranscript({
        db,
        reader: rereadAfterCleanup,
        orgId,
        runId: native.run.id,
      })).resolves.toMatchObject({ ok: false, reason: "span_attempt_identity_incomplete" });
      await expect(cleanSealedNativeTranscriptMirrors({
        db,
        proof: verifiedProof.proof,
        runLogStore: {} as any,
        transcriptObjectStore: {} as any,
        readerFactory: () => rereadAfterCleanup,
        retainResultJson: (value) => value ?? {},
      })).resolves.toMatchObject({ cleaned: false, reason: "cleanup_identity_mismatch" });
    } finally {
      await db.update(runRuntimeSpans).set({
        writerLeaseReleasedAt: cleanedSubagentSpan!.writerLeaseReleasedAt,
      }).where(eq(runRuntimeSpans.id, cleanedSubagentSpan!.id));
    }

    const legacy = await queueRun(agentId);
    fakeNativeProvider.setProfileMode("unsupported");
    const legacyToken = nativeToken;
    const legacyRaw = nativeRaw;
    expect(Buffer.byteLength(legacyRaw, "utf8")).toBe(nativePayloadBytes);
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

    let legacyLogBytesWhilePending = 0;
    let legacyLogTextWhilePending = "";
    let readerBenchmark: Awaited<ReturnType<typeof benchmarkEquivalentReaders>> | undefined;
    const legacyOnlyReader = createTranscriptReader(db, { logStore: getRunLogStore() });
    const nativeReadInput = {
      orgId,
      runId: native.run.id,
      spanId: cleanedNativeSpan!.id,
      principal: { orgId, principalScopeRef: `org:${orgId}`, authorized: true },
    };
    const legacyTerminalGate = fakeTerminalEffect.arm();
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(legacy.run.id));
      await legacyTerminalGate.entered;
      const legacyRunPending = await waitForTerminalEffectsPending(legacy.run.id);
      expect(legacyRunPending.resultJson).toMatchObject({
        stdout: legacyRaw,
        stderr: legacyRaw,
        output: legacyRaw,
        transcript: [{ text: legacyRaw }],
        events: [{ payload: { text: legacyRaw } }],
        retention: { transcriptSource: "legacy" },
      });
      expect(legacyRunPending.logRef).toEqual(expect.any(String));
      expect((legacyRunPending.terminalEffectsJson as any).automation).toMatchObject({
        output: "bounded fake provider summary",
      });
      expect(JSON.stringify(legacyRunPending.terminalEffectsJson)).not.toContain(legacyRaw);
      expect(await readAllFiles(runLogRoot)).toContain(legacyRaw);

      const legacyLogRefWhilePending = legacyRunPending.logRef;
      if (!legacyLogRefWhilePending) throw new Error("Expected the pending legacy Run log reference");
      const legacyLogPathWhilePending = path.resolve(runLogRoot, legacyLogRefWhilePending);
      const legacyLogStatWhilePending = await fsp.stat(legacyLogPathWhilePending);
      legacyLogTextWhilePending = await fsp.readFile(legacyLogPathWhilePending, "utf8");
      legacyLogBytesWhilePending = legacyLogStatWhilePending.size;
      expect(legacyLogStatWhilePending.size).toBe(Buffer.byteLength(legacyLogTextWhilePending, "utf8"));
      expect(legacyLogTextWhilePending).toContain(legacyRaw);
      expect(countOccurrences(legacyLogTextWhilePending, legacyToken)).toBe(1);

      const [legacySpanWhilePending] = await db.select().from(runRuntimeSpans)
        .where(eq(runRuntimeSpans.runId, legacy.run.id));
      if (!legacySpanWhilePending) throw new Error("Expected a pending legacy runtime span");
      const legacyReadInput = {
        orgId,
        runId: legacy.run.id,
        spanId: legacySpanWhilePending.id,
        principal: { orgId, principalScopeRef: `org:${orgId}`, authorized: true },
      };
      const legacyReadPage = await legacyOnlyReader.readRun(legacyReadInput);
      expect(legacyReadPage).toMatchObject({ source: "legacy", availability: "available", completeness: "complete" });
      const legacyReadText = legacyReadPage.items.map((item) => item.text ?? "").join("");
      expect(Buffer.byteLength(legacyReadText, "utf8")).toBe(nativePayloadBytes);
      expect(createHash("sha256").update(legacyReadText, "utf8").digest("hex"))
        .toBe(createHash("sha256").update(legacyRaw, "utf8").digest("hex"));

      const receiptPath = process.env.RUDDER_W12_BENCHMARK_RECEIPT;
      if (receiptPath) {
        readerBenchmark = await benchmarkEquivalentReaders({
          native: async () => await rereadAfterCleanup.readRun(nativeReadInput),
          legacy: async () => await legacyOnlyReader.readRun(legacyReadInput),
          expectedText: nativeRaw,
        });
      }
    } finally {
      legacyTerminalGate.release();
      await waitForTerminalEffectsComplete(legacy.run.id);
    }

    const [legacyPersistedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, legacy.run.id));
    const legacyAttempts = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, legacy.run.id));
    const legacyEvents = await db.select().from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, legacy.run.id));
    const legacySpans = await db.select().from(runRuntimeSpans)
      .where(eq(runRuntimeSpans.runId, legacy.run.id));
    const legacySqlEvidence = JSON.stringify({ run: legacyPersistedRun, attempts: legacyAttempts, events: legacyEvents, spans: legacySpans });
    const legacySqlMarkerOccurrences = countOccurrences(legacySqlEvidence, legacyToken);
    expect(legacySqlMarkerOccurrences).toBeGreaterThan(0);
    const [nativeStorage] = await db.select({
      resultJsonBytes: sql<number>`pg_column_size(${heartbeatRuns.resultJson})`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    const [legacyStorage] = await db.select({
      resultJsonBytes: sql<number>`pg_column_size(${heartbeatRuns.resultJson})`,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, legacy.run.id));
    const nativeResultJsonBytes = Number(nativeStorage?.resultJsonBytes ?? 0);
    const legacyResultJsonBytes = Number(legacyStorage?.resultJsonBytes ?? 0);
    expect(nativeResultJsonBytes).toBeGreaterThan(0);
    expect(legacyResultJsonBytes).toBeGreaterThan(nativeResultJsonBytes);

    expect(legacyLogBytesWhilePending).toBeGreaterThan(0);
    const legacyLogRef = legacyPersistedRun?.logRef;
    expect(legacyLogRef).toEqual(expect.any(String));

    const receiptPath = process.env.RUDDER_W12_BENCHMARK_RECEIPT;
    if (receiptPath) {
      if (!readerBenchmark) throw new Error("W12 Reader measurements were not captured while legacy logs existed");
      const receipt = {
        kind: "rudder-w12-transcript-retention-comparison-v1",
        recordedAt: new Date().toISOString(),
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        fixture: {
          payloadUtf8Bytes: nativePayloadBytes,
          payloadSha256: createHash("sha256").update(nativeRaw, "utf8").digest("hex"),
          identicalPayloadAcrossArms: true,
          nativeEvidence: "synthetic fake native readRange hook; no real provider invoked",
        },
        storage: {
          sqlMetric: "pg_column_size(heartbeat_runs.result_json)",
          runLogMetric: "filesystem stat size of the isolated per-Run NDJSON file",
          native: {
            resultJsonBytes: nativeResultJsonBytes,
            runLogBytesWhileTerminalEffectsPending: nativeRunLogBytesWhilePending,
            runLogBytesAfterRetentionCleanup: 0,
            runLogState: "terminal-effects-pending, then after native retention cleanup",
            markerOccurrencesInSqlEvidence: countOccurrences(cleanedSqlEvidence, nativeToken),
            markerOccurrencesInRunLog: 0,
          },
          legacy: {
            resultJsonBytes: legacyResultJsonBytes,
            resultJsonState: "after terminal effects completed",
            runLogBytesWhileTerminalEffectsPending: legacyLogBytesWhilePending,
            runLogState: "terminal-effects-pending; post-terminal file lifetime excluded",
            markerOccurrencesInSqlEvidence: legacySqlMarkerOccurrences,
            markerOccurrencesInRunLogWhilePending: countOccurrences(legacyLogTextWhilePending, legacyToken),
          },
          legacyMinusNative: {
            resultJsonBytes: legacyResultJsonBytes - nativeResultJsonBytes,
            runLogBytesWhileTerminalEffectsPending: legacyLogBytesWhilePending - nativeRunLogBytesWhilePending,
          },
        },
        reader: readerBenchmark,
        evidenceLimits: [
          "legacy post-terminal log-file lifetime is excluded because the isolated fixture did not show stable file presence after completion",
          "native Reader is an in-memory fake, not a real provider or persistent native store",
          "RSS is the Vitest integration worker process, not an HTTP server or packaged Host",
          "browser memory and Host-native RSS are not measured",
        ],
      };
      await writeW12BenchmarkReceipt(receiptPath, receipt);
    }

    await db.delete(runRuntimeSpans).where(eq(runRuntimeSpans.id, cleanedSubagentSpan!.id));
    const cleanupWithMissingSpan = await cleanSealedNativeTranscriptMirrors({
      db,
      proof: verifiedProof.proof,
      runLogStore: {} as any,
      transcriptObjectStore: {} as any,
      readerFactory: () => rereadAfterCleanup,
      retainResultJson: (value) => value ?? {},
    });
    expect(cleanupWithMissingSpan).toMatchObject({ cleaned: false, reason: "cleanup_identity_mismatch" });

    const retainedAttempts = await db.select().from(heartbeatRunAttempts)
      .where(eq(heartbeatRunAttempts.runId, native.run.id));
    expect(retainedAttempts).toHaveLength(1);
    const missingSpanAttemptId = randomUUID();
    await db.insert(heartbeatRunAttempts).values({
      id: missingSpanAttemptId,
      orgId,
      runId: native.run.id,
      agentId,
      attemptIndex: retainedAttempts[0]!.attemptIndex + 1,
      runtimeType: "codex_local",
      status: "succeeded",
      ownerToken: `missing-span-owner-${missingSpanAttemptId}`,
      attemptEpoch: (retainedAttempts[0]!.attemptEpoch ?? 0) + 1,
      finishedAt: new Date(),
    });
    await expect(proveSealedNativeRunTranscript({
      db,
      reader: rereadAfterCleanup,
      orgId,
      runId: native.run.id,
    })).resolves.toMatchObject({ ok: false, reason: "span_attempt_set_mismatch" });

  }, 60_000);

  it("keeps raw fallback for an unresolved profile until the terminal native range is proven", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    fakeNativeProvider.setProfileMode("unresolved");
    const { agentId } = await seedAgent();
    const native = await queueRun(agentId);
    const sessionId = `w12-unresolved-session-${randomUUID()}`;
    const nativeTurnId = `turn-${native.run.id}`;
    const nativeRaw = `W12_UNRESOLVED_PROFILE_${randomUUID()} ${"fallback evidence ".repeat(200)}`;
    fakeNativeProvider.register(native.run.id, {
      sessionId,
      turnId: nativeTurnId,
      rawTranscript: nativeRaw,
      decoy: `OUT_OF_SCOPE_${randomUUID()}`,
    });

    const terminalGate = fakeTerminalEffect.arm();
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await terminalGate.entered;

      const persisted = await waitForTerminalEffectsPending(native.run.id);
      expect(persisted.resultJson).toMatchObject({
        stdout: nativeRaw,
        stderr: nativeRaw,
        output: nativeRaw,
        transcript: [{ text: nativeRaw }],
        retention: { transcriptSource: "legacy" },
      });
      expect(persisted.logRef).toEqual(expect.any(String));
      expect(persisted.stdoutExcerpt).toContain(nativeRaw.slice(0, 100));
      expect(await readAllFiles(runLogRoot)).toContain(nativeRaw);
    } finally {
      terminalGate.release();
      await waitForTerminalEffectsComplete(native.run.id);
    }
    await waitForNativeRetentionComplete(native.run.id);
    const [afterReadBack] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    expect(afterReadBack?.resultJson).toMatchObject({
      retention: { transcriptSource: "native", rawResultPersisted: false },
    });
    expect((afterReadBack?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "reference_only",
      itemCount: 1,
    });
  }, 60_000);

  it("preserves the business result and marks retention incomplete when terminal native proof is partial or fails", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    const { agentId } = await seedAgent();

    for (const readProofFault of ["partial", "throw"] as const) {
      const native = await queueRun(agentId);
      const sessionId = `w12-incomplete-session-${randomUUID()}`;
      const nativeTurnId = `turn-${native.run.id}`;
      const nativeRaw = `W12_${readProofFault.toUpperCase()}_READER_${randomUUID()} ${"recovery evidence ".repeat(200)}`;
      fakeNativeProvider.register(native.run.id, {
        sessionId,
        turnId: nativeTurnId,
        rawTranscript: nativeRaw,
        decoy: `OUT_OF_SCOPE_${randomUUID()}`,
        readProofFault,
      });
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await waitForTerminalEffectsComplete(native.run.id);
      await waitForNativeRetentionComplete(native.run.id);

      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
      const retention = (persisted?.contextSnapshot as Record<string, any> | null)?.nativeTranscriptRetention;
      expect(persisted).toMatchObject({
        status: "succeeded",
        logRef: null,
        logStore: null,
        stdoutExcerpt: null,
        stderrExcerpt: null,
        resultJson: {
          summary: "bounded fake provider summary",
          retention: { transcriptSource: "native", rawResultPersisted: false, rawLogPersisted: false },
        },
      });
      expect(retention).toMatchObject({ status: "incomplete", reason: "native_range_read_incomplete" });
      expect(retention.recovery).toEqual([
        expect.objectContaining({
          kind: "transcript_supplement",
          objectRef: expect.any(String),
          spanId: expect.any(String),
        }),
      ]);
      const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, native.run.id));
      expect(span?.supplementalObjectRef).toEqual(expect.any(String));
      expect(JSON.stringify({ persisted, events, span, recovery: retention })).not.toContain(nativeRaw);
      expect(events.filter((event) => ["transcript.entry", "transcript.run"].includes(event.eventType))).toEqual([]);
      expect(await readAllFiles(transcriptObjectRoot)).toContain(nativeRaw);
      expect(await readAllFiles(runLogRoot)).not.toContain(nativeRaw);
    }
  }, 60_000);

  it("retains the complete Run fallback when run-log staging fails", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    fakeNativeProvider.setProfileMode("unsupported");
    const { orgId, agentId } = await seedAgent();
    const native = await queueRun(agentId);
    const sessionId = `w12-log-failure-session-${randomUUID()}`;
    const nativeTurnId = `turn-${native.run.id}`;
    const nativeRaw = `W12_LOG_STAGE_FAILURE_${randomUUID()} ${"raw fallback ".repeat(200)}`;
    fakeNativeProvider.register(native.run.id, {
      sessionId,
      turnId: nativeTurnId,
      rawTranscript: nativeRaw,
      decoy: `OUT_OF_SCOPE_${randomUUID()}`,
    });
    await db.update(nativeSegments)
      .set({ nativeSessionId: sessionId, rootSessionId: sessionId, state: "open" })
      .where(eq(nativeSegments.id, native.segmentId));

    const store = getRunLogStore();
    const originalStage = store.stageRunRemoval;
    if (!originalStage) throw new Error("Expected the local run-log store to support staged deletion");
    store.stageRunRemoval = async () => { throw new Error("simulated run-log staging failure"); };
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await waitForTerminalEffectsComplete(native.run.id);
      await waitForNativeRetentionComplete(native.run.id);

      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
      const [span] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, native.run.id));
      expect(persisted).toMatchObject({
        status: "succeeded",
        logStore: "local_file",
        logRef: expect.any(String),
        resultJson: { stdout: nativeRaw, transcript: [{ text: nativeRaw }] },
        contextSnapshot: {
          nativeTranscriptRetention: {
            status: "cleanup_failed",
            reason: expect.stringContaining("simulated run-log staging failure"),
          },
        },
      });
      expect(span?.state).toBe("sealed");
      expect(events.filter((event) => ["transcript.entry", "transcript.run"].includes(event.eventType))).toEqual([]);
      expect(await readAllFiles(runLogRoot)).toContain(nativeRaw);
    } finally {
      store.stageRunRemoval = originalStage;
    }
    const stageRetry = await runRuntimeRetentionMaintenance(db, { now: new Date(Date.now() + 2 * 60 * 60 * 1000) });
    expect(stageRetry.nativeTranscriptRecovery).toMatchObject({ attempted: 1, recovered: 1 });
    const [retriedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    expect((retriedRun?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "reference_only",
      recovery: [],
    });
    expect(await readAllFiles(runLogRoot)).not.toContain(nativeRaw);
  }, 60_000);

  it("keeps the staged Run log recoverable and reports a final log purge failure", async () => {
    mockBudgetService.getInvocationBlock.mockResolvedValue(null);
    const { orgId, agentId } = await seedAgent();
    const native = await queueRun(agentId);
    const sessionId = `w12-log-purge-session-${randomUUID()}`;
    const nativeTurnId = `turn-${native.run.id}`;
    const nativeRaw = `W12_LOG_PURGE_FAILURE_${randomUUID()} ${"recovery evidence ".repeat(150)}`;
    fakeNativeProvider.register(native.run.id, {
      sessionId,
      turnId: nativeTurnId,
      rawTranscript: nativeRaw,
      decoy: `OUT_OF_SCOPE_${randomUUID()}`,
    });
    await db.update(nativeSegments)
      .set({ nativeSessionId: sessionId, rootSessionId: sessionId, state: "open" })
      .where(eq(nativeSegments.id, native.segmentId));

    const store = getRunLogStore();
    const originalPurge = store.purgeStagedRunRemoval;
    if (!originalPurge) throw new Error("Expected the local run-log store to support staged deletion");
    let staged: { handle: { logRef: string }; stageId: string; expectedSha256: string } | null = null;
    let supplementStageDirectory: string | null = null;
    store.purgeStagedRunRemoval = async (input) => {
      staged = input;
      const [pending] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
      const recovery = (pending?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention?.recovery;
      expect((pending?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention?.status).toBe("cleanup_pending");
      expect(recovery).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "run_log",
          store: "local_file",
          logRef: input.handle.logRef,
          stageId: input.stageId,
        }),
        expect.objectContaining({ kind: "transcript_object", stageId: expect.any(String) }),
      ]));
      throw new Error("simulated final run-log purge failure");
    };
    const terminalGate = fakeTerminalEffect.arm();
    try {
      await heartbeatService(db).startNextQueuedRunForAgent(agentId);
      await waitForCondition(async () => fakeNativeProvider.executedRunIds.includes(native.run.id));
      await terminalGate.entered;
      await waitForTerminalEffectsPending(native.run.id);
      const retainedFallback = await store.begin({ orgId, agentId, runId: native.run.id });
      await store.append(retainedFallback, {
        stream: "stdout",
        chunk: nativeRaw,
        ts: new Date().toISOString(),
      });
      const fallbackSummary = await store.finalize(retainedFallback);
      await db.update(heartbeatRuns).set({
        logStore: retainedFallback.store,
        logRef: retainedFallback.logRef,
        logBytes: fallbackSummary.bytes,
        logSha256: fallbackSummary.sha256,
        logCompressed: fallbackSummary.compressed,
      }).where(eq(heartbeatRuns.id, native.run.id));
      terminalGate.release();
      await waitForTerminalEffectsComplete(native.run.id);
      await waitForNativeRetentionComplete(native.run.id);

      const [persisted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
      expect(staged).toBeTruthy();
      expect(persisted).toMatchObject({
        status: "succeeded",
        logStore: null,
        logRef: null,
        resultJson: { retention: { transcriptSource: "native", rawResultPersisted: false, rawLogPersisted: false } },
        contextSnapshot: {
          nativeTranscriptRetention: {
            status: "cleanup_failed",
            reason: expect.stringContaining("simulated final run-log purge failure"),
          },
        },
      });
      const recovery = (persisted?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention?.recovery;
      expect(recovery).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "run_log",
          store: "local_file",
          logRef: staged!.handle.logRef,
          stageId: staged!.stageId,
        }),
        expect.objectContaining({ kind: "transcript_object", stageId: expect.any(String) }),
      ]));
      const initialStageDirectory = path.join(
        path.dirname(path.join(runLogRoot, staged!.handle.logRef)),
        `.${path.basename(staged!.handle.logRef)}.retention-${staged!.stageId}`,
      );
      expect(await readAllFiles(initialStageDirectory)).toContain(nativeRaw);
      const supplementStage = recovery.find((entry: any) => entry.kind === "transcript_object");
      supplementStageDirectory = path.join(
        transcriptObjectRoot,
        "transcript-objects",
        `.retention-${supplementStage.objectRef}-${supplementStage.stageId}`,
      );
      expect(await readAllFiles(supplementStageDirectory)).toContain(nativeRaw);
    } finally {
      terminalGate.release();
      store.purgeStagedRunRemoval = originalPurge;
    }

    const [spanBeforeRecovery] = await db.select().from(runRuntimeSpans).where(eq(runRuntimeSpans.runId, native.run.id));
    if (!spanBeforeRecovery) throw new Error("Expected the sealed native span to remain available for recovery proof");
    const recoveryStage = staged as { handle: { logRef: string }; stageId: string; expectedSha256: string } | null;
    if (!recoveryStage) throw new Error("Expected the failed purge to persist its recovery location");
    const stageDirectory = path.join(
      path.dirname(path.join(runLogRoot, recoveryStage.handle.logRef)),
      `.${path.basename(recoveryStage.handle.logRef)}.retention-${recoveryStage.stageId}`,
    );
    const retryBase = Date.now() + 2 * 60 * 60 * 1000;

    await db.update(runRuntimeSpans).set({ ownerToken: `${spanBeforeRecovery.ownerToken}-changed` })
      .where(eq(runRuntimeSpans.id, spanBeforeRecovery.id));
    await runRuntimeRetentionMaintenance(db, { now: new Date(retryBase) });
    expect(await readAllFiles(stageDirectory)).toContain(nativeRaw);
    const [identityRejected] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    expect((identityRejected?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "cleanup_failed",
      reason: expect.stringContaining("span_attempt_identity_incomplete"),
    });

    await db.update(runRuntimeSpans).set({
      ownerToken: spanBeforeRecovery.ownerToken,
      selectorJson: {
        ...(spanBeforeRecovery.selectorJson as Record<string, unknown>),
        turnId: `${nativeTurnId}-changed`,
      },
    }).where(eq(runRuntimeSpans.id, spanBeforeRecovery.id));
    await runRuntimeRetentionMaintenance(db, { now: new Date(retryBase + 2 * 60 * 60 * 1000) });
    expect(await readAllFiles(stageDirectory)).toContain(nativeRaw);
    const [rangeRejected] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    expect((rangeRejected?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "cleanup_failed",
      reason: expect.stringContaining("native_range_read_incomplete"),
    });

    await db.update(runRuntimeSpans).set({ selectorJson: spanBeforeRecovery.selectorJson })
      .where(eq(runRuntimeSpans.id, spanBeforeRecovery.id));
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, native.run.id));
    await runRuntimeRetentionMaintenance(db, { now: new Date(retryBase + 4 * 60 * 60 * 1000) });
    expect(await readAllFiles(stageDirectory)).toContain(nativeRaw);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, native.run.id));
    const maintenance = await runRuntimeRetentionMaintenance(db, { now: new Date(retryBase + 6 * 60 * 60 * 1000) });
    expect(maintenance.nativeTranscriptRecovery).toMatchObject({ attempted: 1, recovered: 1 });
    const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, native.run.id));
    expect((recovered?.contextSnapshot as Record<string, any>)?.nativeTranscriptRetention).toMatchObject({
      status: "reference_only",
      recovery: [],
    });
    expect(await readAllFiles(stageDirectory)).not.toContain(nativeRaw);
    expect(await readAllFiles(runLogRoot)).not.toContain(nativeRaw);
    if (supplementStageDirectory) expect(await filesBelow(supplementStageDirectory)).toEqual([]);
    await originalPurge({
      orgId,
      agentId,
      runId: native.run.id,
      handle: { store: "local_file", logRef: recoveryStage.handle.logRef },
      expectedSha256: recoveryStage.expectedSha256,
      stageId: recoveryStage.stageId,
    });
  }, 60_000);
});
