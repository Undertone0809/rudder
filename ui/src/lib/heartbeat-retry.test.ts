// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { retryHeartbeatRun } from "./heartbeat-retry";
import { heartbeatsApi } from "../api/heartbeats";

describe("retryHeartbeatRun", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the dedicated heartbeat retry API with the original run id", async () => {
    const retrySpy = vi.spyOn(heartbeatsApi, "retry").mockResolvedValue({ id: "retry-run-1" } as any);

    await retryHeartbeatRun({ id: "run-1" });

    expect(retrySpy).toHaveBeenCalledWith("run-1");
  });
});
