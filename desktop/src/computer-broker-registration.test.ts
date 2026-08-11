import { describe, expect, it, vi } from "vitest";
import {
  createDesktopComputerApiClient,
  isDesktopComputerRunActive,
} from "./computer-broker-registration.js";

const identity = { orgId: "org-1", agentId: "agent-1", runId: "run-1" };

describe("Desktop Computer Run status", () => {
  it("routes every protected Computer lifecycle request through the injected session fetch", async () => {
    const sessionFetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/instance/settings/general")) {
        return new Response(JSON.stringify({ experimentalComputerUseEnabled: true }), { status: 200 });
      }
      if (url.includes("/heartbeat-runs/")) {
        return new Response(JSON.stringify({
          id: "run-1",
          orgId: "org-1",
          agentId: "agent-1",
          status: "running",
        }), { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const client = createDesktopComputerApiClient(sessionFetch);

    await client.readSettings("http://127.0.0.1:3100/api");
    await client.registerBroker("http://127.0.0.1:3100/api", {
      endpoint: "http://127.0.0.1:4142/computer",
      token: "t".repeat(48),
    }, 7, true);
    await client.unregisterBroker("http://127.0.0.1:3100/api", "t".repeat(48));
    await expect(client.isRunActive("http://127.0.0.1:3100/api", identity)).resolves.toBe(true);

    expect(sessionFetch).toHaveBeenCalledTimes(4);
    expect(sessionFetch.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:3100/api/instance/settings/general",
      "http://127.0.0.1:3100/api/instance/computer/broker",
      "http://127.0.0.1:3100/api/instance/computer/broker",
      "http://127.0.0.1:3100/api/heartbeat-runs/run-1",
    ]);
    for (const call of sessionFetch.mock.calls.slice(1, 3)) {
      expect(call[1]).toEqual(expect.objectContaining({
        headers: expect.objectContaining({ origin: "http://127.0.0.1:3100" }),
      }));
    }
  });

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
