import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accessRoutes } from "../routes/access.js";
import { hashToken } from "../routes/access.helpers.js";
import { errorHandler } from "../middleware/index.js";

const mockAccessService = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  canUser: vi.fn(),
  isInstanceAdmin: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listMembers: vi.fn(),
  setMemberPermissions: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
  demoteInstanceAdmin: vi.fn(),
  listUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(),
  setPrincipalGrants: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockBoardAuthService = vi.hoisted(() => ({
  createCliAuthChallenge: vi.fn(),
  describeCliAuthChallenge: vi.fn(),
  approveCliAuthChallenge: vi.fn(),
  cancelCliAuthChallenge: vi.fn(),
  resolveBoardAccess: vi.fn(),
  assertCurrentBoardKey: vi.fn(),
  revokeBoardApiKey: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  accessService: () => mockAccessService,
  agentService: () => mockAgentService,
  boardAuthService: () => mockBoardAuthService,
  deduplicateAgentName: vi.fn(),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  logActivity: mockLogActivity,
  notifyHireApproved: vi.fn(),
}));

function createDbStub() {
  const createdInvite = {
    id: "invite-1",
    orgId: "organization-1",
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    defaultsPayload: null,
    expiresAt: new Date("2027-03-07T00:10:00.000Z"),
    invitedByUserId: null,
    tokenHash: "hash",
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };
  const returning = vi.fn().mockResolvedValue([createdInvite]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return {
    insert,
  };
}

function createInviteAcceptDbStub() {
  const invite = {
    id: "invite-accept-1",
    orgId: "organization-1",
    inviteType: "company_join",
    allowedJoinTypes: "agent",
    defaultsPayload: null,
    expiresAt: new Date("2027-03-07T00:10:00.000Z"),
    invitedByUserId: null,
    tokenHash: hashToken("token-123"),
    revokedAt: null,
    acceptedAt: null,
    createdAt: new Date("2026-03-07T00:00:00.000Z"),
    updatedAt: new Date("2026-03-07T00:00:00.000Z"),
  };
  const insertValues = vi.fn((values: Record<string, unknown>) => ({
    returning: vi.fn().mockResolvedValue([{
      id: "join-request-1",
      ...values,
      createdAt: new Date("2026-03-07T00:01:00.000Z"),
      updatedAt: new Date("2026-03-07T00:01:00.000Z"),
    }]),
  }));
  const updateWhere = vi.fn().mockResolvedValue([]);
  const tx = {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: updateWhere,
      })),
    })),
    insert: vi.fn(() => ({
      values: insertValues,
    })),
  };

  return {
    insertValues,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([invite])),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
}

function createApp(actor: Record<string, unknown>, db: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("POST /orgs/:orgId/openclaw/invite-prompt", () => {
  beforeEach(() => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentService.getById.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("rejects non-CEO agent callers", async () => {
    const db = createDbStub();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "engineer",
    });
    const app = createApp(
      {
        type: "agent",
        agentId: "agent-1",
        orgId: "organization-1",
        source: "agent_key",
      },
      db,
    );

    const res = await request(app)
      .post("/api/orgs/organization-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Only CEO agents");
  });

  it("allows CEO agent callers and creates an agent-only invite", async () => {
    const db = createDbStub();
    mockAgentService.getById.mockResolvedValue({
      id: "agent-1",
      orgId: "organization-1",
      role: "ceo",
    });
    const app = createApp(
      {
        type: "agent",
        agentId: "agent-1",
        orgId: "organization-1",
        source: "agent_key",
      },
      db,
    );

    const res = await request(app)
      .post("/api/orgs/organization-1/openclaw/invite-prompt")
      .send({ agentMessage: "Join and configure OpenClaw gateway." });

    expect(res.status).toBe(201);
    expect(res.body.allowedJoinTypes).toBe("agent");
    expect(typeof res.body.token).toBe("string");
    expect(res.body.onboardingTextPath).toContain("/api/invites/");
  });

  it("allows board callers with invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(true);
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        orgIds: ["organization-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/orgs/organization-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.allowedJoinTypes).toBe("agent");
  });

  it("rejects board callers without invite permission", async () => {
    const db = createDbStub();
    mockAccessService.canUser.mockResolvedValue(false);
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        orgIds: ["organization-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/orgs/organization-1/openclaw/invite-prompt")
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Permission denied");
  });
});

describe("POST /invites/:token/accept", () => {
  beforeEach(() => {
    mockAccessService.canUser.mockResolvedValue(false);
    mockAgentService.getById.mockReset();
    mockLogActivity.mockResolvedValue(undefined);
  });

  it("normalizes legacy top-level paperclipApiUrl into persisted rudderApiUrl", async () => {
    const db = createInviteAcceptDbStub();
    const app = createApp(
      {
        type: "board",
        userId: "user-1",
        orgIds: ["organization-1"],
        source: "session",
        isInstanceAdmin: false,
      },
      db,
    );

    const res = await request(app)
      .post("/api/invites/token-123/accept")
      .send({
        requestType: "agent",
        agentName: "OpenClaw",
        agentRuntimeType: "openclaw_gateway",
        paperclipApiUrl: "https://legacy-rudder.example.com",
        agentDefaultsPayload: {
          url: "ws://127.0.0.1:18789",
          headers: {
            "x-openclaw-token": "gateway-token-1234567890",
          },
          disableDeviceAuth: true,
        },
      });

    expect(res.status).toBe(202);
    const persisted = db.insertValues.mock.calls[0]?.[0]?.agentDefaultsPayload as Record<string, unknown>;
    expect(persisted).toMatchObject({
      rudderApiUrl: "https://legacy-rudder.example.com/",
    });
    expect(persisted).not.toHaveProperty("paperclipApiUrl");
  });
});
