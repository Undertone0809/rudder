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
    expect(init?.redirect).toBe("error");
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

  it("keeps the request deadline active while reading a slow response body", async () => {
    const registry = createBrowserBrokerRegistry({
      requestTimeoutMs: 20,
      fetchImpl: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true,"result":'));
        },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: "f".repeat(48) });

    await expect(registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "tabs",
      args: {},
    })).rejects.toMatchObject({ code: "browser_unavailable" } satisfies Partial<BrowserBrokerError>);
  });

  it("rejects oversized Broker responses before parsing or returning page data", async () => {
    const registry = createBrowserBrokerRegistry({
      maxResponseBytes: 64,
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        result: { text: "secret".repeat(100) },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: "g".repeat(48) });

    await expect(registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "read",
      args: { tabId: "tab-1" },
    })).rejects.toMatchObject({ code: "browser_broker_protocol_error" } satisfies Partial<BrowserBrokerError>);
  });

  it("accepts the Base64 envelope for a screenshot at the Desktop PNG limit", async () => {
    const encodedScreenshot = "A".repeat(Math.ceil(10_000_000 / 3) * 4);
    const registry = createBrowserBrokerRegistry({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        ok: true,
        result: { tabId: "tab-1", mimeType: "image/png", base64: encodedScreenshot },
      }), { status: 200, headers: { "content-type": "application/json" } })),
    });
    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: "h".repeat(48) });

    const result = await registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "screenshot",
      args: { tabId: "tab-1" },
    }) as { tabId: string; mimeType: string; base64: string };
    expect(result).toMatchObject({ tabId: "tab-1", mimeType: "image/png" });
    expect(result.base64).toHaveLength(encodedScreenshot.length);
    expect(result.base64.at(0)).toBe("A");
    expect(result.base64.at(-1)).toBe("A");
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

  it("rejects a late registration from an older lifecycle generation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { tabs: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const registry = createBrowserBrokerRegistry({ fetchImpl });
    const ownerId = "02ad71bd-dcc1-4c93-9642-b16c8c1d2e08";
    const replacementToken = "n".repeat(48);
    registry.register({
      endpoint: "http://127.0.0.1:4242/browser",
      token: replacementToken,
      ownerId,
      generation: 2,
    });

    try {
      registry.register({
        endpoint: "http://127.0.0.1:4141/browser",
        token: "o".repeat(48),
        ownerId,
        generation: 1,
      });
      throw new Error("Expected stale Browser Broker registration to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "browser_broker_stale_registration" });
    }
    expect(registry.unregister("o".repeat(48))).toBe(false);

    await registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "tabs",
      args: {},
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4242/browser",
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: `Bearer ${replacementToken}` }),
      }),
    );
  });

  it("aborts admitted Broker requests immediately when Browser is revoked", async () => {
    let admittedSignal: AbortSignal | undefined;
    const registry = createBrowserBrokerRegistry({
      fetchImpl: vi.fn(async (_url, init) => {
        admittedSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }),
    });
    registry.register({ endpoint: "http://127.0.0.1:4141/browser", token: "r".repeat(48) });
    const pending = registry.forward({
      identity: { orgId: "org-1", agentId: "agent-1", runId: "run-1" },
      action: "wait",
      args: { tabId: "tab-1", timeMs: 30_000 },
    });
    await vi.waitFor(() => expect(admittedSignal).toBeDefined());

    registry.revoke();

    expect(admittedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(registry.isAvailable()).toBe(false);
  });
});
