import type { DesktopProductAnalyticsUploadResult } from "./product-analytics-uploader.js";

export type DesktopProductAnalyticsScheduler = {
  start(): void;
  stop(): void;
  runNow(): Promise<DesktopProductAnalyticsUploadResult | null>;
  isRunning(): boolean;
};

export function createDesktopProductAnalyticsScheduler(input: {
  upload: () => Promise<DesktopProductAnalyticsUploadResult>;
  intervalMs?: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
}): DesktopProductAnalyticsScheduler {
  const intervalMs = Math.max(30_000, input.intervalMs ?? 15 * 60_000);
  const setTimeoutImpl = input.setTimeoutImpl ?? setTimeout;
  const clearTimeoutImpl = input.clearTimeoutImpl ?? clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight: Promise<DesktopProductAnalyticsUploadResult | null> | null = null;

  function schedule() {
    if (!running || timer) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      void runNow().finally(schedule);
    }, intervalMs);
    if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") timer.unref();
  }

  async function runNow() {
    if (inFlight) return inFlight;
    inFlight = input.upload().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  return {
    start() {
      if (running) return;
      running = true;
      void runNow().finally(schedule);
    },
    stop() {
      running = false;
      if (timer) clearTimeoutImpl(timer);
      timer = null;
    },
    runNow,
    isRunning: () => running,
  };
}
