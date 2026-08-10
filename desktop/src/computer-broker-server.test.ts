import { afterEach, describe, expect, it, vi } from "vitest";
import { startComputerBrokerServer } from "./computer-broker-server.js";

const handles: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
});

describe("Desktop Computer Broker server", () => {
  it("binds loopback and requires its opaque bearer credential", async () => {
    const execute = vi.fn(async () => ({ apps: [] }));
    const handle = await startComputerBrokerServer({ execute, token: "a".repeat(48) });
    handles.push(handle);
    expect(new URL(handle.endpoint).hostname).toBe("127.0.0.1");

    const denied = await fetch(handle.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "list_apps", args: {} }),
    });
    expect(denied.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();

    const allowed = await fetch(handle.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
        action: "list_apps",
        args: {},
      }),
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toEqual({ ok: true, result: { apps: [] } });
  });
});
