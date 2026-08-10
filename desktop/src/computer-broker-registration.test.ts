import { describe, expect, it, vi } from "vitest";
import { isDesktopComputerRunActive } from "./computer-broker-registration.js";

const identity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };

describe("Desktop Computer Run status", () => {
  it("accepts only the exact active Run identity", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "run-1",
      orgId: "org-1",
      agentId: "agent-1",
      status: "running",
    }), { status: 200 })) as unknown as typeof fetch;

    await expect(isDesktopComputerRunActive(
      "http://127.0.0.1:3100/api",
      identity,
      fetchImpl,
    )).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3100/api/heartbeat-runs/run-1");
  });

  it("treats missing, terminal, and mismatched Runs as inactive", async () => {
    const missing = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(isDesktopComputerRunActive("http://127.0.0.1:3100/api", identity, missing))
      .resolves.toBe(false);

    for (const value of [
      { ...identity, status: "succeeded" },
      { ...identity, orgId: "org-2", status: "running" },
      { ...identity, agentId: "agent-2", status: "running" },
    ]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: value.runId, ...value }), {
        status: 200,
      })) as unknown as typeof fetch;
      await expect(isDesktopComputerRunActive("http://127.0.0.1:3100/api", identity, fetchImpl))
        .resolves.toBe(false);
    }
  });

  it("keeps sessions when the status check itself fails", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(isDesktopComputerRunActive("http://127.0.0.1:3100/api", identity, fetchImpl))
      .rejects.toThrow("Computer Use run status request failed (503).");
  });
});
