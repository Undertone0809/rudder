import { describe, expect, it, vi } from "vitest";
import {
  isDesktopBrowserRunActive,
  readDesktopBrowserSettings,
  registerDesktopBrowserBroker,
  unregisterDesktopBrowserBroker,
} from "./browser-broker-registration.js";

const broker = {
  endpoint: "http://127.0.0.1:43123/browser",
  token: "a".repeat(64),
};

describe("Desktop Browser Broker server registration", () => {
  it("registers and unregisters the loopback endpoint through the local instance API", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await registerDesktopBrowserBroker("http://127.0.0.1:3100/api", broker, fetchImpl);
    await unregisterDesktopBrowserBroker("http://127.0.0.1:3100", broker.token, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "http://127.0.0.1:3100/api/instance/browser/broker", {
      method: "PUT",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(broker),
      signal: expect.any(AbortSignal),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "http://127.0.0.1:3100/api/instance/browser/broker", {
      method: "DELETE",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: broker.token }),
      signal: expect.any(AbortSignal),
    });
  });

  it("sends the Desktop lifecycle owner generation without exposing it elsewhere", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const versionedBroker = {
      ...broker,
      ownerId: "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08",
      generation: 7,
    };

    await registerDesktopBrowserBroker("http://127.0.0.1:3100/api", versionedBroker, fetchImpl);

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual(versionedBroker);
  });

  it("loads Browser settings and checks exact active run ownership", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/instance/settings/browser")) {
        return new Response(JSON.stringify({ enabled: false, openLinksIn: "built_in" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: "run-1",
        orgId: "org-1",
        agentId: "agent-1",
        status: "running",
      }), { status: 200 });
    });

    await expect(readDesktopBrowserSettings("http://127.0.0.1:3100/api", fetchImpl)).resolves.toEqual({
      enabled: false,
      openLinksIn: "built_in",
    });
    await expect(isDesktopBrowserRunActive("http://127.0.0.1:3100/api", {
      orgId: "org-1",
      agentId: "agent-1",
      runId: "run-1",
    }, fetchImpl)).resolves.toBe(true);
    await expect(isDesktopBrowserRunActive("http://127.0.0.1:3100/api", {
      orgId: "org-1",
      agentId: "agent-2",
      runId: "run-1",
    }, fetchImpl)).resolves.toBe(false);
  });

  it("does not expose response bodies or the credential when registration fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret server response", { status: 500 }));

    await expect(registerDesktopBrowserBroker("http://127.0.0.1:3100/api", broker, fetchImpl))
      .rejects.toThrow("Rudder Browser Broker registration failed (500).");
    try {
      await registerDesktopBrowserBroker("http://127.0.0.1:3100/api", broker, fetchImpl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("secret server response");
      expect(message).not.toContain(broker.token);
    }
  });
});
