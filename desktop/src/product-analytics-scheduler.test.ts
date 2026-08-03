import { describe, expect, it, vi } from "vitest";
import { createDesktopProductAnalyticsScheduler } from "./product-analytics-scheduler.js";

describe("desktop product analytics scheduler", () => {
  it("coalesces overlapping triggers and stops future work", async () => {
    let release!: () => void;
    const upload = vi.fn(() => new Promise<{ status: "idle"; eventCount: number; errorCode: null }>((resolve) => {
      release = () => resolve({ status: "idle", eventCount: 0, errorCode: null });
    }));
    const scheduler = createDesktopProductAnalyticsScheduler({ upload, intervalMs: 30_000 });
    scheduler.start();
    await Promise.resolve();
    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(upload).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    scheduler.stop();
    expect(scheduler.isRunning()).toBe(false);
  });
});
