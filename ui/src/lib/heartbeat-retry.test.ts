// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { heartbeatsApi } from "../api/heartbeats";
import { retryHeartbeatRun } from "./heartbeat-retry";

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
