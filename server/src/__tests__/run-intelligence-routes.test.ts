import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";
import { errorHandler } from "../middleware/index.js";

const mockListObservedRuns = vi.hoisted(() => vi.fn());
const mockGetObservedRun = vi.hoisted(() => vi.fn());
const mockGetObservedRunEvents = vi.hoisted(() => vi.fn());
const mockGetObservedRunLog = vi.hoisted(() => vi.fn());
const mockGetObservedRunDetail = vi.hoisted(() => vi.fn());

vi.mock("../services/run-intelligence.js", () => ({
  listObservedRuns: mockListObservedRuns,
  getObservedRun: mockGetObservedRun,
  getObservedRunEvents: mockGetObservedRunEvents,
  getObservedRunLog: mockGetObservedRunLog,
  getObservedRunDetail: mockGetObservedRunDetail,
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds: ["org-1"],
    };
    next();
  });
  app.use("/api", runIntelligenceRoutes({} as never));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListObservedRuns.mockResolvedValue([]);
  mockGetObservedRunEvents.mockResolvedValue([]);
  mockGetObservedRunLog.mockResolvedValue({ content: "" });
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
    langfuse: {
      traceId: "trace-1",
      traceUrl: "http://localhost:3000/project/test/traces/trace-1",
    },
  });
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
    langfuse: null,
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
});

describe("run intelligence routes", () => {
  it("returns Langfuse deep links on list responses", async () => {
    mockListObservedRuns.mockResolvedValue([
      {
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
        langfuse: {
          traceId: "trace-1",
          traceUrl: "http://localhost:3000/project/test/traces/trace-1",
        },
      },
    ]);

    const res = await request(createApp()).get("/api/run-intelligence/orgs/org-1/runs");

    expect(res.status).toBe(200);
    expect(res.body[0]?.langfuse).toEqual({
      traceId: "trace-1",
      traceUrl: "http://localhost:3000/project/test/traces/trace-1",
    });
  });

  it("enforces org access on single-run lookup", async () => {
    mockGetObservedRun.mockResolvedValue({
      run: { id: "run-2", orgId: "org-2" },
      agentName: "Agent",
      orgName: "Other Org",
      issue: null,
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      langfuse: null,
    });

    const res = await request(createApp()).get("/api/run-intelligence/runs/run-2");

    expect(res.status).toBe(403);
  });

  it("returns newest-first clipped transcript rows from server-side run detail", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ maxChars: "20" });

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

  it("filters transcript around a stable error id", async () => {
    const res = await request(createApp())
      .get("/api/run-intelligence/runs/run-1/transcript")
      .query({ aroundError: "step-3", contextTurns: "1", order: "oldest" });

    expect(res.status).toBe(200);
    expect(res.body.rows.map((row: { id: string }) => row.id)).toEqual(["step-1", "step-2", "step-3", "step-4"]);
  });

  it("returns first-class run errors with transcript context commands", async () => {
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
      id: "step-3",
      type: "tool_result",
      output: {
        clipped: true,
      },
      transcriptContext: {
        id: "step-3",
        command: "rudder runs transcript run-1 --around-error step-3",
      },
    });
  });

  it("enforces org access on transcript routes", async () => {
    mockGetObservedRunDetail.mockResolvedValueOnce({
      run: { id: "run-2", orgId: "org-2", status: "failed" },
      agentName: "Agent",
      orgName: "Other Org",
      issue: null,
      bundle: {
        agentRuntimeType: "process",
        agentConfigRevisionId: null,
        agentConfigRevisionCreatedAt: null,
        agentConfigFingerprint: null,
        runtimeConfigFingerprint: null,
      },
      langfuse: null,
      events: [],
      logContent: null,
      logChunks: [],
      transcript: [],
    });

    const res = await request(createApp()).get("/api/run-intelligence/runs/run-2/transcript");

    expect(res.status).toBe(403);
  });
});
