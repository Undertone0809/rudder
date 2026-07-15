import type { ObservedRunDetail } from "@rudderhq/run-intelligence-core";
import { describe, expect, it, vi } from "vitest";
import { waitForRunCompletion } from "../commands/benchmark-create-agent.js";
import type { ResolvedClientContext } from "../commands/client/common.js";

function makeRunDetail(status: string): ObservedRunDetail {
  return {
    run: { id: "run-1", status },
  } as ObservedRunDetail;
}

describe("benchmark create-agent run polling", () => {
  it("requests full run detail while polling for a terminal status", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(makeRunDetail("running"))
      .mockResolvedValueOnce(makeRunDetail("succeeded"));
    const api = { get } as unknown as ResolvedClientContext["api"];

    await expect(waitForRunCompletion(api, "run-1", 100, 1)).resolves.toMatchObject({
      detail: { run: { id: "run-1", status: "succeeded" } },
      waitTimedOut: false,
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(
      1,
      "/api/run-intelligence/runs/run-1?projection=full",
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/api/run-intelligence/runs/run-1?projection=full",
    );
  });
});
