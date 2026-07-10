import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "../attachment-types.js";
import { assetRoutes } from "../routes/assets.js";
import type { StorageService } from "../storage/types.js";

const { createAssetMock, getAssetByIdMock, logActivityMock } = vi.hoisted(() => ({
  createAssetMock: vi.fn(),
  getAssetByIdMock: vi.fn(),
  logActivityMock: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  assetService: vi.fn(() => ({
    create: createAssetMock,
    getById: getAssetByIdMock,
  })),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  logActivity: logActivityMock,
}));

function createAsset(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "asset-1",
    orgId: "organization-1",
    provider: "local",
    objectKey: "assets/abc",
    contentType: "image/png",
    byteSize: 40,
    sha256: "sha256-sample",
    originalFilename: "logo.png",
    createdByAgentId: null,
    createdByUserId: "user-1",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createStorageService(contentType = "image/png"): StorageService {
  const putFile: StorageService["putFile"] = vi.fn(async (input: {
    orgId: string;
    namespace: string;
    originalFilename: string | null;
    contentType: string;
    body: Buffer;
  }) => {
    return {
      provider: "local_disk" as const,
      objectKey: `${input.namespace}/${input.originalFilename ?? "upload"}`,
      contentType: contentType || input.contentType,
      byteSize: input.body.length,
      sha256: "sha256-sample",
      originalFilename: input.originalFilename,
    };
  });

  return {
    provider: "local_disk" as const,
    putFile,
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function createApp(storage: ReturnType<typeof createStorageService>) {
  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", assetRoutes({} as any, storage));
  return app;
}

describe("POST /api/orgs/:orgId/assets/images", () => {
  afterEach(() => {
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG image uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/orgs/organization-1/assets/images")
      .field("namespace", "goals")
      .attach("file", Buffer.from("png"), "logo.png");

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.putFile).toHaveBeenCalledWith({
      orgId: "organization-1",
      namespace: "assets/goals",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it.each([
    ["text/plain", "note.txt"],
    ["text/html", "page.html"],
    ["image/svg+xml", "image.svg"],
  ])("rejects non-raster uploads with type %s", async (contentType, filename) => {
    const text = createStorageService("text/plain");
    const app = createApp(text);

    const res = await request(app)
      .post("/api/orgs/organization-1/assets/images")
      .field("namespace", "issues/drafts")
      .attach("file", Buffer.from("untrusted"), { filename, contentType });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Unsupported file type: ${contentType}`);
    expect(text.putFile).not.toHaveBeenCalled();
  });
});

describe("POST /api/orgs/:orgId/logo", () => {
  afterEach(() => {
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("accepts PNG logo uploads and returns an asset path", async () => {
    const png = createStorageService("image/png");
    const app = createApp(png);

    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/orgs/organization-1/logo")
      .attach("file", Buffer.from("png"), "logo.png");

    expect(res.status).toBe(201);
    expect(res.body.contentPath).toBe("/api/assets/asset-1/content");
    expect(createAssetMock).toHaveBeenCalledTimes(1);
    expect(png.putFile).toHaveBeenCalledWith({
      orgId: "organization-1",
      namespace: "assets/orgs",
      originalFilename: "logo.png",
      contentType: "image/png",
      body: expect.any(Buffer),
    });
  });

  it("rejects SVG logo uploads", async () => {
    const svg = createStorageService("image/svg+xml");
    const app = createApp(svg);

    const res = await request(app)
      .post("/api/orgs/organization-1/logo")
      .attach(
        "file",
        Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'><script>alert(1)</script><a href='https://evil.example/'><circle cx='12' cy='12' r='10'/></a></svg>",
        ),
        "logo.svg",
      );

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: image/svg+xml");
    expect(svg.putFile).not.toHaveBeenCalled();
  });

  it("allows logo uploads within the general attachment limit", async () => {
    const png = createStorageService("image/png");
    const app = createApp(png);
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(150 * 1024, "a");
    const res = await request(app)
      .post("/api/orgs/organization-1/logo")
      .attach("file", file, "within-limit.png");

    expect(res.status).toBe(201);
  });

  it("rejects logo files larger than the general attachment limit", async () => {
    const app = createApp(createStorageService());
    createAssetMock.mockResolvedValue(createAsset());

    const file = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1, "a");
    const res = await request(app)
      .post("/api/orgs/organization-1/logo")
      .attach("file", file, "too-large.png");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe(`Image exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
  });

  it("rejects unsupported image types", async () => {
    const app = createApp(createStorageService("text/plain"));
    createAssetMock.mockResolvedValue(createAsset());

    const res = await request(app)
      .post("/api/orgs/organization-1/logo")
      .attach("file", Buffer.from("not an image"), "note.txt");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported image type: text/plain");
    expect(createAssetMock).not.toHaveBeenCalled();
  });

});

describe("GET /api/assets/:assetId/content", () => {
  afterEach(() => {
    createAssetMock.mockReset();
    getAssetByIdMock.mockReset();
    logActivityMock.mockReset();
  });

  it("serves safe raster images inline with MIME sniffing disabled", async () => {
    const body = Buffer.from("png");
    const storage = createStorageService("image/png");
    getAssetByIdMock.mockResolvedValue(createAsset({ byteSize: body.length }));
    vi.mocked(storage.getObject).mockResolvedValue({
      stream: Readable.from(body),
      contentType: "image/png",
      contentLength: body.length,
    });

    const res = await request(createApp(storage)).get("/api/assets/asset-1/content");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('inline; filename="logo.png"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });

  it("forces legacy active content to download under a restrictive sandbox", async () => {
    const body = Buffer.from("<script>alert(1)</script>");
    const storage = createStorageService("text/html");
    getAssetByIdMock.mockResolvedValue(createAsset({
      byteSize: body.length,
      contentType: "text/html",
      originalFilename: "payload.html",
    }));
    vi.mocked(storage.getObject).mockResolvedValue({
      stream: Readable.from(body),
      contentType: "text/html",
      contentLength: body.length,
    });

    const res = await request(createApp(storage)).get("/api/assets/asset-1/content");

    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="payload.html"');
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    );
  });
});
