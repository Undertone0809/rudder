import express from "express";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { organizationRoutes } from "../routes/orgs.js";

const mockWorkspaceBrowser = vi.hoisted(() => ({
  resolveContentFile: vi.fn(),
  listMentionableFiles: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({ canUser: vi.fn(), ensureMembership: vi.fn() }),
  agentService: () => ({ getById: vi.fn() }),
  budgetService: () => ({ upsertPolicy: vi.fn() }),
  documentService: () => ({
    listLibraryDocuments: vi.fn(),
    createLibraryDocument: vi.fn(),
    getLibraryDocumentById: vi.fn(),
    updateLibraryDocument: vi.fn(),
    deleteLibraryDocument: vi.fn(),
  }),
  logActivity: vi.fn(),
  organizationExportJobService: () => ({
    create: vi.fn(),
    get: vi.fn(),
    getResult: vi.fn(),
    cancel: vi.fn(),
  }),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  organizationMemberService: () => ({ list: vi.fn(), countActiveVisible: vi.fn() }),
  organizationPortabilityService: () => ({
    exportBundle: vi.fn(),
    previewExport: vi.fn(),
    previewImport: vi.fn(),
    importBundle: vi.fn(),
  }),
  organizationService: () => ({
    list: vi.fn(),
    stats: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    archive: vi.fn(),
    remove: vi.fn(),
  }),
  organizationSkillService: () => ({ syncWorkspaceFileChange: vi.fn() }),
  resourceCatalogService: () => ({
    listOrganizationResources: vi.fn(),
    createOrganizationResource: vi.fn(),
    updateOrganizationResource: vi.fn(),
    deleteOrganizationResource: vi.fn(),
  }),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_orgId, config) => ({ config: config ?? {} })),
  }),
  workspaceBackupService: () => ({
    list: vi.fn(),
    create: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    getDownload: vi.fn(),
    restore: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("../services/organization-workspace-browser.js", () => ({
  organizationWorkspaceBrowserService: () => mockWorkspaceBrowser,
}));

const temporaryDirectories = new Set<string>();
const activeServers = new Set<Server>();

async function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/orgs", organizationRoutes({} as any));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

async function binaryParser(response: NodeJS.ReadableStream, callback: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = [];
  response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  response.on("end", () => callback(null, Buffer.concat(chunks)));
  response.on("error", callback);
}

describe("organization workspace media content route", () => {
  let mediaPath: string;
  const mediaBytes = Buffer.from("0123456789abcdef", "utf8");

  beforeEach(async () => {
    mockWorkspaceBrowser.resolveContentFile.mockReset();
    mockWorkspaceBrowser.listMentionableFiles.mockReset();
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-media-route-"));
    temporaryDirectories.add(temporaryDirectory);
    mediaPath = path.join(temporaryDirectory, "sample.mp4");
    await fs.writeFile(mediaPath, mediaBytes);
    mockWorkspaceBrowser.resolveContentFile.mockResolvedValue({
      normalizedPath: "media/sample.mp4",
      originalFilename: "sample.mp4",
      contentType: "video/mp4",
      resolvedPath: mediaPath,
      byteSize: mediaBytes.byteLength,
    });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
    await Promise.all(Array.from(temporaryDirectories, async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
      temporaryDirectories.delete(directory);
    }));
  });

  it("streams a complete inline media response with seek and safety headers", async () => {
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const response = await request(app)
      .get("/api/orgs/organization-1/workspace/file/content?path=media%2Fsample.mp4")
      .buffer(true)
      .parse(binaryParser);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(mediaBytes);
    expect(response.headers["content-type"]).toContain("video/mp4");
    expect(response.headers["content-length"]).toBe(String(mediaBytes.byteLength));
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-disposition"]).toBe("inline; filename=\"sample.mp4\"");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toBe("private, max-age=60");
  });

  it("returns full metadata without a response body for HEAD", async () => {
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const response = await request(app)
      .head("/api/orgs/organization-1/workspace/file/content?path=media%2Fsample.mp4");

    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe(String(mediaBytes.byteLength));
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.body).toEqual({});
  });

  it("propagates an HTTP disconnect to mention-file listing", async () => {
    let resolveAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => {
      resolveAbort = resolve;
    });
    mockWorkspaceBrowser.listMentionableFiles.mockImplementation((_orgId, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        resolveAbort();
        reject(new Error("client disconnected"));
      }, { once: true });
    }));

    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const address = app.address();
    expect(address && typeof address !== "string").toBe(true);
    if (!address || typeof address === "string") return;

    const client = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/api/orgs/organization-1/workspace/mention-files",
      method: "GET",
    }, (response) => response.resume());
    client.on("error", () => undefined);
    client.end();
    setTimeout(() => client.destroy(), 25);

    await abortObserved;
    expect(mockWorkspaceBrowser.listMentionableFiles).toHaveBeenCalledWith(
      "organization-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([
    ["bytes=2-5", "2345", "bytes 2-5/16"],
    ["bytes=10-", "abcdef", "bytes 10-15/16"],
    ["bytes=-4", "cdef", "bytes 12-15/16"],
    ["bytes=12-99", "cdef", "bytes 12-15/16"],
  ])("serves the single range %s", async (range, expectedBody, expectedContentRange) => {
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const response = await request(app)
      .get("/api/orgs/organization-1/workspace/file/content?path=media%2Fsample.mp4")
      .set("Range", range)
      .buffer(true)
      .parse(binaryParser);

    expect(response.status).toBe(206);
    expect(response.body.toString("utf8")).toBe(expectedBody);
    expect(response.headers["content-range"]).toBe(expectedContentRange);
    expect(response.headers["content-length"]).toBe(String(Buffer.byteLength(expectedBody)));
  });

  it.each(["bytes=16-", "bytes=8-4", "bytes=-0", "bytes=0-1,4-5", "items=0-1"])(
    "returns 416 for the invalid or unsatisfiable range %s",
    async (range) => {
      const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
      const response = await request(app)
        .get("/api/orgs/organization-1/workspace/file/content?path=media%2Fsample.mp4")
        .set("Range", range);

      expect(response.status).toBe(416);
      expect(response.headers["content-range"]).toBe("bytes */16");
      expect(response.headers["content-length"]).toBe("0");
    },
  );

  it("rejects non-preview content before opening a stream", async () => {
    mockWorkspaceBrowser.resolveContentFile.mockResolvedValue({
      normalizedPath: "archives/sample.zip",
      originalFilename: "sample.zip",
      contentType: "application/zip",
      resolvedPath: mediaPath,
      byteSize: mediaBytes.byteLength,
    });
    const app = await createApp({ type: "board", userId: "user-1", source: "local_implicit" });
    const response = await request(app)
      .get("/api/orgs/organization-1/workspace/file/content?path=archives%2Fsample.zip");

    expect(response.status).toBe(415);
    expect(response.body.error).toBe("Workspace file is not an inline preview");
  });

  it("preserves organization authorization before resolving media", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });
    const response = await request(app)
      .get("/api/orgs/organization-2/workspace/file/content?path=media%2Fsample.mp4");

    expect(response.status).toBe(403);
    expect(mockWorkspaceBrowser.resolveContentFile).not.toHaveBeenCalled();
  });
});
