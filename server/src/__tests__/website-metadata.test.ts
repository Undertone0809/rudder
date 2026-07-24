import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
      pageTitle: null,
      iconUrl: expect.stringMatching(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("fetches known sites for authoring titles without replacing their icon or requested URL", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const requestedUrl = "https://x.com/example/status/1";
    const redirectedUrl = "https://news.example.com/articles/1";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href === requestedUrl) {
        return new Response(null, {
          status: 302,
          headers: { location: redirectedUrl },
        });
      }
      if (href === redirectedUrl) {
        return new Response(`
          <!doctype html>
          <meta property="og:title" content="Redirected Authoring Title">
          <title>Ignored document title</title>
        `, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    await resolveWebsiteMetadata(requestedUrl);
    await expect(resolveWebsiteMetadata(requestedUrl, { purpose: "authoring" })).resolves.toMatchObject({
      url: requestedUrl,
      siteName: "X",
      pageTitle: "Redirected Authoring Title",
      iconUrl: expect.stringMatching(/^data:image\/(?:x-icon|png|svg\+xml);base64,/u),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("fetches only the page title for authoring metadata without probing favicon URLs", async () => {
    const requestedUrl = "https://metadata.example.com/post";
    const fetchImpl = vi.fn(async (url: string) => {
      if (url !== requestedUrl) throw new Error(`Unexpected fetch ${url}`);
      return new Response(`
        <!doctype html>
        <meta property="og:title" content="Authoring title only">
        <link rel="icon" href="/declared.ico">
      `, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });

    await expect(resolveWebsiteMetadata(requestedUrl, {
      fetchImpl,
      purpose: "authoring",
    })).resolves.toEqual({
      url: requestedUrl,
      siteName: null,
      pageTitle: "Authoring title only",
      iconUrl: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(requestedUrl, expect.any(Object));
  });

  it("keeps preview and authoring inflight requests isolated", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const requestedUrl = "https://metadata.example.com/post";
    let pageFetchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = url instanceof URL ? url.href : String(url);
      if (href === requestedUrl) {
        pageFetchCount += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
        return new Response(`
          <!doctype html>
          <meta property="og:title" content="Purpose-specific inflight request">
          <link rel="icon" href="/favicon.ico">
        `, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (href === "https://metadata.example.com/favicon.ico") {
        return new Response(Buffer.from("ico"), {
          status: 200,
          headers: { "content-type": "image/x-icon" },
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });

    const [preview, authoring] = await Promise.all([
      resolveWebsiteMetadata(requestedUrl),
      resolveWebsiteMetadata(requestedUrl, { purpose: "authoring" }),
    ]);

    expect(pageFetchCount).toBe(2);
    expect(preview.pageTitle).toBe("Purpose-specific inflight request");
    expect(authoring.pageTitle).toBe("Purpose-specific inflight request");
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
      pageTitle: "Example Site",
      iconUrl: `${fixture.origin}/favicon.ico`,
    });
  });

  it("resolves and normalizes authoring titles in metadata priority order", async () => {
    const longTitle = `${"A".repeat(159)}😀tail`;
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/favicon.ico") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/og") {
        res.end(`
          <!doctype html>
          <meta property="og:title" content="&lt;strong&gt; OG&nbsp; &amp;amp;   Title&lt;/strong&gt;&#x200B; Control">
          <meta name="twitter:title" content="Ignored Twitter Title">
          <title>Ignored document title</title>
        `);
        return;
      }
      if (req.url === "/twitter") {
        res.end(`
          <!doctype html>
          <meta property="og:title" content="   ">
          <meta name="twitter:title" content="Twitter &amp; Title">
          <title>Ignored document title</title>
        `);
        return;
      }
      res.end(`<!doctype html><title>&lt;b&gt;${longTitle}&lt;/b&gt;</title>`);
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(`${fixture.origin}/og`, {
      allowPrivateHosts: true,
      purpose: "authoring",
    })).resolves.toMatchObject({
      pageTitle: "OG & Title Control",
    });
    await expect(resolveWebsiteMetadata(`${fixture.origin}/twitter`, {
      allowPrivateHosts: true,
      purpose: "authoring",
    })).resolves.toMatchObject({
      pageTitle: "Twitter & Title",
    });
    await expect(resolveWebsiteMetadata(`${fixture.origin}/title`, {
      allowPrivateHosts: true,
      purpose: "authoring",
    })).resolves.toMatchObject({
      pageTitle: `${"A".repeat(159)}😀`,
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const href = url instanceof URL ? url.href : String(url);
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

    await expect(resolveWebsiteMetadata("https://example.com/post")).resolves.toMatchObject({
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

  it("extracts declared icons from large pages without failing the metadata request", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/favicon.svg") {
        res.setHeader("content-type", "image/svg+xml");
        res.end("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><rect width=\"16\" height=\"16\"/></svg>");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`
        <!doctype html>
        <title>Large Metadata Page</title>
        <link rel="icon" href="/favicon.svg">
        ${"x".repeat(300 * 1024)}
      `);
    });
    servers.push(fixture);

    await expect(resolveWebsiteMetadata(`${fixture.origin}/large`, { allowPrivateHosts: true })).resolves.toMatchObject({
      siteName: "Large Metadata Page",
      iconUrl: `${fixture.origin}/favicon.svg`,
    });
  });

  it("returns empty metadata instead of failing when a public page fetch fails", async () => {
    const fetchImpl = async () => {
      throw new TypeError("fetch failed");
    };

    await expect(resolveWebsiteMetadata("https://example.com/post", { fetchImpl })).resolves.toEqual({
      url: "https://example.com/post",
      siteName: null,
      pageTitle: null,
      iconUrl: null,
    });
  });

  it("rejects private-network targets by default", async () => {
    await expect(resolveWebsiteMetadata("http://127.0.0.1:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://localhost:12345")).rejects.toThrow("Private network URLs");
    await expect(resolveWebsiteMetadata("http://198.18.0.42/post")).rejects.toThrow("Private network URLs");
  });

  it.each([
    "https://user@example.com/post",
    "https://user:password@example.com/post",
  ])("rejects credentialed URL %s before resolver or fetch", async (targetUrl) => {
    const fetchImpl = vi.fn(async () => new Response("<title>Never reached</title>", {
      headers: { "content-type": "text/html" },
    }));

    await expect(resolveWebsiteMetadata(targetUrl, { fetchImpl }))
      .rejects.toThrow("Credentialed URLs cannot be inspected");
    await expect(fetchWebsiteIcon(targetUrl, { fetchImpl }))
      .rejects.toThrow("Credentialed URLs cannot be inspected");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it.each([
    "http://[::ffff:7f00:1]:12345",
    "http://[::]:12345",
    "http://[fe81::1]:12345",
    "http://[febf::1]:12345",
    "http://[fec0::1]:12345",
    "http://[2001:db8::1]:12345",
  ])("rejects non-public IPv6 target %s before any metadata or icon request", async (targetUrl) => {
    const fetchImpl = vi.fn(async () => new Response(`
      <!doctype html>
      <title>Private target should never be reached</title>
    `, {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    await expect(resolveWebsiteMetadata(targetUrl, { fetchImpl }))
      .rejects.toThrow("Private network URLs");
    await expect(fetchWebsiteIcon(`${targetUrl}/favicon.ico`, { fetchImpl }))
      .rejects.toThrow("Private network URLs");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects public hostnames that resolve through local 198.18/15 proxy addresses", async () => {
    lookupMock.mockResolvedValue([{ address: "198.18.0.42", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch should not be called"));

    await expect(resolveWebsiteMetadata("https://example.com/post"))
      .rejects.toThrow("Private network URLs");
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it("pins each request to its validated resolver result while preserving redirect Host headers", async () => {
    let fixturePort = 0;
    const seenHosts: string[] = [];
    const fixture = await startFixtureServer((req, res) => {
      seenHosts.push(req.headers.host ?? "");
      if (req.url === "/start") {
        res.statusCode = 302;
        res.setHeader("location", `http://redirected.example:${fixturePort}/final`);
        res.end("redirect body");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<!doctype html><title>Pinned resolver connection</title>");
    });
    servers.push(fixture);
    fixturePort = Number(new URL(fixture.origin).port);
    lookupMock.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await expect(resolveWebsiteMetadata(`http://metadata.example:${fixturePort}/start`, {
      allowPrivateHosts: true,
      purpose: "authoring",
    })).resolves.toMatchObject({
      pageTitle: "Pinned resolver connection",
    });

    expect(lookupMock).toHaveBeenCalledTimes(2);
    expect(lookupMock).toHaveBeenNthCalledWith(1, "metadata.example", { all: true, verbatim: true });
    expect(lookupMock).toHaveBeenNthCalledWith(2, "redirected.example", { all: true, verbatim: true });
    expect(seenHosts).toEqual([
      `metadata.example:${fixturePort}`,
      `redirected.example:${fixturePort}`,
    ]);
  });

  it("keeps one timeout active through redirects and full body consumption", async () => {
    vi.useFakeTimers();
    let settled = false;
    let slowBodyTimer: ReturnType<typeof setTimeout> | null = null;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://metadata.example/start") {
        await new Promise<void>((resolve) => setTimeout(resolve, 3_000));
        return new Response("redirect", {
          status: 302,
          headers: { location: "/slow" },
        });
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          slowBodyTimer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("<title>Too late</title>"));
            controller.close();
          }, 6_000);
        },
        cancel() {
          if (slowBodyTimer) clearTimeout(slowBodyTimer);
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });

    const request = resolveWebsiteMetadata("https://metadata.example/start", {
      fetchImpl,
      purpose: "authoring",
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const settledByDeadline = settled;
    await vi.advanceTimersByTimeAsync(6_000);
    await request;
    if (slowBodyTimer) clearTimeout(slowBodyTimer);
    vi.useRealTimers();

    expect(settledByDeadline).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("enforces the same total timeout while hostname resolution is pending", async () => {
    vi.useFakeTimers();
    let settled = false;
    lookupMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
      return [{ address: "93.184.216.34", family: 4 }];
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const request = resolveWebsiteMetadata("https://metadata.example/slow-dns", {
      purpose: "authoring",
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const settledByDeadline = settled;
    await vi.advanceTimersByTimeAsync(1_000);
    await request;
    vi.useRealTimers();

    expect(settledByDeadline).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cancels redirect and unused non-HTML response bodies", async () => {
    const cancelled: string[] = [];
    const body = (label: string) => new ReadableStream<Uint8Array>({
      cancel() {
        cancelled.push(label);
      },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://metadata.example/start") {
        return new Response(body("redirect"), {
          status: 302,
          headers: { location: "/binary" },
        });
      }
      return new Response(body("binary"), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    });

    await expect(resolveWebsiteMetadata("https://metadata.example/start", {
      fetchImpl,
      purpose: "authoring",
    })).resolves.toMatchObject({
      pageTitle: null,
      iconUrl: null,
    });
    expect(cancelled).toEqual(["redirect", "binary"]);
  });

  it("bounds the in-memory metadata cache and evicts the oldest completed entry", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      "<!doctype html><title>Bounded cache entry</title>",
      {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      },
    ));

    for (let index = 0; index < 129; index += 1) {
      await resolveWebsiteMetadata(`https://x.com/cache/${index}`, { purpose: "authoring" });
    }
    await resolveWebsiteMetadata("https://x.com/cache/0", { purpose: "authoring" });

    expect(fetchSpy).toHaveBeenCalledTimes(130);
  });

  it("reuses fetched website icons from the instance disk cache", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "rudder-website-icon-cache-"));
    process.env.RUDDER_HOME = tempHome;
    process.env.RUDDER_INSTANCE_ID = "test";
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from("ico"), {
      status: 200,
      headers: { "content-type": "image/x-icon" },
    }));

    try {
      await expect(fetchWebsiteIcon("https://static.example.com/favicon.ico")).resolves.toMatchObject({
        contentType: "image/x-icon",
        body: Buffer.from("ico"),
      });
      await expect(fetchWebsiteIcon("https://static.example.com/favicon.ico")).resolves.toMatchObject({
        contentType: "image/x-icon",
        body: Buffer.from("ico"),
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("removes expired website icon disk-cache entries before refetching", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "rudder-expired-website-icon-cache-"));
    process.env.RUDDER_HOME = tempHome;
    process.env.RUDDER_INSTANCE_ID = "test";
    const iconUrl = "https://static.example.com/expired.ico";
    const basename = createHash("sha256").update(iconUrl).digest("hex");
    const cacheDir = path.join(tempHome, "instances", "test", "data", "website-icons");
    const metadataPath = path.join(cacheDir, `${basename}.json`);
    const bodyPath = path.join(cacheDir, `${basename}.bin`);
    await mkdir(cacheDir, { recursive: true });
    await writeFile(metadataPath, JSON.stringify({ url: iconUrl, contentType: "image/x-icon" }));
    await writeFile(bodyPath, Buffer.from("stale"));
    const expiredAt = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    await Promise.all([
      utimes(metadataPath, expiredAt, expiredAt),
      utimes(bodyPath, expiredAt, expiredAt),
    ]);
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));

    try {
      await expect(fetchWebsiteIcon(iconUrl)).resolves.toBeNull();
      await expect(readdir(cacheDir)).resolves.not.toContain(`${basename}.json`);
      await expect(readdir(cacheDir)).resolves.not.toContain(`${basename}.bin`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("bounds the instance website icon disk cache", async () => {
    const tempHome = await mkdtemp(path.join(os.tmpdir(), "rudder-bounded-website-icon-cache-"));
    process.env.RUDDER_HOME = tempHome;
    process.env.RUDDER_INSTANCE_ID = "test";
    const cacheDir = path.join(tempHome, "instances", "test", "data", "website-icons");
    await mkdir(cacheDir, { recursive: true });
    for (let index = 0; index < 128; index += 1) {
      const basename = createHash("sha256").update(`https://static.example.com/existing-${index}.ico`).digest("hex");
      await Promise.all([
        writeFile(path.join(cacheDir, `${basename}.json`), "{}"),
        writeFile(path.join(cacheDir, `${basename}.bin`), Buffer.from("cached")),
      ]);
    }
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(Buffer.from("fresh"), {
      status: 200,
      headers: { "content-type": "image/x-icon" },
    }));

    try {
      await expect(fetchWebsiteIcon("https://static.example.com/fresh.ico")).resolves.toMatchObject({
        contentType: "image/x-icon",
      });
      const entries = await readdir(cacheDir);
      expect(entries.filter((entry) => entry.endsWith(".json"))).toHaveLength(128);
      expect(entries.filter((entry) => entry.endsWith(".bin"))).toHaveLength(128);
      const freshBasename = createHash("sha256")
        .update("https://static.example.com/fresh.ico")
        .digest("hex");
      expect(entries).toContain(`${freshBasename}.json`);
      expect(entries).toContain(`${freshBasename}.bin`);
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  });
});
