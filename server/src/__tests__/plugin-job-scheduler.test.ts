import { describe, expect, it, vi } from "vitest";
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

describe("plugin job scheduler run persistence", () => {
  it("records the complete lifecycle of a scheduled job", async () => {
    const nextRunAt = new Date("2026-07-13T20:00:00.000Z");
    const db = makeDb([[
      {
        id: "job-1",
        pluginId: "plugin-1",
        jobKey: "nightly-sync",
        schedule: "0 * * * *",
        status: "active",
        nextRunAt,
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

    expect(jobStore.createRun).toHaveBeenCalledWith({
      jobId: "job-1",
      pluginId: "plugin-1",
      trigger: "schedule",
    });
    expect(jobStore.markRunning).toHaveBeenCalledWith("run-1");
    expect(workerManager.call).toHaveBeenCalledWith(
      "plugin-1",
      "runJob",
      {
        job: {
          jobKey: "nightly-sync",
          runId: "run-1",
          trigger: "schedule",
          scheduledAt: nextRunAt.toISOString(),
        },
      },
      300_000,
    );
    expect(jobStore.completeRun).toHaveBeenCalledWith("run-1", {
      status: "succeeded",
      durationMs: expect.any(Number),
    });
    expect(jobStore.updateRunTimestamps).toHaveBeenCalledWith(
      "job-1",
      expect.any(Date),
      expect.any(Date),
    );
  });

  it("records a failed manual run without leaving the job active", async () => {
    const db = makeDb([[]]);
    const jobStore = {
      getJobById: vi.fn().mockResolvedValue({
        id: "job-2",
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
      call: vi.fn().mockRejectedValue(new Error("worker unavailable")),
    };
    const scheduler = createPluginJobScheduler({
      db: db as never,
      jobStore: jobStore as never,
      workerManager: workerManager as never,
    });

    await expect(scheduler.triggerJob("job-2", "manual")).resolves.toEqual({
      runId: "run-2",
      jobId: "job-2",
    });

    await vi.waitFor(() => {
      expect(jobStore.completeRun).toHaveBeenCalledWith("run-2", {
        status: "failed",
        error: "worker unavailable",
        durationMs: expect.any(Number),
      });
    });
    expect(scheduler.diagnostics().activeJobIds).toEqual([]);
  });
});
