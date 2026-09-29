import express from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { createOrganizationPortabilityImportHandlers } from "../services/knowledge-portability/organization-portability.import.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";
import { HttpError } from "../errors.js";

const onboardingMocks = vi.hoisted(() => ({
  agents: { list: vi.fn() },
  issues: {
    list: vi.fn(),
    create: vi.fn(),
    followIssue: vi.fn(),
  },
  organizations: { getById: vi.fn() },
  projects: {
    list: vi.fn(),
    getMutationOwner: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  logActivity: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  agentService: () => onboardingMocks.agents,
  issueService: () => onboardingMocks.issues,
  organizationService: () => onboardingMocks.organizations,
  projectService: () => onboardingMocks.projects,
  logActivity: onboardingMocks.logActivity,
}));

vi.mock("../services/messenger-saved-views.js", () => ({
  lockMessengerCustomGroupPlacement: vi.fn(),
  lockMessengerOwnerPlacement: vi.fn(),
}));

const activeServers = new Set<Server>();

function createIssueRowsDb(rows: Array<{ title: string; hiddenAt: Date | null }> = []) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(rows),
      })),
    })),
  };
}

function createOnboardingDb() {
  const makeSelectQuery = (rows: unknown[]) => {
    const query: Record<string, any> = {};
    query.from = () => query;
    query.where = () => query;
    query.orderBy = () => query;
    query.limit = () => query;
    query.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject);
    return query;
  };
  const tx = {
    select: vi.fn(() => makeSelectQuery([])),
    execute: vi.fn().mockResolvedValue([]),
    insert: vi.fn(() => {
      const insert: Record<string, any> = {};
      insert.values = () => insert;
      insert.returning = () => Promise.resolve([{ id: "group-1", sortOrder: 0 }]);
      insert.onConflictDoUpdate = () => Promise.resolve([]);
      return insert;
    }),
  };
  return {
    select: vi.fn(() => makeSelectQuery([])),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)),
  };
}

async function createOnboardingServer(db: Record<string, unknown>, bridge?: RustFoundationBridge) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as typeof req & { actor: Record<string, unknown> }).actor = {
      type: "board",
      source: "local_implicit",
      userId: "user-1",
    };
    next();
  });
  app.use("/api", onboardingRoutes(db as never, bridge));
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  activeServers.add(server);
  await once(server, "listening");
  return server;
}

function createPortabilityHandlers(owner: "node" | "rust", plan: Record<string, unknown>) {
  const sentinel = new Error("stop after the project update path");
  const projects = {
    getMutationOwner: vi.fn().mockResolvedValue(owner),
    list: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockRejectedValue(sentinel),
    create: vi.fn(),
    createWorkspace: vi.fn(),
  };
  const organizations = {
    getById: vi.fn().mockResolvedValue({ id: "org-1", name: "Target" }),
    update: vi.fn(),
    create: vi.fn(),
  };
  const agents = { list: vi.fn().mockResolvedValue([]), update: vi.fn(), create: vi.fn() };
  const handlers = createOrganizationPortabilityImportHandlers({
    db: {} as never,
    access: {},
    organizations,
    agents,
    assetRecords: {},
    instructions: {},
    projects,
    issues: {},
    organizationSkills: {},
    buildPreview: vi.fn().mockResolvedValue(plan),
  } as never);
  return { handlers, projects, organizations, agents, sentinel };
}

function createImportPlan(input: {
  includeOrganization?: boolean;
  includeAgents?: boolean;
  projectAction: "update" | "create";
}) {
  return {
    preview: {
      errors: [],
      warnings: [],
      plan: {
        organizationAction: input.includeOrganization ? "update" : "none",
        agentPlans: input.includeAgents
          ? [{ slug: "agent", action: "update", plannedName: "Agent", existingAgentId: "agent-1", reason: null }]
          : [],
        projectPlans: [{
          slug: "project",
          action: input.projectAction,
          plannedName: "Project",
          existingProjectId: input.projectAction === "update" ? "project-1" : null,
          reason: null,
        }],
        issuePlans: [],
      },
    },
    include: {
      organization: input.includeOrganization ?? false,
      agents: input.includeAgents ?? false,
      projects: true,
      issues: false,
      skills: false,
    },
    source: {
      files: {},
      manifest: {
        organization: null,
        agents: [],
        projects: [{
          slug: "project",
          description: "Imported description",
          leadAgentSlug: null,
          targetDate: null,
          color: null,
          icon: null,
          status: "planned",
          executionWorkspacePolicy: null,
          workspaces: [],
        }],
        issues: [],
        envInputs: [],
        skills: [],
      },
    },
  };
}

describe("Project ownership-aware callers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onboardingMocks.organizations.getById.mockResolvedValue({ id: "org-1", urlKey: "target" });
    onboardingMocks.projects.list.mockResolvedValue([{
      id: "project-1",
      orgId: "org-1",
      name: "Getting Started",
      description: "Old description",
      archivedAt: null,
    }]);
    onboardingMocks.projects.getMutationOwner.mockResolvedValue("rust");
    onboardingMocks.issues.list.mockResolvedValue([]);
  });

  afterEach(async () => {
    await Promise.all([...activeServers].map((server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })));
    activeServers.clear();
  });

  it("selects the explicit Node import lane before creation", async () => {
    const { handlers, projects } = createPortabilityHandlers("rust", createImportPlan({ projectAction: "create" }));
    projects.create.mockResolvedValue({ id: "project-1", orgId: "org-1", name: "Project", urlKey: "project" });
    const result = await handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" },
      collisionStrategy: "replace",
    } as never, "user-1");
    expect(result.projects).toEqual([expect.objectContaining({ id: "project-1", action: "created" })]);
    expect(projects.create).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Project" }), {
      lane: "node", caller: "import",
    });
  });

  it.each(["node", "rust"] as const)("creates onboarding through the trusted %s lane and continues seeding", async (lane) => {
    onboardingMocks.projects.list.mockResolvedValue([]);
    onboardingMocks.projects.create.mockResolvedValue({ id: "project-1", orgId: "org-1", name: "Getting Started" });
    onboardingMocks.agents.list.mockResolvedValue([]);
    onboardingMocks.issues.create.mockImplementation(async (_orgId, input) => ({ ...input, id: "issue-1", identifier: "T-1" }));
    onboardingMocks.issues.followIssue.mockResolvedValue(undefined);
    const bridge = { projectGoalSetMode: lane === "rust" ? "required" : "off" } as RustFoundationBridge;
    const server = await createOnboardingServer(createOnboardingDb(), bridge);
    const response = await request(server).post("/api/orgs/org-1/onboarding/getting-started")
      .set("x-rudder-idempotency-key", "onboarding-key").send({ includeTutorial: false });
    expect(response.status).toBe(201);
    expect(onboardingMocks.projects.create).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Getting Started" }),
      lane === "rust"
        ? { lane, caller: "onboarding", actor: { type: "board", source: "local_implicit", userId: "user-1" }, idempotencyKey: "onboarding-key" }
        : { lane, caller: "onboarding" });
    expect(onboardingMocks.issues.create).toHaveBeenCalledOnce();
    const createAudits = onboardingMocks.logActivity.mock.calls.filter(([, entry]) => entry.action === "project.created");
    expect(createAudits).toHaveLength(lane === "node" ? 1 : 0);
  });

  it("stops onboarding after a Rust creation failure without fallback or follow-up writes", async () => {
    onboardingMocks.projects.list.mockResolvedValue([]);
    onboardingMocks.projects.create.mockRejectedValue(new HttpError(503, "Rust unavailable"));
    const db = createOnboardingDb();
    const server = await createOnboardingServer(db, { projectGoalSetMode: "required" } as RustFoundationBridge);
    const response = await request(server).post("/api/orgs/org-1/onboarding/getting-started").send({ includeTutorial: false });
    expect(response.status).toBe(503);
    expect(onboardingMocks.projects.create).toHaveBeenCalledOnce();
    expect(onboardingMocks.issues.create).not.toHaveBeenCalled();
    expect(onboardingMocks.logActivity).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("keeps Rust-owned scalar Project updates available to portability import", async () => {
    const { handlers, projects, organizations, agents } = createPortabilityHandlers(
      "rust",
      createImportPlan({ projectAction: "update" }),
    );
    const updated = { id: "project-1", orgId: "org-1", name: "Project", urlKey: "project" };
    projects.update.mockResolvedValue(updated);

    const result = await handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" },
      collisionStrategy: "replace",
    } as never, "user-1");

    expect(result.projects).toEqual([expect.objectContaining({ id: "project-1", action: "updated" })]);
    expect(projects.getMutationOwner).not.toHaveBeenCalled();
    expect(organizations.update).not.toHaveBeenCalled();
    expect(agents.update).not.toHaveBeenCalled();
    expect(projects.update).toHaveBeenCalledWith("project-1", expect.objectContaining({
      name: "Project",
      description: "Imported description",
    }), { allowScalarUpdateWhenProjectGoalOwned: true });
  });

  it("keeps Node-owned portability updates on the existing service path", async () => {
    const { handlers, projects, sentinel } = createPortabilityHandlers(
      "node",
      createImportPlan({ projectAction: "update" }),
    );

    await expect(handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" },
      collisionStrategy: "replace",
    } as never, "user-1")).rejects.toBe(sentinel);

    expect(projects.getMutationOwner).not.toHaveBeenCalled();
    expect(projects.update).toHaveBeenCalledWith("project-1", expect.objectContaining({
      name: "Project",
      description: "Imported description",
    }), { allowScalarUpdateWhenProjectGoalOwned: true });
  });

  it("refreshes a Rust-owned onboarding project's scalar description and completes seeding", async () => {
    onboardingMocks.projects.update.mockResolvedValue({
      id: "project-1",
      orgId: "org-1",
      name: "Getting Started",
      description: "Updated onboarding description",
      archivedAt: null,
    });
    onboardingMocks.agents.list.mockResolvedValue([]);
    onboardingMocks.issues.create.mockImplementation(async (_orgId, input) => ({
      ...input,
      id: "issue-1",
      identifier: "T-1",
    }));
    onboardingMocks.issues.followIssue.mockResolvedValue(undefined);
    const server = await createOnboardingServer(createOnboardingDb());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const response = await request(`http://127.0.0.1:${address.port}`)
      .post("/api/orgs/org-1/onboarding/getting-started")
      .send({ includeTutorial: false });

    expect(response.status).toBe(201);
    expect(response.body.project.description).toBe("Updated onboarding description");
    expect(onboardingMocks.projects.getMutationOwner).not.toHaveBeenCalled();
    expect(onboardingMocks.projects.update).toHaveBeenCalledWith("project-1", {
      description: expect.any(String),
    }, { allowScalarUpdateWhenProjectGoalOwned: true });
    expect(onboardingMocks.issues.create).toHaveBeenCalledOnce();
    expect(onboardingMocks.agents.list).toHaveBeenCalledWith("org-1");
  });

  it("keeps Node-owned onboarding project updates on the existing service path", async () => {
    const sentinel = new Error("stop after the project update path");
    onboardingMocks.projects.getMutationOwner.mockResolvedValue("node");
    onboardingMocks.projects.update.mockRejectedValue(sentinel);
    onboardingMocks.agents.list.mockRejectedValue(sentinel);
    const server = await createOnboardingServer(createIssueRowsDb());
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    await request(`http://127.0.0.1:${address.port}`)
      .post("/api/orgs/org-1/onboarding/getting-started")
      .send({ includeTutorial: false });

    expect(onboardingMocks.projects.getMutationOwner).not.toHaveBeenCalled();
    expect(onboardingMocks.projects.update).toHaveBeenCalledWith("project-1", {
      description: expect.any(String),
    }, { allowScalarUpdateWhenProjectGoalOwned: true });
  });
});
