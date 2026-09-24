import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";

const mockListObservedRuns = vi.hoisted(() => vi.fn());
const mockListRunSummaries = vi.hoisted(() => vi.fn());
const mockGetObservedRun = vi.hoisted(() => vi.fn());
const mockGetRunSummary = vi.hoisted(() => vi.fn());
const mockGetObservedRunEvents = vi.hoisted(() => vi.fn());
const mockGetObservedRunLog = vi.hoisted(() => vi.fn());
const mockGetObservedRunDetail = vi.hoisted(() => vi.fn());
const mockGetObservedRunTranscript = vi.hoisted(() => vi.fn());
const mockListNativeForkIntents = vi.hoisted(() => vi.fn());
const mockReconcileNativeForkIntentById = vi.hoisted(() => vi.fn());
const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/run-intelligence.js", () => ({
  listObservedRuns: mockListObservedRuns,
  listRunSummaries: mockListRunSummaries,
  getObservedRun: mockGetObservedRun,
  getRunSummary: mockGetRunSummary,
  getObservedRunEvents: mockGetObservedRunEvents,
  getObservedRunLog: mockGetObservedRunLog,
  getObservedRunDetail: mockGetObservedRunDetail,
  getObservedRunTranscript: mockGetObservedRunTranscript,
}));

vi.mock("../services/runtime-kernel/native-fork-intent.js", () => ({
  listNativeForkIntents: mockListNativeForkIntents,
  reconcileNativeForkIntentById: mockReconcileNativeForkIntentById,
  NativeForkIntentError: class NativeForkIntentError extends Error {
    code = "intent_conflict";
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function createExpressApp(actorOverrides: Partial<Express.Request["actor"]> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["org-1"],
      ...actorOverrides,
    };
    next();
  });
  app.use("/api", runIntelligenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

let appServer: Server;

function createApp() {
  return appServer;
}

beforeEach(async () => {
  vi.resetAllMocks();
  mockListObservedRuns.mockResolvedValue([]);
  mockListRunSummaries.mockResolvedValue({
    items: [],
    page: { limit: 50, hasMore: false, nextCursor: null },
  });
  mockGetObservedRunEvents.mockResolvedValue({
    orgId: "org-1",
    response: { items: [], page: { afterSeq: 0, limit: 200, hasMore: false, nextAfterSeq: null } },
  });
  mockGetObservedRunLog.mockResolvedValue({
    orgId: "org-1",
    response: {
      content: "",
      endOffset: 0,
      eof: true,
      page: { offset: 0, limitBytes: 256_000, endOffset: 0, eof: true, nextOffset: null },
    },
  });
  mockGetObservedRun.mockResolvedValue({
    run: { id: "run-1", orgId: "org-1" },
    agentName: "Agent",
    orgName: "Org",
    issue: null,
    bundle: {
      agentRuntimeType: "process",
      agentConfigRevisionId: null,
      agentConfigRevisionCreatedAt: null,
      agentConfigFingerprint: null,
      runtimeConfigFingerprint: null,
    },
  });
  mockGetRunSummary.mockResolvedValue({ id: "run-1", orgId: "org-1", status: "failed" });
  mockGetObservedRunDetail.mockResolvedValue({
    run: {
      id: "run-1",
      orgId: "org-1",
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_error",
      finishedAt: new Date("2026-06-11T00:00:05.000Z"),
      updatedAt: new Date("2026-06-11T00:00:05.000Z"),
    },
    agentName: "Agent",
    orgName: "Org",
    issue: null,
    bundle: {
      agentRuntimeType: "process",
      agentConfigRevisionId: null,
      agentConfigRevisionCreatedAt: null,
      agentConfigFingerprint: null,
      runtimeConfigFingerprint: null,
    },
    events: [],
    logContent: null,
    logChunks: [],
    transcript: [
      { kind: "assistant", ts: "2026-06-11T00:00:01.000Z", text: "I will run it." },
      { kind: "tool_call", ts: "2026-06-11T00:00:02.000Z", name: "exec_command", input: { cmd: "pnpm test" } },
      { kind: "tool_result", ts: "2026-06-11T00:00:03.000Z", toolUseId: "tool-1", toolName: "exec_command", content: "ERR".repeat(1000), isError: true },
      { kind: "result", ts: "2026-06-11T00:00:04.000Z", text: "failed", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, subtype: "error", isError: true, errors: ["boom"] },
    ],
  });
  mockGetObservedRunTranscript.mockImplementation(async (_db: unknown, _runId: string, _scope: unknown, input: { range?: { fromExclusive?: number } | null } = {}) => {
    const transcript = [
      { kind: "assistant", ts: "2026-06-11T00:00:01.000Z", text: "I will run it." },
      { kind: "tool_call", ts: "2026-06-11T00:00:02.000Z", name: "exec_command", input: { cmd: "pnpm test" } },
      { kind: "tool_result", ts: "2026-06-11T00:00:03.000Z", toolUseId: "tool-1", toolName: "exec_command", content: "ERR".repeat(1000), isError: true },
      { kind: "result", ts: "2026-06-11T00:00:04.000Z", text: "failed", inputTokens: 1, outputTokens: 1, cachedTokens: 0, costUsd: 0, subtype: "error", isError: true, errors: ["boom"] },
    ];
    const start = typeof input.range?.fromExclusive === "number" ? input.range.fromExclusive + 1 : 0;
    return {
      orgId: "org-1",
      run: {
        run: { id: "run-1", orgId: "org-1", status: "failed", error: "adapter failed", errorCode: "adapter_error" },
        agentName: "Agent",
        orgName: "Org",
        issue: null,
      },
      page: {
        items: transcript.slice(start).map((entry, index) => ({
          id: `step-${start + index + 1}`,
          sequence: start + index,
          runId: "run-1",
          spanId: null,
          sourceEntryId: `step-${start + index + 1}`,
          sourceRef: null,
          ordinal: start + index,
          kind: entry.kind,
          ts: entry.ts,
          payload: entry,
          visibility: "visible",
          origin: "legacy",
          entry,
        })),
        nextCursor: null,
        source: "legacy",
        revision: "route-test-revision",
        availability: "available",
        completeness: "complete",
      },
    };
  });
  mockListNativeForkIntents.mockResolvedValue([]);
  mockReconcileNativeForkIntentById.mockResolvedValue({
    outcome: { status: "accepted" },
    summary: {
      intentId: "intent-1",
      idempotencyKey: "side-chat:conversation-1",
      status: "accepted",
      source: {
        orgId: "org-1",
        sourceConversationId: "source-conversation-1",
        sourceRunId: "run-1",
        sourceSpanId: "span-1",
        sourceBoundaryRef: "boundary-1",
      },
      target: {
        bindingId: "binding-1",
        segmentId: "segment-1",
        orgId: "org-1",
        bindingEpoch: 0,
        runtimeType: "pi_local",
        hostId: "local",
        profileId: "default",
        workspaceBindingId: null,
        capabilityRevision: "capability-1",
      },
      reconciliation: "resolved",
      reason: null,
      reconciliationNote: "provider lookup returned the child",
      createdAt: "2026-09-23T00:00:00.000Z",
      updatedAt: "2026-09-23T00:01:00.000Z",
      conversationId: "conversation-1",
      segmentState: "open",
      nativeSessionId: "child-session",
    },
  });
  mockLogActivity.mockResolvedValue({ id: "activity-1" });
  appServer = createExpressApp().listen(0, "127.0.0.1");
  await once(appServer, "listening");
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    appServer.close((error) => error ? reject(error) : resolve());
  });
});

describe("run intelligence routes", () => {
  it("keeps native fork intent inspection instance-admin only", async () => {
    const denied = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/native-fork-intents")
      .query({ status: "unknown" });

    expect(denied.status).toBe(403);
    expect(mockListNativeForkIntents).not.toHaveBeenCalled();

    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => error ? reject(error) : resolve());
    });
    appServer = createExpressApp({ isInstanceAdmin: true }).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    mockListNativeForkIntents.mockResolvedValueOnce([{ intentId: "intent-1", status: "unknown" }]);
    const allowed = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/native-fork-intents")
      .query({ status: "unknown", limit: "7" });

    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({
      items: [{ intentId: "intent-1", status: "unknown" }],
      count: 1,
    });
    expect(mockListNativeForkIntents).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      status: "unknown",
      limit: 7,
    });
  });

  it("adopts a provider child idempotently and records an activity entry", async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => error ? reject(error) : resolve());
    });
    appServer = createExpressApp({ isInstanceAdmin: true }).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    const res = await request(createApp())
      .post("/api/run-intelligence/orgs/org-1/native-fork-intents/intent-1/reconcile")
      .send({
        note: "provider lookup returned the child",
        child: {
          continuity: "native",
          boundary: "child-boundary",
          sourceBoundary: "boundary-1",
          session: {
            sessionId: "child-session",
            sessionParams: { sessionId: "child-session", branch: "child" },
          },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "accepted",
      intent: {
        intentId: "intent-1",
        status: "accepted",
        nativeSessionId: "child-session",
      },
    });
    expect(res.body.intent.child).toBeUndefined();
    expect(mockReconcileNativeForkIntentById).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      intentId: "intent-1",
      note: "provider lookup returned the child",
      child: expect.objectContaining({
        continuity: "native",
        boundary: "child-boundary",
        session: expect.objectContaining({ sessionId: "child-session" }),
      }),
    });
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "runtime.native_fork_reconciled",
      entityType: "native_fork_intent",
      entityId: "intent-1",
    }));
  });

  it("rejects an adoption payload that is not a native child", async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => error ? reject(error) : resolve());
    });
    appServer = createExpressApp({ isInstanceAdmin: true }).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    const res = await request(createApp())
      .post("/api/run-intelligence/orgs/org-1/native-fork-intents/intent-1/reconcile")
      .send({ child: { continuity: "context_handoff" } });

    expect(res.status).toBe(400);
    expect(mockReconcileNativeForkIntentById).not.toHaveBeenCalled();
  });

  it("returns bounded summary pages by default", async () => {
    mockListRunSummaries.mockResolvedValue({
      items: [{ id: "run-1", orgId: "org-1", status: "failed" }],
      page: { limit: 50, hasMore: false, nextCursor: null },
    });

    const res = await request(createApp()).get("/api/run-intelligence/orgs/org-1/runs");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      items: [{ id: "run-1", orgId: "org-1" }],
      page: { limit: 50, hasMore: false },
    });
    expect(mockListRunSummaries).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "org-1",
      limit: 50,
      createdBefore: null,
    }));
    expect(mockListObservedRuns).not.toHaveBeenCalled();
  });

  it("preserves the legacy full list behind explicit projection=full", async () => {
    mockListObservedRuns.mockResolvedValue([{ run: { id: "run-1", orgId: "org-1" } }]);

    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({ projection: "full" });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(mockListObservedRuns).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "org-1",
      limit: 200,
      createdBefore: null,
    }));
    expect(mockListRunSummaries).not.toHaveBeenCalled();
  });

  it("returns summary pages with bounded defaults and forwards filters and cursor", async () => {
    mockListRunSummaries.mockResolvedValue({
      items: [{ id: "run-1", orgId: "org-1", outcome: "done" }],
      page: { limit: 100, hasMore: true, nextCursor: "next-page" },
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({
        projection: "summary",
        cursor: "current-page",
        status: "failed",
        agentId: "agent-1",
        runtime: "codex_local",
        issueId: "issue-1",
        goalId: "goal-1",
        usedSkill: "skill-optimizer",
        createdBefore: "2026-07-14T00:30:00.000Z",
        limit: "500",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      items: [{ id: "run-1", orgId: "org-1", outcome: "done" }],
      page: { limit: 100, hasMore: true, nextCursor: "next-page" },
    });
    expect(mockListRunSummaries).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      sideChatOwnerId: "board-user",
      updatedAfter: null,
      runIdPrefix: null,
      agentId: "agent-1",
      status: "failed",
      runtime: "codex_local",
      issueId: "issue-1",
      goalId: "goal-1",
      usedSkill: "skill-optimizer",
      loadedSkill: null,
      createdBefore: new Date("2026-07-14T00:30:00.000Z"),
      cursor: "current-page",
      limit: 100,
    });
    expect(mockListObservedRuns).not.toHaveBeenCalled();
  });

  it("uses a 50 item default for summary projection", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({ projection: "summary" });

    expect(res.status).toBe(200);
    expect(mockListRunSummaries).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      orgId: "org-1",
      cursor: null,
      limit: 50,
    }));
  });

  it("rejects unknown run list projections", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({ projection: "compact" });

    expect(res.status).toBe(400);
    expect(mockListObservedRuns).not.toHaveBeenCalled();
    expect(mockListRunSummaries).not.toHaveBeenCalled();
  });

  it("returns bounded event pages and forwards pagination inputs", async () => {
    mockGetObservedRunEvents.mockResolvedValue({
      orgId: "org-1",
      response: {
        items: [{ id: 12, seq: 12, eventType: "adapter.invoke" }],
        page: { afterSeq: 10, limit: 25, hasMore: true, nextAfterSeq: 12 },
      },
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/events")
      .query({ afterSeq: "10", limit: "25" });

    expect(res.status).toBe(200);
    expect(res.body.page).toEqual({ afterSeq: 10, limit: 25, hasMore: true, nextAfterSeq: 12 });
    expect(mockGetObservedRunEvents).toHaveBeenCalledWith(expect.anything(), "run-1", {
      orgIds: ["org-1"],
      sideChatOwnerId: "board-user",
    }, {
      cursor: null,
      afterSeq: 10,
      limit: 25,
      includePayload: false,
      maxPayloadChars: 1200,
    });
  });

  it("returns bounded log ranges with no-store caching", async () => {
    mockGetObservedRunLog.mockResolvedValue({
      orgId: "org-1",
      response: {
        content: "next bytes",
        endOffset: 112,
        eof: false,
        nextOffset: 112,
        page: { offset: 100, limitBytes: 12, endOffset: 112, eof: false, nextOffset: 112 },
      },
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/log")
      .query({ offset: "100", limitBytes: "12" });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(res.body.page).toEqual({ offset: 100, limitBytes: 12, endOffset: 112, eof: false, nextOffset: 112 });
    expect(mockGetObservedRunLog).toHaveBeenCalledWith(expect.anything(), "run-1", {
      orgIds: ["org-1"],
      sideChatOwnerId: "board-user",
    }, { offset: 100, limitBytes: 12, signal: expect.any(AbortSignal) });
  });

  it("enforces org access on bounded evidence", async () => {
    mockGetObservedRunEvents.mockResolvedValueOnce({
      orgId: "org-2",
      response: { items: [], page: { afterSeq: 0, limit: 200, hasMore: false, nextAfterSeq: null } },
    });

    const res = await request(createApp()).get("/api/run-intelligence/runs/run-2/events");

    expect(res.status).toBe(403);
  });

  it("passes used skill filters to bounded summary queries", async () => {
    mockListRunSummaries.mockResolvedValue({
      items: [{ id: "run-1", orgId: "org-1", skillEvidence: { evidenceType: "used", matchedSkillKey: "skill-optimizer" } }],
      page: { limit: 20, hasMore: false, nextCursor: null },
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({ usedSkill: "skill-optimizer", limit: "20" });

    expect(res.status).toBe(200);
    expect(mockListRunSummaries).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-1",
      sideChatOwnerId: "board-user",
      updatedAfter: null,
      runIdPrefix: null,
      agentId: null,
      status: null,
      runtime: null,
      issueId: null,
      goalId: null,
      usedSkill: "skill-optimizer",
      loadedSkill: null,
      createdBefore: null,
      cursor: null,
      limit: 20,
    });
    expect(res.body.items[0]?.skillEvidence).toMatchObject({
      evidenceType: "used",
      matchedSkillKey: "skill-optimizer",
    });
  });

  it("rejects ambiguous used and loaded skill filters", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/orgs/org-1/runs")
      .query({ usedSkill: "skill-optimizer", loadedSkill: "skill-optimizer" });

    expect(res.status).toBe(400);
    expect(mockListObservedRuns).not.toHaveBeenCalled();
    expect(mockListRunSummaries).not.toHaveBeenCalled();
  });

  it("enforces org access on default single-run summaries", async () => {
    mockGetRunSummary.mockResolvedValue({ id: "run-2", orgId: "org-2", status: "failed" });

    const res = await request(createApp()).get("/api/run-intelligence/runs/run-2");

    expect(res.status).toBe(403);
  });

  it("passes actor org scope to single-run short ID lookups", async () => {
    const res = await request(createApp()).get("/api/run-intelligence/runs/609695f1f90a");

    expect(res.status).toBe(200);
    expect(mockGetRunSummary).toHaveBeenCalledWith(expect.anything(), "609695f1f90a", {
      orgIds: ["org-1"],
      sideChatOwnerId: "board-user",
    });
  });

  it("returns full single-run detail only with explicit projection=full", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/609695f1f90a")
      .query({ projection: "full" });

    expect(res.status).toBe(200);
    expect(mockGetObservedRun).toHaveBeenCalledWith(expect.anything(), "609695f1f90a", {
      orgIds: ["org-1"],
      sideChatOwnerId: "board-user",
    });
    expect(mockGetRunSummary).not.toHaveBeenCalled();
  });

  it("returns newest-first clipped transcript rows from server-side run detail", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ maxChars: "20", includeOutput: "true" });

    expect(res.status).toBe(200);
    expect(res.body.order).toBe("newest");
    expect(res.body.trace).toMatchObject({ turnCount: 1, stepCount: 4 });
    expect(res.body.rows[0]).toMatchObject({
      id: "step-4",
      kind: "result",
      isError: true,
    });
    expect(res.body.rows[1]).toMatchObject({
      id: "step-3",
      output: {
        clipped: true,
        originalLength: 3000,
      },
    });
  });

  it("returns full transcript entries and page metadata when requested", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ output: "full", order: "oldest", turnLimit: "1", maxChars: "20" });

    expect(res.status).toBe(200);
    expect(res.body.output).toBe("full");
    expect(res.body.page).toMatchObject({
      order: "oldest",
      turnLimit: 1,
      hasMore: false,
      nextCursor: null,
    });
    expect(res.body.entries).toHaveLength(4);
    expect(res.body.entries[2]).toMatchObject({
      id: "step-3",
      entry: {
        kind: "tool_result",
        content: "ERR".repeat(1000),
      },
      output: {
        clipped: false,
        originalLength: 3000,
      },
    });
    expect(res.body.transcript).toBeUndefined();
  });

  it("does not duplicate the full transcript for unpaged full output", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ output: "full", order: "oldest" });

    expect(res.status).toBe(200);
    expect(res.body.transcript).toBeUndefined();
    expect(res.body.entries[2]).toMatchObject({
      entry: {
        kind: "tool_result",
        content: "ERR".repeat(1000),
      },
    });
  });

  it("applies stable transcript cursors before rendering rows", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ cursor: "step-2", order: "oldest" });

    expect(res.status).toBe(200);
    expect(res.body.page).toMatchObject({
      cursor: "step-2",
      order: "oldest",
    });
    expect(res.body.rows.map((row: { id: string }) => row.id)).toEqual(["step-3", "step-4"]);
  });

  it("filters transcript around a stable error id", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ aroundError: "step-3", contextTurns: "1", order: "oldest" });

    expect(res.status).toBe(200);
    expect(res.body.rows.map((row: { id: string }) => row.id)).toEqual(["step-1", "step-2", "step-3", "step-4"]);
  });

  it("returns first-class run errors with transcript context commands", async () => {
    mockGetObservedRunDetail.mockResolvedValueOnce({
      run: {
        id: "609695f1-f90a-4b17-be61-4f0c6fe37c42",
        orgId: "org-1",
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_error",
        finishedAt: new Date("2026-06-11T00:00:05.000Z"),
        updatedAt: new Date("2026-06-11T00:00:05.000Z"),
      },
      agentName: "Agent",
      orgName: "Org",
      issue: null,
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      events: [],
      logContent: null,
      logChunks: [],
      transcript: [
        { kind: "tool_result", ts: "2026-06-11T00:00:03.000Z", toolUseId: "tool-1", toolName: "exec_command", content: "ERR".repeat(1000), isError: true },
      ],
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/errors")
      .query({ maxChars: "25" });

    expect(res.status).toBe(200);
    expect(res.body.errors[0]).toMatchObject({
      id: "run-error",
      type: "runtime",
      summary: "adapter_error",
    });
    expect(res.body.errors[1]).toMatchObject({
      id: "step-1",
      type: "tool_result",
      output: {
        clipped: true,
      },
      transcriptContext: {
        id: "step-1",
      command: "rudder runs transcript run_609695f1 --around-error step-1",
      },
    });
  });

  it("does not repeat the run-level error after an error cursor", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/errors")
      .query({ cursor: "step-3" });

    expect(res.status).toBe(200);
    expect(res.body.page.cursor).toBe("step-3");
    expect(res.body.errors.map((error: { id: string }) => error.id)).toEqual(["step-4"]);
  });

  it("enforces org access on transcript routes", async () => {
    mockGetObservedRunTranscript.mockResolvedValueOnce({
      orgId: "org-2",
      run: {
        run: { id: "run-2", orgId: "org-2", status: "failed" },
        agentName: "Agent",
        orgName: "Other Org",
        issue: null,
      },
      page: {
        items: [],
        nextCursor: null,
        source: "legacy",
        revision: "org-2-revision",
        availability: "available",
        completeness: "complete",
      },
    });

    const res = await request(createApp()).get("/api/run-intelligence/runs/run-2/transcript");

    expect(res.status).toBe(403);
  });
});
