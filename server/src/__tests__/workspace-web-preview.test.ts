import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorkspaceWebPreviewCsp,
  sanitizeConnectedPreviewHtml,
  sanitizeOfflinePreviewHtml,
  workspaceWebPreviewContentType,
  workspaceWebPreviewRuntime,
} from "../services/workspace-web-preview.js";

const cleanupDirectories: string[] = [];

async function createFixture() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-web-preview-"));
  cleanupDirectories.push(rootPath);
  const artifactPath = path.join(rootPath, "artifacts", "site");
  await fs.mkdir(path.join(artifactPath, "assets"), { recursive: true });
  const html = [
    "<!doctype html><html><head>",
    "<meta http-equiv=\"refresh\" content=\"0;url=https://outside.example/\">",
    "<link rel=\"stylesheet\" href=\"styles.css\">",
    "</head><body><a href=\"https://outside.example/\" ping=\"https://outside.example/ping\">Outside</a>",
    "<a href=\"#local\">Local</a><script src=\"script.js\"></script></body></html>",
  ].join("");
  await Promise.all([
    fs.writeFile(path.join(artifactPath, "index.html"), html, "utf8"),
    fs.writeFile(path.join(artifactPath, "styles.css"), "body { color: rgb(1, 2, 3); }", "utf8"),
    fs.writeFile(path.join(artifactPath, "script.js"), "document.body.dataset.ready = 'yes';", "utf8"),
    fs.writeFile(path.join(artifactPath, ".secret"), "hidden", "utf8"),
  ]);

  return { rootPath, artifactPath, html };
}

function createRuntime(input: {
  rootPath: string;
  now?: () => number;
  token?: string;
  requireLoopbackParent?: boolean;
  beforeFileOpen?: (canonicalTarget: string) => Promise<void>;
}) {
  return workspaceWebPreviewRuntime({} as never, {
    previewOrigin: "http://preview.localhost:3100",
    now: input.now,
    randomToken: () => input.token ?? "a".repeat(43),
    resolveWorkspaceRoot: () => input.rootPath,
    requireLoopbackParent: input.requireLoopbackParent,
    beforeFileOpen: input.beforeFileOpen,
  });
}

function previewHostApp(runtime: ReturnType<typeof createRuntime>) {
  const app = express();
  app.use(async (req, res) => {
    if (await runtime.handlePreviewHostRequest(req, res)) return;
    res.status(404).end();
  });
  return app;
}

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("workspace web preview policy", () => {
  it("maps website assets to nosniff-compatible MIME types", () => {
    expect(workspaceWebPreviewContentType("styles.css")).toBe("text/css; charset=utf-8");
    expect(workspaceWebPreviewContentType("main.mjs")).toBe("text/javascript; charset=utf-8");
    expect(workspaceWebPreviewContentType("font.woff2")).toBe("font/woff2");
    expect(workspaceWebPreviewContentType("unknown.bin")).toBe("application/octet-stream");
  });

  it("uses a static Offline CSP and an explicit Connected resource policy", () => {
    const offline = buildWorkspaceWebPreviewCsp({
      mode: "offline",
      previewOrigin: "http://preview.localhost:3100",
      parentOrigin: "http://127.0.0.1:3100",
    });
    expect(offline).toContain("sandbox; script-src 'none'");
    expect(offline).toContain("connect-src 'none'");
    expect(offline).not.toContain(" https:");

    const connected = buildWorkspaceWebPreviewCsp({
      mode: "connected",
      previewOrigin: "http://preview.localhost:3100",
      parentOrigin: "http://127.0.0.1:3100",
    });
    expect(connected).toContain("sandbox allow-scripts");
    expect(connected).toContain("script-src http://preview.localhost:3100 'unsafe-inline' blob: https:");
    expect(connected).toContain("frame-ancestors http://127.0.0.1:3100");
    expect(connected).toContain("connect-src 'none'");
  });

  it("removes automatic and external navigation from Offline HTML", () => {
    const sanitized = sanitizeOfflinePreviewHtml([
      "<meta http-equiv=refresh content='0;url=https://outside.example'>",
      "<base href='https://outside.example/'>",
      "<a href='https://outside.example/' ping='https://outside.example/ping'>Outside</a>",
      "<a href='h&#x09;ttps://outside.example/encoded'>Encoded outside</a>",
      "<a href='&#x01;https://outside.example/c0'>C0 outside</a>",
      "<a href='jav&#x0a;ascript:alert(1)'>Encoded script</a>",
      "<a href='#inside'>Inside</a>",
    ].join(""));
    expect(sanitized).not.toContain("http-equiv=\"refresh\"");
    expect(sanitized).not.toContain("<base");
    expect(sanitized).not.toContain("ping=");
    expect(sanitized).not.toContain("outside.example/encoded");
    expect(sanitized).not.toContain("outside.example/c0");
    expect(sanitized).not.toContain("javascript:alert");
    expect(sanitized).toContain("data-rudder-blocked-href=\"external\"");
    expect(sanitized).toContain("href=\"#inside\"");
  });

  it("neutralizes download links without removing ordinary Connected navigation", () => {
    const sanitized = sanitizeConnectedPreviewHtml([
      "<a href='https://outside.example/' ping='https://outside.example/ping'>Outside</a>",
      "<a href='https://outside.example/file' download ping='https://outside.example/ping'>Download</a>",
    ].join(""));

    expect(sanitized).toContain("href=\"https://outside.example/\"");
    expect(sanitized).toContain("ping=\"https://outside.example/ping\"");
    expect(sanitized).not.toContain("download=\"\"");
    expect(sanitized).not.toContain("href=\"https://outside.example/file\"");
    expect(sanitized).toContain("data-rudder-blocked-href=\"download\"");
  });
});

describe("workspace web preview runtime", () => {
  it("serves only capability-scoped GET/HEAD assets on the Preview Host", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    const runtime = createRuntime(fixture);
    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const previewPath = new URL(session.previewUrl).pathname;
    const tokenPath = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);
    const app = previewHostApp(runtime);

    const htmlResponse = await request(app)
      .get(previewPath)
      .set("Host", "preview.localhost:3100");
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers["content-type"]).toContain("text/html");
    expect(htmlResponse.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(htmlResponse.headers["access-control-allow-origin"]).toBe("*");
    expect(htmlResponse.text).not.toContain("http-equiv=\"refresh\"");
    expect(htmlResponse.text).toContain("data-rudder-blocked-href=\"external\"");

    const cssResponse = await request(app)
      .get(`${tokenPath}styles.css`)
      .set("Host", "preview.localhost:3100");
    expect(cssResponse.status).toBe(200);
    expect(cssResponse.headers["content-type"]).toContain("text/css");
    expect(cssResponse.text).toContain("rgb(1, 2, 3)");

    const headResponse = await request(app)
      .head(`${tokenPath}script.js`)
      .set("Host", "preview.localhost:3100");
    expect(headResponse.status).toBe(200);
    expect(headResponse.text).toBeUndefined();

    const postResponse = await request(app)
      .post(previewPath)
      .set("Host", "preview.localhost:3100");
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.allow).toBe("GET, HEAD");

    const mainHostResponse = await request(app)
      .get(previewPath)
      .set("Host", "127.0.0.1:3100");
    expect(mainHostResponse.status).toBe(404);
  });

  it("keeps Connected HTML and emits the explicit connected CSP", async () => {
    const fixture = await createFixture();
    const runtime = createRuntime({ ...fixture, token: "b".repeat(43) });
    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "connected",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const response = await request(previewHostApp(runtime))
      .get(new URL(session.previewUrl).pathname)
      .set("Host", "preview.localhost:3100");

    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(response.headers["content-security-policy"]).toContain("https:");
    expect(response.text).toContain("http-equiv=\"refresh\"");
    expect(response.text).toContain("<script src=\"script.js\"></script>");
  });

  it("accepts IPv6 loopback parents when loopback access is required", async () => {
    const fixture = await createFixture();
    const runtime = createRuntime({ ...fixture, requireLoopbackParent: true });

    await expect(runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://[::1]:3100",
    })).resolves.toMatchObject({ networkMode: "offline" });
  });

  it("rejects an artifact-directory swap between validation and file open", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-web-preview-race-"));
    cleanupDirectories.push(outside);
    await fs.writeFile(path.join(outside, "styles.css"), "body { color: red; }", "utf8");
    let swapOnAssetOpen = false;
    const runtime = createRuntime({
      ...fixture,
      token: "f".repeat(43),
      beforeFileOpen: async (canonicalTarget) => {
        if (!swapOnAssetOpen || !canonicalTarget.endsWith("styles.css")) return;
        swapOnAssetOpen = false;
        await fs.rename(fixture.artifactPath, `${fixture.artifactPath}-original`);
        await fs.symlink(outside, fixture.artifactPath);
      },
    });
    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const previewPath = new URL(session.previewUrl).pathname;
    const tokenPath = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);

    swapOnAssetOpen = true;
    const response = await request(previewHostApp(runtime))
      .get(`${tokenPath}styles.css`)
      .set("Host", "preview.localhost:3100");
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("color: red");
    expect(response.text).not.toContain(outside);
  });

  it("rejects canonical aliases into protected or hidden Library roots", async () => {
    const fixture = await createFixture();
    const protectedSite = path.join(fixture.rootPath, "skills", "private-site");
    const hiddenSite = path.join(fixture.rootPath, ".hidden-site");
    await Promise.all([
      fs.mkdir(protectedSite, { recursive: true }),
      fs.mkdir(hiddenSite, { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(protectedSite, "index.html"), "protected", "utf8"),
      fs.writeFile(path.join(hiddenSite, "index.html"), "hidden", "utf8"),
      fs.symlink(protectedSite, path.join(fixture.rootPath, "artifacts", "protected-alias")),
      fs.symlink(hiddenSite, path.join(fixture.rootPath, "artifacts", "hidden-alias")),
    ]);
    const runtime = createRuntime({ ...fixture, token: "i".repeat(43) });

    await expect(runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/protected-alias/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    })).rejects.toMatchObject({ status: 422 });
    await expect(runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/hidden-alias/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    })).rejects.toMatchObject({ status: 422 });
  });

  it("rejects visible asset aliases whose canonical target is hidden", async () => {
    const fixture = await createFixture();
    const runtime = createRuntime({ ...fixture, token: "j".repeat(43) });
    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    await fs.symlink(
      path.join(fixture.artifactPath, ".secret"),
      path.join(fixture.artifactPath, "visible.txt"),
    );
    const previewPath = new URL(session.previewUrl).pathname;
    const tokenPath = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);

    const response = await request(previewHostApp(runtime))
      .get(`${tokenPath}visible.txt`)
      .set("Host", "preview.localhost:3100");
    expect(response.status).toBe(403);
    expect(response.text).not.toContain("hidden");
  });

  it("bounds entry HTML and capability assets before reading them", async () => {
    const fixture = await createFixture();
    const oversizedEntryRuntime = createRuntime({ ...fixture, token: "g".repeat(43) });
    await fs.truncate(path.join(fixture.artifactPath, "index.html"), (2 * 1024 * 1024) + 1);
    await expect(oversizedEntryRuntime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    })).rejects.toMatchObject({ status: 422 });

    await fs.writeFile(path.join(fixture.artifactPath, "index.html"), fixture.html, "utf8");
    const runtime = createRuntime({ ...fixture, token: "h".repeat(43) });
    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const previewPath = new URL(session.previewUrl).pathname;
    const tokenPath = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);
    await fs.writeFile(path.join(fixture.artifactPath, "large.bin"), "");
    await fs.truncate(path.join(fixture.artifactPath, "large.bin"), (32 * 1024 * 1024) + 1);
    const app = previewHostApp(runtime);

    expect((await request(app).get(`${tokenPath}large.bin`).set("Host", "preview.localhost:3100")).status)
      .toBe(413);
    expect((await request(app).head(`${tokenPath}large.bin`).set("Host", "preview.localhost:3100")).status)
      .toBe(413);
    expect((await request(app)
      .get(`/workspace-preview/${"z".repeat(43)}/index.html`)
      .set("Host", "preview.localhost:3100")).status).toBe(404);
  });

  it("rejects root-level entries, dotfiles, traversal, expiry, and root replacement", { timeout: 15_000 }, async () => {
    const fixture = await createFixture();
    let currentTime = Date.parse("2026-07-15T00:00:00.000Z");
    const runtime = createRuntime({ ...fixture, now: () => currentTime, token: "c".repeat(43) });

    const rootRuntime = createRuntime({ ...fixture, token: "d".repeat(43) });
    await expect(rootRuntime.createSession({
      orgId: "org-1",
      entryPath: "index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    })).rejects.toMatchObject({ status: 422 });

    const session = await runtime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const previewPath = new URL(session.previewUrl).pathname;
    const tokenPath = previewPath.slice(0, previewPath.lastIndexOf("/") + 1);
    const app = previewHostApp(runtime);

    expect((await request(app).get(`${tokenPath}.secret`).set("Host", "preview.localhost:3100")).status)
      .toBe(404);
    expect((await request(app).get(`${tokenPath}%2e%2e/secret.txt`).set("Host", "preview.localhost:3100")).status)
      .toBe(404);

    currentTime += 31 * 60 * 1000;
    expect((await request(app).get(previewPath).set("Host", "preview.localhost:3100")).status)
      .toBe(410);

    const replacementRuntime = createRuntime({ ...fixture, token: "e".repeat(43) });
    const replacementSession = await replacementRuntime.createSession({
      orgId: "org-1",
      entryPath: "artifacts/site/index.html",
      networkMode: "offline",
      parentOrigin: "http://127.0.0.1:3100",
    });
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-web-preview-outside-"));
    cleanupDirectories.push(outside);
    await fs.writeFile(path.join(outside, "index.html"), "outside", "utf8");
    await fs.rename(fixture.artifactPath, `${fixture.artifactPath}-original`);
    await fs.symlink(outside, fixture.artifactPath);

    const replacementResponse = await request(previewHostApp(replacementRuntime))
      .get(new URL(replacementSession.previewUrl).pathname)
      .set("Host", "preview.localhost:3100");
    expect(replacementResponse.status).toBe(403);
    expect(replacementResponse.text).not.toContain(outside);
  });
});
