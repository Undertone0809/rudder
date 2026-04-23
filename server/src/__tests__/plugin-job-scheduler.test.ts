import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWithExecutionObservation = vi.hoisted(() => vi.fn(async (_context, _input, fn) => fn(null)));
const mockObserveExecutionEvent = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock("../langfuse.js", () => ({
  withExecutionObservation: mockWithExecutionObservation,
  observeExecutionEvent: mockObserveExecutionEvent,
}));

import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";

function makeDb(results: unknown[]) {
  const where = vi.fn();
  for (const result of results) {
    where.mockResolvedValueOnce(result);
  }
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where,
      }),
    }),
  };
}

describe("plugin job scheduler langfuse instrumentation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("wraps scheduled runs in a root Langfuse observation", async () => {
    const db = makeDb([[
      {
        id: "job-1",
        pluginId: "plugin-1",
        jobKey: "nightly-sync",
        schedule: "0 * * * *",
        status: "active",
        nextRunAt: new Date("2026-04-12T00:00:00.000Z"),
      },
    ]]);
    const jobStore = {
      createRun: vi.fn().mockResolvedValue({ id: "run-1" }),
      markRunning: vi.fn().mockResolvedValue(undefined),
      completeRun: vi.fn().mockResolvedValue(undefined),
      updateRunTimestamps: vi.fn().mockResolvedValue(undefined),
      listJobs: vi.fn().mockResolvedValue([]),
    };
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: vi.fn().mockResolvedValue(undefined),
    };

    const scheduler = createPluginJobScheduler({
      db: db as never,
      jobStore: jobStore as never,
      workerManager: workerManager as never,
    });

    await scheduler.tick();

    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "plugin_job_run",
        rootExecutionId: "run-1",
        pluginId: "plugin-1",
        trigger: "schedule",
      }),
      expect.objectContaining({
        name: "plugin_job:nightly-sync",
        asType: "agent",
      }),
      expect.any(Function),
    );
    expect(mockObserveExecutionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        rootExecutionId: "run-1",
        status: "dispatching",
      }),
      expect.objectContaining({
        name: "plugin_job.dispatch",
      }),
    );
  });

  it("wraps manual triggers in the same root execution model", async () => {
    const db = makeDb([[]]);
    const jobStore = {
      getJobById: vi.fn().mockResolvedValue({
        id: "job-1",
        pluginId: "plugin-1",
        jobKey: "manual-sync",
        status: "active",
      }),
      createRun: vi.fn().mockResolvedValue({ id: "run-2" }),
      markRunning: vi.fn().mockResolvedValue(undefined),
      completeRun: vi.fn().mockResolvedValue(undefined),
    };
    const workerManager = {
      isRunning: vi.fn().mockReturnValue(true),
      call: vi.fn().mockResolvedValue(undefined),
    };

    const scheduler = createPluginJobScheduler({
      db: db as never,
      jobStore: jobStore as never,
      workerManager: workerManager as never,
    });

    await scheduler.triggerJob("job-1", "manual");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockWithExecutionObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: "plugin_job_run",
        rootExecutionId: "run-2",
        pluginId: "plugin-1",
        trigger: "manual",
      }),
      expect.objectContaining({
        name: "plugin_job:manual-sync",
        asType: "agent",
      }),
      expect.any(Function),
    );
  });
});
