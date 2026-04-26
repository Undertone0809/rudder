import express from "express";
import request from "supertest";
import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import type { StorageService } from "../storage/types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const agentId = "11111111-1111-4111-8111-111111111111";
const assetId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const baseAgent = {
  id: agentId,
  orgId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  agentRuntimeType: "process",
  agentRuntimeConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-26T00:00:00.000Z"),
  updatedAt: new Date("2026-04-26T00:00:00.000Z"),
};

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  resolveByReference: vi.fn(),
  update: vi.fn(),
  getChainOfCommand: vi.fn(),
}));

const mockAssetService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/assets.js", () => ({
  assetService: () => mockAssetService,
}));

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => ({}),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
    getMembership: vi.fn(),
    listPrincipalGrants: vi.fn(),
  }),
  approvalService: () => ({}),
  organizationSkillService: () => ({}),
  budgetService: () => ({}),
  heartbeatService: () => ({}),
  issueApprovalService: () => ({}),
  issueService: () => ({}),
  logActivity: mockLogActivity,
  secretService: () => ({}),
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => ({}),
}));

vi.mock("../agent-runtimes/index.js", () => ({
  findServerAdapter: vi.fn(() => null),
  listAgentRuntimeModels: vi.fn(),
}));

function createStorageService(): StorageService {
  return {
    provider: "local_disk",
    putFile: vi.fn(async (input) => ({
      provider: "local_disk",
      objectKey: `${input.namespace}/avatar.webp`,
      contentType: input.contentType,
      byteSize: input.body.length,
      sha256: "avatar-sha",
      originalFilename: input.originalFilename,
    })),
    getObject: vi.fn(),
    headObject: vi.fn(),
    deleteObject: vi.fn(),
  };
}

function createApp(storage: StorageService) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", agentRoutes({} as any, storage));
  app.use(errorHandler);
  return app;
}

describe("agent avatar routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentService.getById.mockResolvedValue(baseAgent);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: baseAgent });
    mockAgentService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...baseAgent,
      ...patch,
    }));
    mockAssetService.create.mockResolvedValue({
      id: assetId,
      orgId,
      provider: "local_disk",
      objectKey: `assets/agents/${agentId}/avatars/avatar.webp`,
      contentType: "image/webp",
      byteSize: 1024,
      sha256: "avatar-sha",
      originalFilename: "avatar.png",
      createdByAgentId: null,
      createdByUserId: "user-1",
      createdAt: new Date("2026-04-26T00:00:00.000Z"),
      updatedAt: new Date("2026-04-26T00:00:00.000Z"),
    });
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("compresses an uploaded image and stores it as an agent avatar asset", async () => {
    const storage = createStorageService();
    const app = createApp(storage);
    const png = await sharp({
      create: {
        width: 640,
        height: 360,
        channels: 4,
        background: { r: 20, g: 120, b: 220, alpha: 1 },
      },
    }).png().toBuffer();

    const res = await request(app)
      .post(`/api/agents/${agentId}/avatar`)
      .attach("file", png, { filename: "avatar.png", contentType: "image/png" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(storage.putFile).toHaveBeenCalledTimes(1);
    const stored = (storage.putFile as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(stored).toMatchObject({
      orgId,
      namespace: `assets/agents/${agentId}/avatars`,
      contentType: "image/webp",
    });
    const storedMetadata = await sharp(stored.body).metadata();
    expect(storedMetadata.format).toBe("webp");
    expect(storedMetadata.width).toBe(256);
    expect(storedMetadata.height).toBe(256);
    expect(mockAssetService.create).toHaveBeenCalledWith(orgId, expect.objectContaining({
      contentType: "image/webp",
    }));
    expect(mockAgentService.update).toHaveBeenCalledWith(agentId, { icon: `asset:${assetId}` });
    expect(res.body.icon).toBe(`asset:${assetId}`);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.avatar_updated",
      entityId: agentId,
    }));
  });

  it("rejects non-image avatar uploads", async () => {
    const storage = createStorageService();
    const app = createApp(storage);

    const res = await request(app)
      .post(`/api/agents/${agentId}/avatar`)
      .attach("file", Buffer.from("hello"), { filename: "note.txt", contentType: "text/plain" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Unsupported avatar image type: text/plain");
    expect(storage.putFile).not.toHaveBeenCalled();
    expect(mockAgentService.update).not.toHaveBeenCalled();
  });
});
