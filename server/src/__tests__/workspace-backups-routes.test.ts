import express from "express";
import { Readable } from "node:stream";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { organizationRoutes } from "../routes/orgs.js";

const mockWorkspaceBackupService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  getDownload: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    ensureMembership: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  budgetService: () => ({
    upsertPolicy: vi.fn(),
  }),
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
  organizationSkillService: () => ({
    syncWorkspaceFileChange: vi.fn(),
  }),
  resourceCatalogService: () => ({
    listOrganizationResources: vi.fn(),
    createOrganizationResource: vi.fn(),
    updateOrganizationResource: vi.fn(),
    deleteOrganizationResource: vi.fn(),
  }),
  secretService: () => ({
    normalizeAdapterConfigForPersistence: vi.fn(async (_orgId, config) => ({ config: config ?? {} })),
  }),
  workspaceBackupService: () => mockWorkspaceBackupService,
}));

function createApp(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api/orgs", organizationRoutes({} as any));
  app.use(errorHandler);
  return app;
}

describe("workspace backup download route", () => {
  beforeEach(() => {
    mockWorkspaceBackupService.getDownload.mockReset();
  });

  it("downloads the selected backup zip with attachment headers", async () => {
    const content = Buffer.from("PK\u0003\u0004workspace.zip", "utf8");
    mockWorkspaceBackupService.getDownload.mockResolvedValue({
      artifactRef: "/tmp/.rudder-backups/workspace-20260621.json",
      filename: "workspace-20260621.zip",
      contentType: "application/zip",
      byteSize: content.byteLength,
      archiveSha256: "abc123",
      content,
    });
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/backups/backup-1/download");

    expect(res.status).toBe(200);
    expect(res.header["content-type"]).toContain("application/zip");
    expect(res.header["content-length"]).toBe(String(content.byteLength));
    expect(res.header["cache-control"]).toBe("private, max-age=60");
    expect(res.header["x-content-type-options"]).toBe("nosniff");
    expect(res.header["x-rudder-archive-sha256"]).toBe("abc123");
    expect(res.header["content-disposition"]).toBe("attachment; filename=\"workspace-20260621.zip\"");
    expect(res.text).toBe(content.toString("utf8"));
    expect(mockWorkspaceBackupService.getDownload).toHaveBeenCalledWith("organization-1", "backup-1");
  });

  it("streams a file-backed v2 archive through the public response", async () => {
    const content = Buffer.from("streamed-v2-archive");
    mockWorkspaceBackupService.getDownload.mockResolvedValue({
      artifactRef: "/tmp/workspace.zip",
      filename: "workspace.zip",
      contentType: "application/zip",
      byteSize: content.byteLength,
      archiveSha256: "def456",
      contentStream: Readable.from([content.subarray(0, 8), content.subarray(8)]),
    });
    const app = createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    const res = await request(app)
      .get("/api/orgs/organization-1/workspace/backups/backup-1/download")
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.header["content-length"]).toBe(String(content.byteLength));
    expect(res.header["x-rudder-archive-sha256"]).toBe("def456");
    expect(res.body).toEqual(content);
  });

  it("terminates the public response when the file-backed source fails after headers", async () => {
    const source = new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(new Error("injected archive read failure"));
      },
    });
    mockWorkspaceBackupService.getDownload.mockResolvedValue({
      artifactRef: "/tmp/workspace.zip",
      filename: "workspace.zip",
      contentType: "application/zip",
      byteSize: 100,
      archiveSha256: "def456",
      contentStream: source,
    });
    const app = createApp({ type: "board", userId: "user-1", source: "local_implicit" });

    await expect(request(app).get("/api/orgs/organization-1/workspace/backups/backup-1/download"))
      .rejects.toThrow(/aborted|closed|socket hang up/i);
  });

  it("rejects agent callers before reading backup artifacts", async () => {
    const app = createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/backups/backup-1/download");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board access required");
    expect(mockWorkspaceBackupService.getDownload).not.toHaveBeenCalled();
  });

  it("returns artifact validation errors without streaming untrusted content", async () => {
    mockWorkspaceBackupService.getDownload.mockRejectedValue(
      unprocessable("Workspace backup artifact checksum does not match the recorded backup metadata"),
    );
    const app = createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/backups/backup-1/download");

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Workspace backup artifact checksum does not match the recorded backup metadata");
    expect(res.header["content-disposition"]).toBeUndefined();
  });
});
