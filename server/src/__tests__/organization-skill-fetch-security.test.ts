import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchText } from "../services/knowledge-portability/organization-skills.sources.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const dnsPromises = await import("node:dns/promises");
const lookupMock = vi.mocked(dnsPromises.lookup);
const publicAddresses = [{ address: "93.184.216.34", family: 4 as const }];

describe("organization skill public URL fetching", () => {
  afterEach(() => {
    lookupMock.mockReset();
    vi.restoreAllMocks();
  });

  it.each([
    "http://localhost:3000/SKILL.md",
    "http://127.0.0.1:3000/SKILL.md",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/SKILL.md",
    "http://[::ffff:127.0.0.1]/SKILL.md",
  ])("rejects literal local, metadata, and non-public IPv6 sources: %s", async (url) => {
    const pinnedFetchImpl = vi.fn();

    await expect(fetchText(url, { pinnedFetchImpl })).rejects.toMatchObject({
      status: 422,
      message: "Private network URLs cannot be inspected",
    });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS answer is private", async () => {
    lookupMock.mockResolvedValue([
      ...publicAddresses,
      { address: "10.0.0.7", family: 4 },
    ]);
    const pinnedFetchImpl = vi.fn();

    await expect(fetchText("https://skills.example/SKILL.md", { pinnedFetchImpl }))
      .rejects.toMatchObject({ status: 422, message: "Private network URLs cannot be inspected" });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a public hostname resolving to a non-public IPv6 address", async () => {
    lookupMock.mockResolvedValue([{ address: "fe80::1", family: 6 }]);
    const pinnedFetchImpl = vi.fn();

    await expect(fetchText("https://skills.example/SKILL.md", { pinnedFetchImpl }))
      .rejects.toMatchObject({ status: 422, message: "Private network URLs cannot be inspected" });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("validates and pins every hop of a public redirect", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async (url: URL) => {
      if (url.href === "https://skills.example/SKILL.md") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/final/SKILL.md" },
        });
      }
      if (url.href === "https://cdn.example/final/SKILL.md") {
        return new Response("# Safe skill", { status: 200 });
      }
      throw new Error(`Unexpected fetch ${url.href}`);
    });

    await expect(fetchText("https://skills.example/SKILL.md", { pinnedFetchImpl }))
      .resolves.toBe("# Safe skill");

    expect(lookupMock).toHaveBeenNthCalledWith(1, "skills.example", { all: true, verbatim: true });
    expect(lookupMock).toHaveBeenNthCalledWith(2, "cdn.example", { all: true, verbatim: true });
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(2);
    expect(pinnedFetchImpl.mock.calls[0]?.[2]).toEqual(publicAddresses);
    expect(pinnedFetchImpl.mock.calls[1]?.[2]).toEqual(publicAddresses);
    expect(pinnedFetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
    expect(pinnedFetchImpl.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("rejects a redirect to metadata before opening a second connection", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));

    await expect(fetchText("https://skills.example/SKILL.md", { pinnedFetchImpl }))
      .rejects.toMatchObject({ status: 422, message: "Private network URLs cannot be inspected" });
    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes only the validated DNS address set to the pinned transport", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const globalFetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("global fetch must not be used"));
    const pinnedFetchImpl = vi.fn(async (
      url: URL,
      init: RequestInit,
      addresses: ReadonlyArray<{ address: string; family: 4 | 6 }>,
    ) => {
      expect(url.href).toBe("https://skills.example/SKILL.md");
      expect(init.redirect).toBe("manual");
      expect(addresses).toEqual(publicAddresses);
      return new Response("# DNS-pinned skill", { status: 200 });
    });

    await expect(fetchText("https://skills.example/SKILL.md", { pinnedFetchImpl }))
      .resolves.toBe("# DNS-pinned skill");
    expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("rejects a response body that exceeds the configured size limit", async () => {
    lookupMock.mockResolvedValue(publicAddresses);
    const pinnedFetchImpl = vi.fn(async () => new Response("12345", { status: 200 }));

    await expect(fetchText("https://skills.example/SKILL.md", {
      maxBytes: 4,
      pinnedFetchImpl,
    })).rejects.toMatchObject({
      status: 422,
      message: "Response exceeds public text size limit",
    });
  });

  it("times out even when DNS resolution stalls", async () => {
    lookupMock.mockImplementation(() => new Promise<never>(() => undefined));
    const pinnedFetchImpl = vi.fn();

    await expect(fetchText("https://skills.example/SKILL.md", {
      timeoutMs: 20,
      pinnedFetchImpl,
    })).rejects.toMatchObject({ status: 422 });
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });
});
