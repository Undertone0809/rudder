import { createServer } from "node:http";
import { AddressInfo } from "node:net";
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

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.close()));
    servers = [];
    __clearWebsiteMetadataCacheForTests();
    lookupMock.mockReset();
    vi.restoreAllMocks();
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

  it("rejects private-network targets by default", async () => {
    await expect(resolveWebsiteMetadata("http://127.0.0.1:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://localhost:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://198.18.0.42/post")).rejects.toThrow("Private network URLs");
  });

  it("allows public hostnames that resolve through local 198.18/15 proxy addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "198.18.0.42", family: 4 }]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href === "https://example.com/favicon.ico") {
        return new Response(Buffer.from("ico"), {
          status: 200,
          headers: { "content-type": "image/x-icon" },
        });
      }
      return new Response(`
        <!doctype html>
        <title>Proxy Mapped Site</title>
        <link rel="icon" href="/favicon.ico">
      `, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    await expect(resolveWebsiteMetadata("https://example.com/post")).resolves.toMatchObject({
      siteName: "Proxy Mapped Site",
      iconUrl: "https://example.com/favicon.ico",
    });
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
});
