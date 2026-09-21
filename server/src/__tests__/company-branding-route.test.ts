import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { organizationRoutes, type RustFoundationProbeReceipt } from "../routes/orgs.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const mockCompanyService = vi.hoisted(() => ({
  list: vi.fn(),
  stats: vi.fn(),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  remove: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  ensureMembership: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockCompanyPortabilityService = vi.hoisted(() => ({
  exportBundle: vi.fn(),
  previewExport: vi.fn(),
  previewImport: vi.fn(),
  importBundle: vi.fn(),
}));

const mockOrganizationSkillService = vi.hoisted(() => ({
  syncWorkspaceFileChange: vi.fn(),
}));
const mockResourceCatalogService = vi.hoisted(() => ({
  listOrganizationResources: vi.fn(),
  createOrganizationResource: vi.fn(),
  updateOrganizationResource: vi.fn(),
  deleteOrganizationResource: vi.fn(),
}));
const mockDocumentService = vi.hoisted(() => ({
  listLibraryDocuments: vi.fn(),
  createLibraryDocument: vi.fn(),
  getLibraryDocumentById: vi.fn(),
  updateLibraryDocument: vi.fn(),
  deleteLibraryDocument: vi.fn(),
}));
const mockWorkspaceBackupService = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  restore: vi.fn(),
  remove: vi.fn(),
}));
const mockWorkspaceBrowser = vi.hoisted(() => ({
  listFiles: vi.fn(),
  readFile: vi.fn(),
  readAttachmentFile: vi.fn(),
  createFile: vi.fn(),
  writeFile: vi.fn(),
}));
const mockOrganizationMemberService = vi.hoisted(() => ({
  list: vi.fn(),
  countActiveVisible: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown> | null | undefined) => ({
    config: config ?? {},
  })),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  organizationExportJobService: () => ({
    create: vi.fn(),
    get: vi.fn(),
    getResult: vi.fn(),
    cancel: vi.fn(),
  }),
  organizationPortabilityService: () => mockCompanyPortabilityService,
  organizationSkillService: () => mockOrganizationSkillService,
  resourceCatalogService: () => mockResourceCatalogService,
  documentService: () => mockDocumentService,
  workspaceBackupService: () => mockWorkspaceBackupService,
  organizationService: () => mockCompanyService,
  secretService: () => mockSecretService,
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
  organizationMemberService: () => mockOrganizationMemberService,
  logActivity: mockLogActivity,
}));
vi.mock("../services/organization-workspace-browser.js", () => ({
  organizationWorkspaceBrowserService: () => mockWorkspaceBrowser,
}));

function createOrganization() {
  const now = new Date("2026-03-19T02:00:00.000Z");
  return {
    id: "organization-1",
    name: "Rudder",
    description: null,
    status: "active",
    issuePrefix: "PAP",
    issueCounter: 568,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: "#123456",
    logoAssetId: "11111111-1111-4111-8111-111111111111",
    logoUrl: "/api/assets/11111111-1111-4111-8111-111111111111/content",
    createdAt: now,
    updatedAt: now,
  };
}

const activeServers = new Set<Server>();

async function createApp(
  actor: Record<string, unknown>,
  rustFoundationBridge?: RustFoundationBridge,
  onRustFoundationProbe?: (receipt: RustFoundationProbeReceipt) => void,
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api/orgs",
    organizationRoutes({} as any, undefined, undefined, rustFoundationBridge, { onRustFoundationProbe }),
  );
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

afterEach(async () => {
  await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  activeServers.clear();
});

describe("PATCH /api/orgs/:orgId/branding", () => {
  beforeEach(() => {
    mockCompanyService.update.mockReset();
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
    mockOrganizationMemberService.list.mockReset();
  });

  it("rejects non-CEO agent callers", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({ logoAssetId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("allows CEO agent callers to update branding fields", async () => {
    const organization = createOrganization();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "ceo",
    });
    mockCompanyService.update.mockResolvedValue(organization);
    const app = await createApp({
      type: "agent",
      agentId: "agent-1",
      orgId: "organization-1",
      source: "agent_key",
      runId: "run-1",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        brandColor: "#123456",
      });

    expect(res.status).toBe(200);
    expect(res.body.logoAssetId).toBe(organization.logoAssetId);
    expect(mockCompanyService.update).toHaveBeenCalledWith("organization-1", {
      logoAssetId: "11111111-1111-4111-8111-111111111111",
      brandColor: "#123456",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "organization-1",
        actorType: "agent",
        actorId: "agent-1",
        agentId: "agent-1",
        runId: "run-1",
        action: "organization.branding_updated",
        details: {
          logoAssetId: "11111111-1111-4111-8111-111111111111",
          brandColor: "#123456",
        },
      }),
    );
  });

  it("allows board callers to update branding fields", async () => {
    const organization = createOrganization();
    mockCompanyService.update.mockResolvedValue({
      ...organization,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({ brandColor: null, logoAssetId: null });

    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBeNull();
    expect(res.body.logoAssetId).toBeNull();
  });

  it("rejects non-branding fields in the request body", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({
        logoAssetId: "11111111-1111-4111-8111-111111111111",
        status: "archived",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation error");
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });
});

describe("GET /api/orgs/:orgId/members/directory Rust bridge", () => {
  beforeEach(() => {
    mockOrganizationMemberService.list.mockReset();
  });

  function bridge(mode: "shadow" | "required", response: unknown): RustFoundationBridge {
    return {
      mode,
      start: vi.fn(),
      memberDirectory: vi.fn().mockResolvedValue(response),
      close: vi.fn(),
    } as unknown as RustFoundationBridge;
  }

  const page = {
    total: 1,
    items: [{ name: "Operator", type: "human", role: "owner", ref: "usr_operator" }],
    nextCursor: null,
    hasMore: false,
  };

  it("forwards required reads to Actix and never invokes the Node read service", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(page)),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      sessionId: "session-1",
      authEpoch: 1,
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .get("/api/orgs/organization-1/members/directory?type=all&limit=1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(rustBridge.memberDirectory).toHaveBeenCalledWith(
      expect.objectContaining({ originalUrl: "/api/orgs/organization-1/members/directory?type=all&limit=1" }),
      "organization-1",
    );
    expect(mockOrganizationMemberService.list).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({
      orgId: "organization-1",
      probeMode: "required",
      rustInvoked: true,
      responseAuthority: "rust",
      fallbackReason: null,
      oldAuthorityInvoked: false,
      status: 200,
    })]);
  });

  it("fails closed with an explicit unavailable response when required Actix is down", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", null);
    vi.mocked(rustBridge.memberDirectory).mockRejectedValueOnce(new Error("bridge unavailable"));
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .get("/api/orgs/organization-1/members/directory");

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Rust member directory is unavailable",
      code: "rust_foundation_member_directory_unavailable",
    });
    expect(mockOrganizationMemberService.list).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "required",
      rustInvoked: true,
      responseAuthority: "none",
      fallbackReason: "required_bridge_request_failed",
      oldAuthorityInvoked: false,
      status: null,
    })]);
  });

  it("maps a required Rust error into the Node error response shape", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", {
      status: 422,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({
        schema: "rudder.native.server.error.v1",
        status: "error",
        reason: "member_directory_invalid_limit",
      })),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .get("/api/orgs/organization-1/members/directory?limit=bad");

    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "member_directory_invalid_limit" });
    expect(mockOrganizationMemberService.list).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "required",
      responseAuthority: "rust",
      fallbackReason: null,
      oldAuthorityInvoked: false,
      status: 422,
    })]);
  });

  it("keeps the Node result as an explicit shadow fallback while comparing Rust output", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    mockOrganizationMemberService.list.mockResolvedValueOnce(page);
    const rustBridge = bridge("shadow", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(page)),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .get("/api/orgs/organization-1/members/directory");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(rustBridge.memberDirectory).toHaveBeenCalledOnce();
    expect(mockOrganizationMemberService.list).toHaveBeenCalledOnce();
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "shadow",
      rustInvoked: true,
      responseAuthority: "node",
      fallbackReason: "shadow_probe_only",
      oldAuthority: "node",
      oldAuthorityInvoked: true,
      status: 200,
    })]);
  });
});

describe("organization workspace file agent access", () => {
  beforeEach(() => {
    mockAgentService.getById.mockReset();
    mockLogActivity.mockReset();
    mockOrganizationSkillService.syncWorkspaceFileChange.mockReset();
    mockWorkspaceBrowser.listFiles.mockReset();
    mockWorkspaceBrowser.readFile.mockReset();
    mockWorkspaceBrowser.readAttachmentFile.mockReset();
    mockWorkspaceBrowser.createFile.mockReset();
    mockWorkspaceBrowser.writeFile.mockReset();
  });

  it("limits agent workspace file reads to project Library paths", async () => {
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/files?path=agents");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:projects/<project-key>/...");
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("rejects agent workspace file reads that traverse out of project Library paths", async () => {
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app).get("/api/orgs/organization-1/workspace/files?path=projects/../agents");

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:projects/<project-key>/...");
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("limits agent workspace file writes to project Library paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "skills/agent-team-design.md", content: "# Design\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:projects/<project-key>/...");
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("rejects agent workspace file writes directly under the projects root", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "projects/spec.md", content: "# Spec\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:projects/<project-key>/...");
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("rejects agent workspace file writes that traverse out of project Library paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "projects/../skills/agent-team-design.md", content: "# Design\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:projects/<project-key>/...");
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("allows agent workspace file writes to the no-project artifacts fallback", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    mockWorkspaceBrowser.createFile.mockResolvedValue({
      filePath: "artifacts/2026-06-30/rudder-mcp-tools-report/rudder-mcp-tools-report.md",
      name: "rudder-mcp-tools-report.md",
      isDirectory: false,
      content: "# Rudder MCP Tools Report\n",
      contentType: "text/markdown",
      previewKind: "text",
      contentPath: null,
      mentionHref: "library-entry://entry-1?p=artifacts%2F2026-06-30%2Frudder-mcp-tools-report%2Frudder-mcp-tools-report.md",
      markdownLink: "[rudder-mcp-tools-report.md](library-entry://entry-1?p=artifacts%2F2026-06-30%2Frudder-mcp-tools-report%2Frudder-mcp-tools-report.md)",
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({
        filePath: "artifacts/2026-06-30/rudder-mcp-tools-report/rudder-mcp-tools-report.md",
        content: "# Rudder MCP Tools Report\n",
      });

    expect(res.status).toBe(201);
    expect(res.body).toBeDefined();
  });

  it("allows agent workspace file reads from the no-project artifacts fallback", async () => {
    mockWorkspaceBrowser.listFiles.mockResolvedValue({
      path: "artifacts/2026-06-30/rudder-mcp-tools-report",
      parentPath: "artifacts/2026-06-30",
      entries: [],
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .get("/api/orgs/organization-1/workspace/files?path=artifacts%2F2026-06-30%2Frudder-mcp-tools-report");

    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
  });

  it("rejects malformed agent artifacts fallback paths", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = await createApp({
      type: "agent",
      orgId: "organization-1",
      agentId: "agent-1",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({ filePath: "artifacts/rudder-mcp-tools-report.md", content: "# Report\n" });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("library:artifacts/YYYY-MM-DD/<conversation-title>/...");
  });

  it("rejects embedded image data URLs when creating workspace files", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .post("/api/orgs/organization-1/workspace/file")
      .send({
        filePath: "docs/screenshot.md",
        content: "![Screenshot](data:image/svg+xml,%3Csvg%3E%3C/svg%3E)\n",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Embedded image data URLs are not allowed");
  });

  it("rejects embedded image data URLs when updating workspace files", async () => {
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    });

    const res = await request(app)
      .patch("/api/orgs/organization-1/workspace/file?path=docs%2Fscreenshot.md")
      .send({
        content: "![Screenshot](data:image/jpeg;base64,/9j/4AAQSkZJRg==)\n",
      });

    expect(res.status).toBe(422);
    expect(res.body.error).toContain("Embedded image data URLs are not allowed");
    expect(mockOrganizationSkillService.syncWorkspaceFileChange).not.toHaveBeenCalled();
  });
});
