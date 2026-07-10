import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __clearWebsiteMetadataCacheForTests, fetchWebsiteIcon, resolveWebsiteMetadata } from "../services/website-metadata.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

const dnsPromises = await import("node:dns/promises");
const lookupMock = vi.mocked(dnsPromises.lookup);

async function startFixtureServer(handler: Parameters<typeof createServer>[0]) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

describe("resolveWebsiteMetadata", () => {
  let servers: Array<{ close: () => Promise<void> }> = [];
  const originalRudderHome = process.env.RUDDER_HOME;
  const originalRudderInstanceId = process.env.RUDDER_INSTANCE_ID;

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    __clearWebsiteMetadataCacheForTests();
    lookupMock.mockReset();
    vi.restoreAllMocks();
    if (originalRudderHome === undefined) delete process.env.RUDDER_HOME;
    else process.env.RUDDER_HOME = originalRudderHome;
    if (originalRudderInstanceId === undefined) delete process.env.RUDDER_INSTANCE_ID;
    else process.env.RUDDER_INSTANCE_ID = originalRudderInstanceId;
  });

  it("returns known website icons without fetching the public page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

    await expect(resolveWebsiteMetadata("https://x.com/my_knn_totoro/status/2068910037238772102")).resolves.toMatchObject({
      url: "https://x.com/my_knn_totoro/status/2068910037238772102",
      siteName: "X",
      iconUrl: expect.stringMatching(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("returns Feishu and Rudder embedded website icons without fetching the public page", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

    await expect(resolveWebsiteMetadata("https://docs.feishu.cn/docx/example")).resolves.toMatchObject({
      url: "https://docs.feishu.cn/docx/example",
      siteName: "Feishu",
      iconUrl: expect.stringMatching(/^data:image\/svg\+xml;base64,/u),
    });
    await expect(resolveWebsiteMetadata("https://rudder.zeeland.studio/issues/RUD-1")).resolves.toMatchObject({
      url: "https://rudder.zeeland.studio/issues/RUD-1",
      siteName: "Rudder",
      iconUrl: expect.stringMatching(/^data:image\/x-icon;base64,/u),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("returns the page-declared favicon as the website icon", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.setHeader("content-type", "image/x-icon");
        res.end(Buffer.from("ico"));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`
        <!doctype html>
        <html>
          <head>
            <title>Example Site</title>
            <link rel="shortcut icon" href="/favicon.ico">
          </head>
          <body>ok</body>
        </html>
      `);
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(`${fixture.origin}/post/1`, { allowPrivateHosts: true })).resolves.toEqual({
      url: `${fixture.origin}/post/1`,
      siteName: "Example Site",
      iconUrl: `${fixture.origin}/favicon.ico`,
    });
  });

  it("falls back to null icon when the page does not advertise one", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>No Icon</title>");
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(fixture.origin, { allowPrivateHosts: true })).resolves.toMatchObject({
      siteName: "No Icon",
      iconUrl: null,
    });
  });

  it("falls back to a server-side favicon provider for public pages without discoverable origin icons", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pinnedFetchImpl = vi.fn(async (url: URL) => {
      const href = url.href;
      if (href === "https://example.com/post") {
        return new Response("<!doctype html><title>No Origin Icon</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (href === "https://example.com/favicon.ico") {
        return new Response("not found", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (href === "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fexample.com&sz=64") {
        return new Response(Buffer.from("png"), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    await expect(resolveWebsiteMetadata("https://example.com/post", { pinnedFetchImpl })).resolves.toMatchObject({
      siteName: "No Origin Icon",
      iconUrl: "https://www.google.com/s2/favicons?domain_url=https%3A%2F%2Fexample.com&sz=64",
    });
  });

  it("falls back to the implicit favicon when a declared icon is not a valid image", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/bad.ico") {
        res.setHeader("content-type", "text/plain");
        res.end("not an icon");
        return;
      }
      if (req.url === "/favicon.ico") {
        res.setHeader("content-type", "image/x-icon");
        res.end(Buffer.from("ico"));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`
        <!doctype html>
        <title>Fallback Icon</title>
        <link rel="icon" href="/bad.ico">
      `);
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(fixture.origin, { allowPrivateHosts: true })).resolves.toMatchObject({
      siteName: "Fallback Icon",
      iconUrl: `${fixture.origin}/favicon.ico`,
    });
  });

  it("rejects fetched SVG icons", async () => {
    const fetchImpl = async () => new Response("<svg onload='alert(1)'/>", {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    });

    await expect(fetchWebsiteIcon("https://static.example.com/favicon.svg", { fetchImpl })).resolves.toBeNull();
  });

  it("extracts declared icons from large pages without failing the metadata request", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/favicon.png") {
        res.setHeader("content-type", "image/png");
        res.end(Buffer.from("png"));
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`
        <!doctype html>
        <title>Large Metadata Page</title>
        <link rel="icon" href="/favicon.png">
        ${"x".repeat(300 * 1024)}
      `);
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(`${fixture.origin}/large`, { allowPrivateHosts: true })).resolves.toMatchObject({
      siteName: "Large Metadata Page",
      iconUrl: `${fixture.origin}/favicon.png`,
    });
  });

  it("returns empty metadata instead of failing when a public page fetch fails", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(resolveWebsiteMetadata("https://example.com/post", { fetchImpl })).resolves.toEqual({
      url: "https://example.com/post",
      siteName: null,
      iconUrl: null,
    });
  });

  it("rejects private-network targets by default", async () => {
    await expect(resolveWebsiteMetadata("http://127.0.0.1:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://localhost:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://198.18.0.42/post")).rejects.toThrow("Private network URLs");
  });

  it.each([
    "http://224.0.0.1/post",
    "http://239.255.255.250/post",
    "http://240.0.0.1/post",
    "http://255.255.255.255/post",
    "http://198.51.100.1/post",
    "http://203.0.113.1/post",
  ])("rejects non-public IPv4 literal targets: %s", async (url) => {
    await expect(resolveWebsiteMetadata(url)).rejects.toThrow("Private network URLs");
  });

  it.each(["224.0.0.1", "240.0.0.1", "255.255.255.255", "198.51.100.1", "203.0.113.1"])(
    "rejects public hostnames resolving to non-public IPv4 addresses: %s",
    async (address) => {
      lookupMock.mockResolvedValue([{ address, family: 4 }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

      await expect(resolveWebsiteMetadata("https://example.com/post")).rejects.toThrow("Private network URLs");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each([
    "http://[::]:12345/post",
    "http://[::1]:12345/post",
    "http://[::ffff:127.0.0.1]:12345/post",
    "http://[::ffff:7f00:1]:12345/post",
    "http://[0:0:0:0:0:ffff:7f00:1]:12345/post",
    "http://[64:ff9b::7f00:1]:12345/post",
    "http://[::ffff:0:7f00:1]:12345/post",
    "http://[fe80::1]:12345/post",
    "http://[fc00::1]:12345/post",
    "http://[fd12:3456::1]:12345/post",
  ])("rejects non-public IPv6 literal targets: %s", async (url) => {
    await expect(resolveWebsiteMetadata(url)).rejects.toThrow("Private network URLs");
  });

  it.each([
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b::7f00:1",
    "::ffff:0:7f00:1",
    "fe80::1",
    "fd12:3456::1",
  ])(
    "rejects public hostnames resolving to non-public IPv6 addresses: %s",
    async (address) => {
      lookupMock.mockResolvedValue([{ address, family: 6 }]);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

      await expect(resolveWebsiteMetadata("https://example.com/post")).rejects.toThrow("Private network URLs");
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects public hostnames that resolve through benchmark-network addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "198.18.0.42", family: 4 }]);
    const pinnedFetchImpl = vi.fn();

    await expect(resolveWebsiteMetadata("https://example.com/post", { pinnedFetchImpl }))
      .rejects.toThrow("Private network URLs");
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it("pins the validated DNS addresses into the connection transport", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pinnedFetchImpl = vi.fn(async (_url: URL, _init: RequestInit, addresses: ReadonlyArray<{ address: string }>) => {
      expect(addresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
      return new Response("<!doctype html><title>Pinned Site</title>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    await expect(resolveWebsiteMetadata("https://example.com/post", { pinnedFetchImpl })).resolves.toMatchObject({
      siteName: "Pinned Site",
    });
    expect(pinnedFetchImpl).toHaveBeenCalled();
  });

  it("rejects a hostname when any resolved address is non-public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const pinnedFetchImpl = vi.fn();

    await expect(resolveWebsiteMetadata("https://example.com/post", { pinnedFetchImpl }))
      .rejects.toThrow("Private network URLs");
    expect(pinnedFetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    "https://service.internal/post",
    "https://app.local/post",
    "https://dashboard.corp/post",
    "https://portal.intranet/post",
    "https://intranet/post",
  ])("rejects non-public hostnames that resolve through local 198.18/15 proxy addresses: %s", async (url) => {
    lookupMock.mockResolvedValue([{ address: "198.18.0.42", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch should not be called"));

    await expect(resolveWebsiteMetadata(url)).rejects.toThrow("Private network URLs");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects redirects to private-network metadata targets", async () => {
    const fetchImpl = async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:12345/private" },
    });

    await expect(resolveWebsiteMetadata("https://example.com/post", { fetchImpl })).rejects.toThrow("Private network URLs");
  });

  it("rejects redirects to private-network icon targets", async () => {
    const fetchImpl = async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:12345/favicon.ico" },
    });

    await expect(fetchWebsiteIcon("https://example.com/favicon.ico", { fetchImpl })).rejects.toThrow("Private network URLs");
  });

  it("reuses fetched website icons from the instance disk cache", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "rudder-website-icon-cache-"));
    process.env.RUDDER_HOME = tempHome;
    process.env.RUDDER_INSTANCE_ID = "test";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pinnedFetchImpl = vi.fn(async () => new Response(Buffer.from("ico"), {
      status: 200,
      headers: { "content-type": "image/x-icon" },
    }));

    try {
      await expect(fetchWebsiteIcon("https://static.example.com/favicon.ico", { pinnedFetchImpl })).resolves.toMatchObject({
        contentType: "image/x-icon",
        body: Buffer.from("ico"),
      });
      await expect(fetchWebsiteIcon("https://static.example.com/favicon.ico", { pinnedFetchImpl })).resolves.toMatchObject({
        contentType: "image/x-icon",
        body: Buffer.from("ico"),
      });
      expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
