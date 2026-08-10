import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBrokerError, createComputerBrokerRegistry } from "./computer-broker.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("Computer Broker registry", () => {
  it("accepts only explicit loopback endpoints and opaque credentials", () => {
    const registry = createComputerBrokerRegistry();
    expect(() => registry.register({ endpoint: "https://example.com/computer", token: "a".repeat(48) }))
      .toThrowError(ComputerBrokerError);
    expect(() => registry.register({ endpoint: "http://127.0.0.1:4111/computer", token: "short" }))
      .toThrowError(ComputerBrokerError);
    registry.register({ endpoint: "http://127.0.0.1:4111/computer", token: "a".repeat(48) });
    expect(registry.isAvailable()).toBe(true);
  });

  it("forwards bounded authenticated commands and revokes active requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const token = "b".repeat(48);
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      await gate;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: { apps: [] } }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const registry = createComputerBrokerRegistry();
    registry.register({ endpoint: `http://127.0.0.1:${address.port}/computer`, token });
    const pending = registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "list_apps",
      args: {},
    });
    await vi.waitFor(() => expect(server.listening).toBe(true));
    registry.revoke();
    release();
    await expect(pending).rejects.toMatchObject({ code: "computer_unavailable" });
    expect(registry.isAvailable()).toBe(false);
  });

  it("rejects stale lifecycle generations", () => {
    const registry = createComputerBrokerRegistry();
    const ownerId = "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08";
    registry.register({ endpoint: "http://127.0.0.1:4111/computer", token: "a".repeat(48), ownerId, generation: 2 });
    expect(() => registry.register({ endpoint: "http://127.0.0.1:4112/computer", token: "c".repeat(48), ownerId, generation: 1 }))
      .toThrowError(expect.objectContaining({ code: "computer_broker_stale_registration" }));
  });

  it("expires an unrefreshed Desktop lease and allows its owner to reconnect", () => {
    let now = 1_000;
    const registry = createComputerBrokerRegistry({ leaseTtlMs: 20_000, now: () => now });
    const ownerId = "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08";
    const registration = {
      endpoint: "http://127.0.0.1:4111/computer",
      token: "a".repeat(48),
      ownerId,
      generation: 1,
    };
    registry.register(registration);
    now += 20_001;
    expect(registry.isAvailable()).toBe(false);

    registry.register({ ...registration, refresh: true });
    expect(registry.isAvailable()).toBe(true);
  });
});
