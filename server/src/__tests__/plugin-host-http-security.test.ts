import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPluginHttp } from "../services/plugin-host-services.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const dnsPromises = await import("node:dns/promises");
const lookupMock = vi.mocked(dnsPromises.lookup);
const publicAddresses = [{ address: "93.184.216.34", family: 4 as const }];

describe("plugin host HTTP security", () => {
  afterEach(() => {
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    "http://0.1.2.3/data",
    "http://100.64.0.1/data",
    "http://192.0.0.1/data",
    "http://198.18.0.1/data",
    "http://224.0.0.1/data",
    "http://[::ffff:127.0.0.1]/data",
    "http://[::192.168.1.1]/data",
    "http://[64:ff9b::a00:1]/data",
    "http://[2001:db8::1]/data",
  ])("rejects non-public literal address %s", async (url) => {
    const pinnedFetchImpl = vi.fn();

    await expect(fetchPluginHttp(
      { url },
      { publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow("Private network URLs cannot be inspected");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname if any DNS answer is non-public", async () => {
    lookupMock.mockResolvedValue([
      ...publicAddresses,
      { address: "10.0.0.7", family: 4 },
    ]);
    const pinnedFetchImpl = vi.fn();

    await expect(fetchPluginHttp(
      { url: "https://plugins.example/data" },
      { publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow("Private network URLs cannot be inspected");

    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("pins every public redirect hop and strips cross-origin credentials", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      if (url.hostname === "plugins.example") {
        expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret");
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final" },
        });
      }
      expect(url.hostname).toBe("cdn.example");
      expect(new Headers(init.headers).has("authorization")).toBe(false);
      return new Response("safe response", { status: 200 });
    });

    await expect(fetchPluginHttp(
      {
        url: "https://plugins.example/start",
        init: { headers: { authorization: "Bearer secret" } },
      },
      { publicHttpOptions: { pinnedFetchImpl } },
    )).resolves.toMatchObject({ status: 200, body: "safe response" });

    expect(lookupMock).toHaveBeenNthCalledWith(1, "plugins.example", { all: true, verbatim: true });
    expect(lookupMock).toHaveBeenNthCalledWith(2, "cdn.example", { all: true, verbatim: true });
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(2);
    expect(pinnedFetchImpl.mock.calls[0]?.[2]).toEqual(publicAddresses);
    expect(pinnedFetchImpl.mock.calls[1]?.[2]).toEqual(publicAddresses);
  });

  it("rejects a redirect to metadata before opening another connection", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(fetchPluginHttp(
      { url: "https://plugins.example/start" },
      { publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow("Private network URLs cannot be inspected");

    expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized request before DNS or transport work", async () => {
    const pinnedFetchImpl = vi.fn();

    await expect(fetchPluginHttp(
      { url: "https://plugins.example/data", init: { method: "POST", body: "12345" } },
      { maxRequestBytes: 4, publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow("request body exceeded 4 bytes");

    expect(lookupMock).not.toHaveBeenCalled();
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("cancels and rejects an oversized response body", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async () => new Response("12345", { status: 200 }));

    await expect(fetchPluginHttp(
      { url: "https://plugins.example/data" },
      { maxResponseBytes: 4, publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow("response body exceeded 4 bytes");
  });

  it("times out even if DNS resolution never settles", async () => {
    lookupMock.mockImplementation(() => new Promise<never>(() => undefined));
    const pinnedFetchImpl = vi.fn();

    await expect(fetchPluginHttp(
      { url: "https://plugins.example/data" },
      { timeoutMs: 20, publicHttpOptions: { pinnedFetchImpl } },
    )).rejects.toThrow();

    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });
});
