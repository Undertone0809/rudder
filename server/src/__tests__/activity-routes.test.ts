import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { activityRoutes } from "../routes/activity.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

const activityRead = vi.fn();
const readBridge = { activityRead } as unknown as RustFoundationBridge;

const mockActivityService = vi.hoisted(() => ({
  list: vi.fn(),
  listPage: vi.fn(),
  listUserActivityLedger: vi.fn(),
  forIssue: vi.fn(),
  runsForIssue: vi.fn(),
  issuesForRun: vi.fn(),
  create: vi.fn(),
  organizationIntelligenceProfileService: () => ({
    list: vi.fn(),
    getByPurpose: vi.fn(),
    upsert: vi.fn(),
    ensureDefaultsFromRuntime: vi.fn(),
  }),
  organizationIntelligenceRuntimeChainService: () => ({ assertUsable: vi.fn() }),
}));

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(),
}));

vi.mock("../services/activity.js", () => ({
  activityService: () => mockActivityService,
}));

vi.mock("../services/index.js", () => ({
  issueService: () => mockIssueService,
}));

function createRunLookupDb(run: { orgId: string } | null) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => run ? [run] : []),
      })),
    })),
  };
}

const activeServers = new Set<Server>();

async function createApp(db: Record<string, unknown> = { execute: async () => [{ timezone: "UTC" }] }, bridge: RustFoundationBridge | undefined = readBridge) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "user-1",
      orgIds: ["organization-1"],
      source: "session",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", activityRoutes(db as any, bridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

describe("activity routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    activityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("[]") });
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("resolves issue references and passes the authorized target to native reads", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({ id: "issue-uuid-1", orgId: "organization-1" });
    const response = await request(await createApp()).get("/api/issues/ACT-1/activity");
    expect(response.status).toBe(200);
    expect(activityRead).toHaveBeenCalledWith(expect.anything(), "organization-1", {
      operation: "issue", issueId: "issue-uuid-1", legacyDateTimezone: "UTC",
    });
    expect(mockActivityService.forIssue).not.toHaveBeenCalled();
  });

  it("passes activity list principal filters to the service", async () => {
    mockActivityService.list.mockResolvedValue([]);

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        userId: "user-1",
        actorType: "user",
        actorId: "user-1",
        entityType: "project",
      });

    expect(res.status).toBe(200);
    expect(activityRead).toHaveBeenCalledWith(expect.anything(), "organization-1", {
      operation: "list",
      legacyDateTimezone: "UTC",
      agentId: undefined,
      userId: "user-1",
      actorType: "user",
      actorId: "user-1",
      entityType: "project",
      entityId: undefined,
    });
  });

  it("passes paginated activity list parameters to the service", async () => {
    activityRead.mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ items: [{ id: "activity-1" }], nextCursor: "next-page" })) });
    const cursor = { createdAt: "2026-04-01T10:00:00.000123Z", id: "10000000-0000-4000-8000-000000000001" };

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/activity")
      .query({
        actorType: "system",
        limit: "25",
        cursor: Buffer.from(JSON.stringify(cursor)).toString("base64url"),
      });

    expect(res.status).toBe(200);
    expect(activityRead).toHaveBeenCalledWith(expect.anything(), "organization-1", {
      operation: "list-page",
      legacyDateTimezone: "UTC",
      agentId: undefined,
      userId: undefined,
      actorType: "system",
      actorId: undefined,
      entityType: undefined,
      entityId: undefined,
      limit: 25,
      cursor,
    });
    expect(mockActivityService.list).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      items: [{ id: "activity-1" }],
      nextCursor: "next-page",
    });
  });

  it.each(["0x10", "1e1", " 10 "])("keeps Number limit parsing for %s", async (limit) => {
    const response = await request(await createApp()).get("/api/orgs/organization-1/activity").query({ limit });
    expect(response.status).toBe(200);
    expect(activityRead).toHaveBeenCalledWith(expect.anything(), "organization-1", expect.objectContaining({ operation: "list-page", limit: Number(limit) }));
  });

  it.each(["", "0", "-1", "1.5", "Infinity", ["1", "2"]])("rejects malformed limits %j before native dispatch", async (limit) => {
    const response = await request(await createApp()).get("/api/orgs/organization-1/activity").query({ limit });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("invalid 'limit' value");
    expect(activityRead).not.toHaveBeenCalled();
  });

  it("preserves blank/repeated cursor list mode and untrimmed string filters", async () => {
    for (const cursor of [" ", ["one", "two"]]) {
      const response = await request(await createApp()).get("/api/orgs/organization-1/activity").query({ cursor, actorId: " user ", actorType: "USER" });
      expect(response.status).toBe(200);
      expect(activityRead).toHaveBeenLastCalledWith(expect.anything(), "organization-1", expect.objectContaining({ operation: "list", actorId: " user ", actorType: undefined }));
    }
  });

  it("preserves cursor errors and range errors before native dispatch", async () => {
    for (const [query, error] of [[{ cursor: "invalid" }, "Activity cursor is invalid or expired"], [{ limit: "101" }, "'limit' must be between 1 and 100"]] as const) {
      const response = await request(await createApp()).get("/api/orgs/organization-1/activity").query(query);
      expect(response.status).toBe(400);
      expect(response.body.error).toBe(error);
    }
    expect(activityRead).not.toHaveBeenCalled();
  });

  it("fails closed and forwards native errors without a Node business fallback", async () => {
    activityRead.mockRejectedValueOnce(new Error("offline"));
    const unavailable = await request(await createApp()).get("/api/orgs/organization-1/activity");
    expect(unavailable.status).toBe(503);
    activityRead.mockResolvedValueOnce({ status: 500, contentType: "application/json", body: Buffer.from('{"error":"Internal server error"}') });
    expect((await request(await createApp()).get("/api/orgs/organization-1/activity")).status).toBe(500);
    expect(mockActivityService.list).not.toHaveBeenCalled();
    expect(mockActivityService.listPage).not.toHaveBeenCalled();
  });

  it("passes user activity ledger filters to the service", async () => {
    mockActivityService.listUserActivityLedger.mockResolvedValue({
      items: [],
      nextCursor: null,
    });

    const res = await request(await createApp())
      .get("/api/orgs/organization-1/users/me/activity-ledger")
      .query({
        since: "2026-06-18T00:00:00.000Z",
        until: "2026-06-19T00:00:00.000Z",
        include: "chat,comments,approvals",
        agentId: "agent-1",
        projectId: "project-1",
        issueId: "issue-1",
        limit: "10",
        cursor: "cursor-1",
      });

    expect(res.status).toBe(200);
    expect(mockActivityService.listUserActivityLedger).toHaveBeenCalledWith({
      orgId: "organization-1",
      userId: "user-1",
      since: new Date("2026-06-18T00:00:00.000Z"),
      until: new Date("2026-06-19T00:00:00.000Z"),
      include: ["chat", "comments", "approvals"],
      agentId: "agent-1",
      projectId: "project-1",
      issueId: "issue-1",
      limit: 10,
      cursor: "cursor-1",
    });
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it("resolves issue identifiers before loading runs", async () => {
    mockIssueService.getByIdentifier.mockResolvedValue({
      id: "issue-uuid-1",
      orgId: "organization-1",
    });
    mockActivityService.runsForIssue.mockResolvedValue([{
      runId: "run-1",
      contextSnapshot: {
        issueId: "issue-uuid-1",
        resumeFromRunId: "source-run-id",
        resumeSessionDisplayId: "private-display-id",
        resumeSessionParams: {
          sessionId: "nested-private-session",
          cwd: "/nested/private/cwd",
          workspaceId: "private-workspace",
          repoUrl: "https://private.example/repo.git",
          repoRef: "private-ref",
        },
      },
    }]);

    const res = await request(await createApp()).get("/api/issues/PAP-475/runs");

    expect(res.status).toBe(200);
    expect(mockIssueService.getByIdentifier).toHaveBeenCalledWith("PAP-475");
    expect(mockIssueService.getById).not.toHaveBeenCalled();
    expect(mockActivityService.runsForIssue).toHaveBeenCalledWith("organization-1", "issue-uuid-1");
    expect(res.body).toEqual([{
      runId: "run-1",
      contextSnapshot: {
        issueId: "issue-uuid-1",
        resumeFromRunId: "source-run-id",
      },
    }]);
    expect(JSON.stringify(res.body)).not.toMatch(
      /private-display-id|nested-private-session|nested\/private\/cwd|private-workspace|private\.example|private-ref/,
    );
  });

  it("aliases agent run issue lookup to the agent run issue route", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
      },
    ]);

    const res = await request(await createApp(createRunLookupDb({ orgId: "organization-1" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(200);
    expect(mockActivityService.issuesForRun).toHaveBeenCalledWith("run-1");
    expect(res.body).toEqual([{ issueId: "issue-1" }]);
  });

  it("does not expose run issues across organization boundaries", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([
      {
        issueId: "issue-1",
      },
    ]);

    const res = await request(await createApp(createRunLookupDb({ orgId: "organization-2" })))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(403);
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("keeps legacy heartbeat run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(await createApp(createRunLookupDb(null)))
      .get("/api/heartbeat-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Heartbeat run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });

  it("uses agent-run issue lookup not-found copy", async () => {
    mockActivityService.issuesForRun.mockResolvedValue([]);

    const res = await request(await createApp(createRunLookupDb(null)))
      .get("/api/agent-runs/run-1/issues");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Agent run not found" });
    expect(mockActivityService.issuesForRun).not.toHaveBeenCalled();
  });
});
