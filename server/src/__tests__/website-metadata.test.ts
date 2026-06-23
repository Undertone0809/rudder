import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWebsiteIcon, resolveWebsiteMetadata } from "../services/website-metadata.js";

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
