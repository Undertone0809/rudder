import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { runDiagnosticRoutes } from "../routes/run-diagnostics.js";

const mockRunDiagnosticsService = vi.hoisted(() => ({
  list: vi.fn(),
  summary: vi.fn(),
  update: vi.fn(),
  analyzeRun: vi.fn(),
}));
const mockGetObservedRun = vi.hoisted(() => vi.fn());

vi.mock("../services/run-diagnostics.js", () => ({
  runDiagnosticsService: () => mockRunDiagnosticsService,
}));

vi.mock("../services/run-intelligence.js", () => ({
  getObservedRun: mockGetObservedRun,
}));

function createApp(orgIds = ["org-1"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "board-user",
      source: "session",
      isInstanceAdmin: false,
      orgIds,
    };
    next();
  });
  app.use("/api", runDiagnosticRoutes({} as never));
  app.use(errorHandler);
  return app;
}

describe("run diagnostic routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunDiagnosticsService.list.mockResolvedValue([]);
    mockRunDiagnosticsService.summary.mockResolvedValue({
      total: 0,
      open: 0,
      byKind: {},
      bySeverity: {},
    });
    mockRunDiagnosticsService.update.mockResolvedValue({
      id: "finding-1",
      orgId: "org-1",
      status: "resolved",
    });
    mockRunDiagnosticsService.analyzeRun.mockResolvedValue([]);
    mockGetObservedRun.mockResolvedValue({
      run: { id: "run-1", orgId: "org-1" },
    });
  });

  it("lists findings for an allowed organization", async () => {
    const res = await request(createApp()).get("/api/orgs/org-1/run-diagnostics?status=open&limit=10");

    expect(res.status).toBe(200);
    expect(mockRunDiagnosticsService.list).toHaveBeenCalledWith({
      orgId: "org-1",
      status: "open",
      runId: null,
      limit: 10,
    });
  });

  it("rejects findings access across organizations", async () => {
    const res = await request(createApp()).get("/api/orgs/org-2/run-diagnostics");

    expect(res.status).toBe(403);
    expect(mockRunDiagnosticsService.list).not.toHaveBeenCalled();
  });

  it("updates finding status", async () => {
    const res = await request(createApp())
      .patch("/api/orgs/org-1/run-diagnostics/finding-1")
      .send({ status: "resolved", resolutionNote: "Patched skill instructions." });

    expect(res.status).toBe(200);
    expect(mockRunDiagnosticsService.update).toHaveBeenCalledWith("org-1", "finding-1", {
      status: "resolved",
      resolutionNote: "Patched skill instructions.",
    });
  });

  it("recomputes diagnostics only after checking the run organization", async () => {
    const res = await request(createApp()).post("/api/run-intelligence/runs/run-1/diagnostics/recompute").send({});

    expect(res.status).toBe(200);
    expect(mockGetObservedRun).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(mockRunDiagnosticsService.analyzeRun).toHaveBeenCalledWith("run-1");
  });
});
