import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runIntelligenceRoutes } from "../routes/run-intelligence.js";
import { errorHandler } from "../middleware/index.js";

const mockListObservedRuns = vi.hoisted(() => vi.fn());
const mockGetObservedRun = vi.hoisted(() => vi.fn());
const mockGetObservedRunEvents = vi.hoisted(() => vi.fn());
const mockGetObservedRunLog = vi.hoisted(() => vi.fn());

vi.mock("../services/run-intelligence.js", () => ({
  listObservedRuns: mockListObservedRuns,
  getObservedRun: mockGetObservedRun,
  getObservedRunEvents: mockGetObservedRunEvents,
  getObservedRunLog: mockGetObservedRunLog,
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
});
