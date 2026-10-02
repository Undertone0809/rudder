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
const mockGetObservedRunDiagnosticDetail = vi.hoisted(() => vi.fn());
const mockGetObservedRunTranscript = vi.hoisted(() => vi.fn());
const mockListNativeForkIntents = vi.hoisted(() => vi.fn());
const mockReadNativeForkIntent = vi.hoisted(() => vi.fn());
const mockNativeForkIntentKey = vi.hoisted(() => vi.fn());
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
  getObservedRunDiagnosticDetail: mockGetObservedRunDiagnosticDetail,
  getObservedRunTranscript: mockGetObservedRunTranscript,
}));

vi.mock("../services/runtime-kernel/native-fork-intent.js", () => ({
  listNativeForkIntents: mockListNativeForkIntents,
  nativeForkIntentKey: mockNativeForkIntentKey,
  readNativeForkIntent: mockReadNativeForkIntent,
  reconcileNativeForkIntentById: mockReconcileNativeForkIntentById,
  NativeForkIntentError: class NativeForkIntentError extends Error {
    code = "intent_conflict";
  },
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: mockLogActivity,
}));

function createExpressApp(actorOverrides: Partial<Express.Request["actor"]> = {}, db: unknown = {}) {
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
  app.use("/api", runIntelligenceRoutes(db as never));
  app.use(errorHandler);
  return app;
}

type RouteReadQuery = {
  from: (...args: unknown[]) => RouteReadQuery;
  innerJoin: (...args: unknown[]) => RouteReadQuery;
  where: (...args: unknown[]) => RouteReadQuery;
  limit: (...args: unknown[]) => Promise<unknown[]>;
};

function createRouteReadDb(rows: unknown[]) {
  let rowIndex = 0;
  return {
    select: vi.fn(() => {
      const row = rows[rowIndex++];
      const query: RouteReadQuery = {
        from: () => query,
        innerJoin: () => query,
        where: () => query,
        limit: async () => row === null || row === undefined ? [] : [row],
      };
      return query;
    }),
  };
}

function runLinkedIntent(runFence: Record<string, unknown> = {
  runId: "run-1",
  spanId: "span-1",
  ownerToken: "old-owner",
  attemptEpoch: 2,
}) {
  return {
    intentId: "intent-1",
    status: "unknown",
    target: { orgId: "org-1", bindingId: "binding-1", segmentId: "segment-1" },
    runFence,
  };
}

function reconcileReadDb(active: unknown = {
  runId: "run-1",
  runStatus: "running",
  ownerToken: "current-owner",
  leaseExpiresAt: new Date(Date.now() + 60_000),
  spanId: "span-1",
  spanOwnerToken: "current-owner",
  attemptEpoch: 4,
  spanState: "open",
}) {
  return createRouteReadDb([
    { segmentId: "segment-1", bindingId: "binding-1", providerStateJson: {} },
    active,
  ]);
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
  mockGetObservedRunDiagnosticDetail.mockImplementation(async () => {
    const detail = await mockGetObservedRunDetail();
    return {
      detail,
      projection: {
        completeness: "complete",
        source: "legacy",
        availability: "available",
        limitReached: null,
        truncatedItems: 0,
        omittedSources: [],
        readFailure: false,
      },
      entryPositions: detail.transcript.map((_: unknown, index: number) => ({
        stepIndex: index + 1,
        turnIndex: 1,
        after: {
          sourceCursor: null,
          itemOffset: index + 1,
          stepOffset: index + 1,
          traceState: { nextTurnIndex: 1, activeTurnIndex: 1 },
        },
      })),
      nextPosition: null,
      revision: "route-test-revision",
    };
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
  mockReadNativeForkIntent.mockReturnValue(null);
  mockNativeForkIntentKey.mockReturnValue("__rudderNativeForkIntent");
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
    const db = reconcileReadDb();
    mockReadNativeForkIntent.mockReturnValue(runLinkedIntent());
    appServer = createExpressApp({ isInstanceAdmin: true }, db).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    const res = await request(createApp())
      .post("/api/run-intelligence/orgs/org-1/native-fork-intents/intent-1/reconcile")
      .send({
        note: "provider lookup returned the child",
        runFence: {
          runId: "caller-run",
          spanId: "caller-span",
          ownerToken: "caller-owner",
          attemptEpoch: 999,
        },
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
      runFence: {
        runId: "run-1",
        spanId: "span-1",
        ownerToken: "current-owner",
        attemptEpoch: 4,
      },
    });
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "runtime.native_fork_reconciled",
      entityType: "native_fork_intent",
      entityId: "intent-1",
    }));
  });

  it.each([
    ["a terminal Run", {
      runId: "run-1",
      runStatus: "succeeded",
      ownerToken: "current-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      spanId: "span-1",
      spanOwnerToken: "current-owner",
      attemptEpoch: 4,
      spanState: "open",
    }],
    ["an expired owner lease", {
      runId: "run-1",
      runStatus: "running",
      ownerToken: "current-owner",
      leaseExpiresAt: new Date(Date.now() - 1),
      spanId: "span-1",
      spanOwnerToken: "current-owner",
      attemptEpoch: 4,
      spanState: "open",
    }],
    ["a mismatched span owner", {
      runId: "run-1",
      runStatus: "running",
      ownerToken: "current-owner",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      spanId: "span-1",
      spanOwnerToken: "stale-owner",
      attemptEpoch: 4,
      spanState: "open",
    }],
    ["a missing active span", null],
  ])("fails closed for %s without reconciling or logging completion", async (_label, active) => {
    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => error ? reject(error) : resolve());
    });
    mockReadNativeForkIntent.mockReturnValue(runLinkedIntent());
    appServer = createExpressApp(
      { isInstanceAdmin: true },
      reconcileReadDb(active),
    ).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    const res = await request(createApp())
      .post("/api/run-intelligence/orgs/org-1/native-fork-intents/intent-1/reconcile")
      .send({
        child: {
          continuity: "native",
          boundary: "child-boundary",
          sourceBoundary: "boundary-1",
          session: { sessionId: "child-session", sessionParams: { sessionId: "child-session" } },
        },
      });

    expect(res.status).toBe(409);
    expect(mockReconcileNativeForkIntentById).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("keeps legacy intent reconciliation compatible without inventing a Run fence", async () => {
    await new Promise<void>((resolve, reject) => {
      appServer.close((error) => error ? reject(error) : resolve());
    });
    mockReadNativeForkIntent.mockReturnValue({ ...runLinkedIntent(), runFence: undefined });
    const db = createRouteReadDb([
      { segmentId: "segment-1", bindingId: "binding-1", providerStateJson: {} },
    ]);
    appServer = createExpressApp({ isInstanceAdmin: true }, db).listen(0, "127.0.0.1");
    await once(appServer, "listening");

    const res = await request(createApp())
      .post("/api/run-intelligence/orgs/org-1/native-fork-intents/intent-1/reconcile")
      .send({
        child: {
          continuity: "native",
          boundary: "child-boundary",
          sourceBoundary: "boundary-1",
          session: { sessionId: "child-session", sessionParams: { sessionId: "child-session" } },
        },
      });

    expect(res.status).toBe(200);
    expect(db.select).toHaveBeenCalledTimes(1);
    const reconcileInput = mockReconcileNativeForkIntentById.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(reconcileInput).not.toHaveProperty("runFence");
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

  it("projects Hermes database transcript items using their canonical fields", async () => {
    const timestamp = "2026-09-24T08:00:00.000Z";
    mockGetObservedRunTranscript.mockResolvedValueOnce({
      orgId: "org-1",
      run: {
        run: { id: "run-1", orgId: "org-1", status: "succeeded" },
        agentName: "Agent",
        orgName: "Org",
        issue: null,
      },
      page: {
        items: [
          {
            id: "hermes:db:session-1:11",
            sequence: 0,
            ordinal: 11,
            runId: "run-1",
            spanId: "span-1",
            sourceEntryId: "11",
            sourceRef: null,
            kind: "hermes:db:user",
            ts: timestamp,
            payload: { provider: "hermes_gateway", row: { role: "user", content: "Question" } },
            visibility: "visible",
            origin: "native",
            text: "Question",
            entry: { role: "user", content: "Question", timestamp },
          },
          {
            id: "hermes:db:session-1:12",
            sequence: 1,
            ordinal: 12,
            runId: "run-1",
            spanId: "span-1",
            sourceEntryId: "12",
            sourceRef: null,
            kind: "hermes:db:assistant",
            ts: timestamp,
            payload: { provider: "hermes_gateway", row: { role: "assistant", content: "Answer" } },
            visibility: "visible",
            origin: "native",
            text: "Answer",
            entry: { role: "assistant", content: "Answer", timestamp },
          },
        ],
        nextCursor: null,
        source: "native",
        revision: "hermes-provider-fixture",
        availability: "available",
        completeness: "complete",
      },
    });

    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ output: "full", order: "oldest" });

    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(2);
    expect(res.body.rows.map((row: { kind: string }) => row.kind)).toEqual(["user", "assistant"]);
    expect(res.body.entries).toMatchObject([
      {
        sourceEntryId: "11",
        entry: { kind: "user", ts: timestamp, text: "Question", sourceEntryId: "11" },
      },
      {
        sourceEntryId: "12",
        entry: { kind: "assistant", ts: timestamp, text: "Answer", sourceEntryId: "12" },
      },
    ]);
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

  it.each(["native", "native_plus_objects", "legacy"])(
    "honors includeOutput=false without losing a large Unicode failure tool payload from %s",
    async (source) => {
      const marker = "UNIQUE_W12_FAILURE_TOOL_6c5e7b8f";
      // Keep the marker outside bounded previews/clipped row output. Only the
      // canonical entry and full derived output should contain this occurrence.
      const content = `${"故障🌊".repeat(16_000)}${marker}\n${"续行🚀".repeat(16_000)}`;
      const result = { kind: "tool_result", ts: "2026-10-02T00:00:02.000Z", toolUseId: "call-1",
        toolName: "exec_command", content, isError: true, sourceEntryId: "tool-failure-1" };
      const entries = [
        { kind: "assistant", ts: "2026-10-02T00:00:00.000Z", text: "Run the check.", sourceEntryId: "assistant-1" },
        { kind: "tool_call", ts: "2026-10-02T00:00:01.000Z", name: "exec_command", input: { cmd: "check" }, sourceEntryId: "call-1" },
        result,
        { kind: "result", ts: "2026-10-02T00:00:02.500Z", text: "failed", isError: true, sourceEntryId: "result-1",
          inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0, subtype: "error", errors: ["check failed"] },
        { kind: "assistant", ts: "2026-10-02T00:00:03.000Z", text: "The check failed.", sourceEntryId: "assistant-2" },
      ];
      mockGetObservedRunTranscript.mockResolvedValue({
        orgId: "org-1",
        run: { run: { id: "run-1", orgId: "org-1", status: "failed" }, agentName: "Agent", orgName: "Org", issue: null },
        page: {
          items: entries.map((entry, index) => ({
            id: entry.sourceEntryId, sourceEntryId: entry.sourceEntryId, runId: "run-1", spanId: "span-1",
            sequence: index, ordinal: index, kind: entry.kind, ts: entry.ts, entry, payload: entry,
            visibility: "visible", origin: source === "legacy" ? "legacy" : source === "native_plus_objects" ? "object" : "native",
          })),
          source, revision: "large-failure-revision", availability: "available", completeness: "complete", nextCursor: null,
        },
      });
      const query = { output: "full", order: "oldest", turnLimit: "1", maxChars: "4000" };
      const withoutOutput = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
        .query({ ...query, includeOutput: "false" });
      const withOutput = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
        .query({ ...query, includeOutput: "true" });
      const markerCount = (text: string) => text.split(marker).length - 1;
      const withoutBytes = Buffer.byteLength(withoutOutput.text);
      const withBytes = Buffer.byteLength(withOutput.text);
      console.info("includeOutput payload bytes", { source, withoutBytes, withBytes,
        withoutMarkers: markerCount(withoutOutput.text), withMarkers: markerCount(withOutput.text) });
      expect(withoutOutput.status).toBe(200);
      expect(withOutput.status).toBe(200);
      expect(withoutOutput.body.entries.every((row: { output: unknown }) => row.output === null)).toBe(true);
      expect(withoutOutput.body.rows.every((row: { output: unknown }) => row.output === null)).toBe(true);
      expect(withoutBytes).toBeLessThan(withBytes - Buffer.byteLength(content));
      expect(markerCount(withoutOutput.text)).toBe(1);
      expect(markerCount(withOutput.text)).toBe(2);
      const canonical = (body: typeof withoutOutput.body) => body.entries.map(({ output: _output, ...row }: { output: unknown }) => row);
      expect(canonical(withoutOutput.body)).toEqual(canonical(withOutput.body));
      expect(withoutOutput.body.entries.find((row: { sourceEntryId: string }) => row.sourceEntryId === result.sourceEntryId)?.entry).toEqual(result);
      expect(withOutput.body.entries.find((row: { sourceEntryId: string }) => row.sourceEntryId === result.sourceEntryId)?.output.text).toBe(content);
      expect(withoutOutput.body).toMatchObject({ source, revision: "large-failure-revision", availability: "available", completeness: "complete" });
      expect(withoutOutput.body.page).toEqual(withOutput.body.page);
      expect(withoutOutput.body.page.hasMore).toBe(true);
      expect(withoutOutput.body.page.nextCursor).toEqual(expect.any(String));
      const nextWithout = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
        .query({ ...query, cursor: withoutOutput.body.page.nextCursor, includeOutput: "false" });
      const nextWith = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
        .query({ ...query, cursor: withOutput.body.page.nextCursor, includeOutput: "true" });
      expect(nextWithout.status).toBe(200);
      expect(nextWith.status).toBe(200);
      expect(canonical(nextWithout.body)).toEqual(canonical(nextWith.body));
      expect(nextWithout.body.page).toEqual(nextWith.body.page);
      expect(nextWithout.body.page.hasMore).toBe(false);
    },
  );

  it.each([
    { output: "full", query: {}, included: true },
    { output: "full", query: { includeOutput: "true" }, included: true },
    { output: "full", query: { includeOutput: "false" }, included: false },
    { output: "full", query: { includeOutputs: "false" }, included: false },
    { output: "full", query: { includeOutputs: "0" }, included: false },
    { output: "full", query: { includeOutputs: "1" }, included: true },
    { output: "full", query: { includeOutput: "unknown" }, included: true },
    { output: "full", query: { includeOutputs: "false", includeOutput: "true" }, included: false },
    { output: "compact", query: {}, included: false },
    { output: "compact", query: { includeOutput: "true" }, included: true },
    { output: "compact", query: { includeOutput: "false" }, included: false },
  ])("preserves output defaults and alias precedence: $output $query", async ({ output, query, included }) => {
    const res = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
      .query({ output, order: "oldest", maxChars: "20", ...query });
    expect(res.status).toBe(200);
    expect(res.body.rows.every((row: { output: unknown }) => (row.output !== null) === included)).toBe(true);
    if (output === "full") {
      expect(res.body.entries.every((row: { output: unknown }) => (row.output !== null) === included)).toBe(true);
      expect(res.body.entries[2].entry).toMatchObject({ kind: "tool_result", content: "ERR".repeat(1000), isError: true });
      if (included) expect(res.body.entries[2].output).toMatchObject({ text: "ERR".repeat(1000), clipped: false });
    } else expect(res.body.entries).toBeUndefined();
  });

  it.each([
    { source: "native", availability: "offline", completeness: "partial" },
    { source: "native_plus_objects", availability: "available", completeness: "partial" },
    { source: "legacy", availability: "available", completeness: "complete" },
  ])("does not change fallback evidence for $source/$availability/$completeness", async (evidence) => {
    const read = mockGetObservedRunTranscript.getMockImplementation()!;
    mockGetObservedRunTranscript.mockImplementation(async (...args: unknown[]) => {
      const result = await read(...args);
      return { ...result, page: { ...result.page, ...evidence } };
    });
    const baseQuery = { output: "full", order: "oldest" };
    const withoutOutput = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
      .query({ ...baseQuery, includeOutput: "false" });
    const withOutput = await request(createApp()).get("/api/run-intelligence/runs/run-1/transcript")
      .query({ ...baseQuery, includeOutput: "true" });
    expect(withoutOutput.status).toBe(200);
    expect(withOutput.status).toBe(200);
    expect(withoutOutput.body).toMatchObject({ ...evidence, revision: withOutput.body.revision, run: { status: "failed" } });
    expect(withoutOutput.body.entries.map((row: { entry: unknown }) => row.entry))
      .toEqual(withOutput.body.entries.map((row: { entry: unknown }) => row.entry));
    expect(withoutOutput.body.page).toEqual(withOutput.body.page);
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
