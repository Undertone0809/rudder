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
const mockHandoffOrganizationBrandingAuthority = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
vi.mock("../services/organization-branding-fence.js", () => ({
  handoffOrganizationBrandingAuthority: mockHandoffOrganizationBrandingAuthority,
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
    mockHandoffOrganizationBrandingAuthority.mockReset();
    mockHandoffOrganizationBrandingAuthority.mockResolvedValue(undefined);
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

  function bridge(
    mode: "off" | "shadow" | "required",
    response: unknown,
    organizationBrandingMode: "off" | "shadow" | "required" = "off",
  ): RustFoundationBridge {
    return {
      mode,
      organizationBrandingMode,
      requiresStartup: false,
      start: vi.fn(),
      memberDirectory: vi.fn().mockResolvedValue(response),
      organizationBranding: vi.fn().mockResolvedValue(response),
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
      "/api/orgs/organization-1/members/directory?type=all&limit=1",
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

  it("fails closed when the member-directory bridge is not wired", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, undefined, (receipt) => receipts.push(receipt));

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
      rustInvoked: false,
      responseAuthority: "none",
      fallbackReason: "required_bridge_missing",
      oldAuthority: null,
      oldAuthorityInvoked: false,
      status: null,
    })]);
  });

  it("maps a required Rust error into the Node error response shape", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", {
      status: 400,
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
      .get("/api/orgs/organization-1/members/directory?limit=1");

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "'limit' must be between 1 and 100" });
    expect(mockOrganizationMemberService.list).not.toHaveBeenCalled();
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "required",
      responseAuthority: "rust",
      fallbackReason: null,
      oldAuthorityInvoked: false,
      status: 400,
    })]);
  });

  it("keeps Node as the response authority in legacy shadow mode", async () => {
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
    expect(mockOrganizationMemberService.list).toHaveBeenCalledWith({
      orgId: "organization-1",
      query: null,
      type: "all",
      limit: undefined,
      cursor: null,
      fullIds: false,
    });
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

  it("keeps Node as the response authority when the bridge is explicitly off", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    mockOrganizationMemberService.list.mockResolvedValueOnce(page);
    const rustBridge = bridge("off", {
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
    expect(rustBridge.memberDirectory).not.toHaveBeenCalled();
    expect(mockOrganizationMemberService.list).toHaveBeenCalledWith({
      orgId: "organization-1",
      query: null,
      type: "all",
      limit: undefined,
      cursor: null,
      fullIds: false,
    });
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "off",
      rustInvoked: false,
      responseAuthority: "node",
      fallbackReason: "mode_off",
      oldAuthority: "node",
      oldAuthorityInvoked: true,
      status: 200,
    })]);
  });

  it("normalizes duplicate query parameters before Rust while preserving Node filters", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    mockOrganizationMemberService.list.mockResolvedValueOnce(page);
    const rustBridge = bridge("required", {
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
      .get("/api/orgs/organization-1/members/directory?type=human&type=agent&query=Operator&query=Other&limit=01&fullIds=true&fullIds=false");

    expect(res.status).toBe(200);
    expect(mockOrganizationMemberService.list).not.toHaveBeenCalled();
    expect(rustBridge.memberDirectory).toHaveBeenCalledWith(
      expect.anything(),
      "organization-1",
      "/api/orgs/organization-1/members/directory?type=all&limit=1",
    );
    expect(receipts).toEqual([expect.objectContaining({
      probeMode: "required",
      responseAuthority: "rust",
      oldAuthorityInvoked: false,
    })]);
  });

  it("preserves Express malformed query decoding when normalizing the Rust request", async () => {
    const rustBridge = bridge("required", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(page)),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge);

    const res = await request(app)
      .get("/api/orgs/organization-1/members/directory?query=%E0%A4%A");

    expect(res.status).toBe(200);
    expect(rustBridge.memberDirectory).toHaveBeenCalledWith(
      expect.anything(),
      "organization-1",
      "/api/orgs/organization-1/members/directory?type=all&query=%EF%BF%BD%25A",
    );
  });

  it("canonicalizes Node-accepted padded cursors before forwarding to Rust", async () => {
    const cursorPayload = { name: "Agent", type: "agent", principalId: "agent-1" };
    const canonicalCursor = Buffer.from(JSON.stringify(cursorPayload), "utf8").toString("base64url");
    const paddedCursor = `${canonicalCursor}=`;
    const rustBridge = bridge("required", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(page)),
    });
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge);

    const res = await request(app)
      .get(`/api/orgs/organization-1/members/directory?cursor=${encodeURIComponent(paddedCursor)}`);

    expect(res.status).toBe(200);
    expect(rustBridge.memberDirectory).toHaveBeenCalledWith(
      expect.anything(),
      "organization-1",
      `/api/orgs/organization-1/members/directory?type=all&cursor=${encodeURIComponent(canonicalCursor)}`,
    );
  });

  it("routes dedicated branding writes to Rust and does not invoke the Node writer", async () => {
    const organization = createOrganization();
    const receipts: RustFoundationProbeReceipt[] = [];
    mockCompanyService.getById.mockResolvedValue({
      ...organization,
      name: "Rust Rudder",
      brandColor: "#abcdef",
    });
    const rustBridge = bridge("required", {
      status: 200,
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ status: "applied" })),
    }, "required");
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      sessionId: "session-1",
      authEpoch: 3,
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .set("x-rudder-idempotency-key", "branding-route-test")
      .send({ brandColor: "#abcdef" });

    expect(res.status).toBe(200);
    expect(res.body.brandColor).toBe("#abcdef");
    expect(rustBridge.organizationBranding).toHaveBeenCalledWith(
      expect.objectContaining({ originalUrl: "/api/orgs/organization-1/branding" }),
      "organization-1",
      Buffer.from(JSON.stringify({ brandColor: "#abcdef" }), "utf8"),
      "/api/orgs/organization-1/branding",
    );
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(receipts).toEqual([{
      orgId: "organization-1",
      requestId: null,
      probeMode: "required",
      rustInvoked: true,
      responseAuthority: "rust",
      fallbackReason: null,
      oldAuthority: null,
      oldAuthorityInvoked: false,
      status: 200,
    }]);
  });

  it("fails closed when required Rust branding is unavailable", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", null, "required");
    vi.mocked(rustBridge.organizationBranding).mockRejectedValueOnce(new Error("bridge unavailable"));
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .set("x-rudder-idempotency-key", "branding-unavailable-test")
      .send({ brandColor: "#abcdef" });

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "Rust organization branding is unavailable",
      code: "rust_foundation_organization_branding_request_failed",
    });
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(receipts).toEqual([{
      orgId: "organization-1",
      requestId: null,
      probeMode: "required",
      rustInvoked: true,
      responseAuthority: "none",
      fallbackReason: "required_bridge_request_failed",
      oldAuthority: null,
      oldAuthorityInvoked: false,
      status: null,
    }]);
  });

  it("rejects required Rust branding without an idempotency key", async () => {
    const receipts: RustFoundationProbeReceipt[] = [];
    const rustBridge = bridge("required", null, "required");
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge, (receipt) => receipts.push(receipt));

    const res = await request(app)
      .patch("/api/orgs/organization-1/branding")
      .send({ brandColor: "#abcdef" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("x-rudder-idempotency-key is required");
    expect(rustBridge.organizationBranding).not.toHaveBeenCalled();
    expect(mockCompanyService.update).not.toHaveBeenCalled();
    expect(receipts).toEqual([]);
  });

  it("rejects a mixed generic organization patch instead of partially writing it", async () => {
    const rustBridge = bridge("required", null, "required");
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge);

    const res = await request(app)
      .patch("/api/orgs/organization-1")
      .send({ name: "Rust Rudder", brandColor: "#abcdef", budgetMonthlyCents: 1000 });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("separate requests");
    expect(rustBridge.organizationBranding).not.toHaveBeenCalled();
    expect(mockCompanyService.update).not.toHaveBeenCalled();
  });

  it("keeps non-branding generic organization settings on the Node path", async () => {
    const organization = createOrganization();
    mockCompanyService.update.mockResolvedValue({ ...organization, budgetMonthlyCents: 1000 });
    const rustBridge = bridge("required", null, "required");
    const app = await createApp({
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    }, rustBridge);

    const res = await request(app)
      .patch("/api/orgs/organization-1")
      .send({ budgetMonthlyCents: 1000 });

    expect(res.status).toBe(200);
    expect(res.body.budgetMonthlyCents).toBe(1000);
    expect(rustBridge.organizationBranding).not.toHaveBeenCalled();
    expect(mockCompanyService.update).toHaveBeenCalledWith("organization-1", { budgetMonthlyCents: 1000 });
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
