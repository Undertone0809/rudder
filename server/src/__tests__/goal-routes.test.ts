import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { goalRoutes } from "../routes/goals.js";
import { conflict, unprocessable } from "../errors.js";
import { errorHandler } from "../middleware/index.js";

const mockGoalService = vi.hoisted(() => ({
  list: vi.fn(),
  getById: vi.fn(),
  getDefaultCompanyGoal: vi.fn(),
  dependencies: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  goalService: () => mockGoalService,
  logActivity: mockLogActivity,
}));

const now = new Date("2026-04-30T08:00:00.000Z");

function createGoal(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    title: "Ship Goal Center",
    description: null,
    level: "organization",
    status: "active",
    parentId: null,
    ownerAgentId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createDependencies(overrides: Record<string, unknown> = {}) {
  return {
    goalId: "11111111-1111-4111-8111-111111111111",
    orgId: "org-1",
    canDelete: true,
    blockers: [],
    isLastRootOrganizationGoal: false,
    counts: {
      childGoals: 0,
      linkedProjects: 0,
      linkedIssues: 0,
      automations: 0,
      costEvents: 0,
      financeEvents: 0,
    },
    previews: {
      childGoals: [],
      linkedProjects: [],
      linkedIssues: [],
      automations: [],
    },
    ...overrides,
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
    };
    next();
  });
  app.use("/api", goalRoutes({} as any));
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  mockGoalService.list.mockReset();
  mockGoalService.getById.mockReset();
  mockGoalService.getDefaultCompanyGoal.mockReset();
  mockGoalService.dependencies.mockReset();
  mockGoalService.create.mockReset();
  mockGoalService.update.mockReset();
  mockGoalService.remove.mockReset();
  mockLogActivity.mockReset();
});

describe("goal routes", () => {
  it("returns dependency summary for a goal", async () => {
    const goal = createGoal();
    const dependencies = createDependencies();
    mockGoalService.getById.mockResolvedValue(goal);
    mockGoalService.dependencies.mockResolvedValue(dependencies);

    const res = await request(createApp())
      .get("/api/goals/11111111-1111-4111-8111-111111111111/dependencies");

    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(true);
    expect(mockGoalService.dependencies).toHaveBeenCalledWith(goal);
  });

  it("deletes a safe unused goal", async () => {
    const goal = createGoal();
    mockGoalService.getById.mockResolvedValue(goal);
    mockGoalService.remove.mockResolvedValue(goal);

    const res = await request(createApp())
      .delete("/api/goals/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(goal.id);
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: "org-1",
        action: "goal.deleted",
        entityType: "goal",
        entityId: goal.id,
      }),
    );
  });

  it("returns structured dependency details when delete is blocked", async () => {
    const goal = createGoal();
    const dependencies = createDependencies({
      canDelete: false,
      blockers: ["linked_issues", "last_root_organization_goal"],
      isLastRootOrganizationGoal: true,
      counts: {
        childGoals: 0,
        linkedProjects: 0,
        linkedIssues: 2,
        automations: 0,
        costEvents: 0,
        financeEvents: 0,
      },
    });
    mockGoalService.getById.mockResolvedValue(goal);
    mockGoalService.remove.mockRejectedValue(
      conflict("Goal cannot be deleted while it has dependencies", dependencies),
    );

    const res = await request(createApp())
      .delete("/api/goals/11111111-1111-4111-8111-111111111111");

    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({
      canDelete: false,
      blockers: ["linked_issues", "last_root_organization_goal"],
      isLastRootOrganizationGoal: true,
      counts: expect.objectContaining({ linkedIssues: 2 }),
    });
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("surfaces parent validation failures", async () => {
    const goal = createGoal();
    mockGoalService.getById.mockResolvedValue(goal);
    mockGoalService.update.mockRejectedValue(
      unprocessable("Goal parent cannot create a cycle"),
    );

    const res = await request(createApp())
      .patch("/api/goals/11111111-1111-4111-8111-111111111111")
      .send({ parentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Goal parent cannot create a cycle");
  });

  it("surfaces owner validation failures", async () => {
    const goal = createGoal();
    mockGoalService.getById.mockResolvedValue(goal);
    mockGoalService.update.mockRejectedValue(
      unprocessable("Goal owner must belong to the same organization"),
    );

    const res = await request(createApp())
      .patch("/api/goals/11111111-1111-4111-8111-111111111111")
      .send({ ownerAgentId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(422);
    expect(res.body.error).toBe("Goal owner must belong to the same organization");
  });
});
