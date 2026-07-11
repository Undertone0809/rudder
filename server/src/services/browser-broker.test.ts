import { describe, expect, it, vi } from "vitest";
import {
  BrowserBrokerError,
  createBrowserBrokerRegistry,
} from "./browser-broker.js";

describe("Browser Broker registry", () => {
  it("accepts only credentialed loopback HTTP endpoints", () => {
    const registry = createBrowserBrokerRegistry();

    expect(() => registry.register({
      endpoint: "https://127.0.0.1:4141/browser",
      token: "a".repeat(48),
    })).toThrow("loopback HTTP");
    expect(() => registry.register({
      endpoint: "http://example.com:4141/browser",
      token: "a".repeat(48),
    })).toThrow("loopback HTTP");
    expect(() => registry.register({
      endpoint: "http://127.0.0.1:4141/browser?token=leak",
      token: "a".repeat(48),
    })).toThrow("query");
    expect(() => registry.register({
      endpoint: "http://127.0.0.1:4141/browser",
      token: "short",
    })).toThrow("credential");

    registry.register({
      endpoint: "http://127.0.0.1:4141/browser",
      token: "a".repeat(48),
    });
    expect(registry.isAvailable()).toBe(true);
  });

  it("forwards runtime-owned identity with an in-memory bearer credential", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({
      ok: true,
      result: { tabId: "tab-1", url: "https://example.com/" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const registry = createBrowserBrokerRegistry({ fetchImpl });
    const token = "b".repeat(48);
    registry.register({ endpoint: "http://[::1]:4242/browser", token });

    await expect(registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "open",
      args: { url: "https://example.com" },
    })).resolves.toEqual({ tabId: "tab-1", url: "https://example.com/" });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("http://[::1]:4242/browser");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(init?.body))).toEqual({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "open",
      args: { url: "https://example.com" },
    });
  });

  it("returns stable unavailable and broker error codes without leaking response bodies", async () => {
    const registry = createBrowserBrokerRegistry({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ok: false,
        error: {
          code: "browser_tab_forbidden",
          message: "This tab belongs to another run.",
          secret: "must-not-escape",
        },
      }), { status: 403, headers: { "content-type": "application/json" } })),
    });

    await expect(registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "tabs",
      args: {},
    })).rejects.toMatchObject({ code: "browser_unavailable" } satisfies Partial<BrowserBrokerError>);

    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: "c".repeat(48) });
    await expect(registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "navigate",
      args: { tabId: "tab-other", url: "https://example.com" },
    })).rejects.toEqual(expect.objectContaining({
      code: "browser_tab_forbidden",
      message: "This tab belongs to another run.",
    }));

    try {
      await registry.forward({
        identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
        action: "tabs",
        args: {},
      });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("must-not-escape");
    }
  });

  it("does not let a stale Desktop credential unregister a replacement Broker", () => {
    const registry = createBrowserBrokerRegistry();
    const first = "d".repeat(48);
    const replacement = "e".repeat(48);
    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: first });
    registry.register({ endpoint: "http://127.0.0.1:4242/browser", token: replacement });

    expect(registry.unregister(first)).toBe(false);
    expect(registry.isAvailable()).toBe(true);
    expect(registry.unregister(replacement)).toBe(true);
    expect(registry.isAvailable()).toBe(false);
  });
});
