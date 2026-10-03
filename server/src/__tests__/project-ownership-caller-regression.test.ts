import express, { type Request } from "express";
import { once } from "node:events";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";
import { errorHandler } from "../middleware/index.js";
import { onboardingRoutes } from "../routes/onboarding.js";
import { createOrganizationPortabilityImportHandlers } from "../services/knowledge-portability/organization-portability.import.js";
import type { RustFoundationBridge } from "../services/rust-foundation-bridge.js";

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
    getById: vi.fn(),
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

function createPortabilityHandlers(owner: "node" | "rust", plan: Record<string, unknown>, bridge?: RustFoundationBridge) {
  const sentinel = new Error("stop after the project update path");
  const projects = {
    getMutationOwner: vi.fn().mockResolvedValue(owner),
    getById: vi.fn(),
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
    rustFoundationBridge: bridge,
  } as never);
  return { handlers, projects, organizations, agents, sentinel };
}

function createImportPlan(input: {
  includeOrganization?: boolean;
  includeAgents?: boolean;
  projectAction: "update" | "create";
  hydrate?: boolean;
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
          executionWorkspacePolicy: input.hydrate ? { enabled: true, defaultMode: "shared_workspace", defaultProjectWorkspaceKey: "main" } : null,
          workspaces: input.hydrate ? [{ key: "main", name: "Main", sourceType: "git_repo", repoUrl: "https://example.com/repo.git", isPrimary: true }] : [],
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

  it("creates onboarding through the Rust lane by default and continues seeding", async () => {
    onboardingMocks.projects.list.mockResolvedValue([]);
    onboardingMocks.projects.create.mockResolvedValue({ id: "project-1", orgId: "org-1", name: "Getting Started" });
    onboardingMocks.agents.list.mockResolvedValue([]);
    onboardingMocks.issues.create.mockImplementation(async (_orgId, input) => ({ ...input, id: "issue-1", identifier: "T-1" }));
    onboardingMocks.issues.followIssue.mockResolvedValue(undefined);
    const bridge = { projectGoalSetMode: "required" } as RustFoundationBridge;
    const server = await createOnboardingServer(createOnboardingDb(), bridge);
    const response = await request(server).post("/api/orgs/org-1/onboarding/getting-started")
      .set("x-rudder-idempotency-key", "onboarding-key").send({ includeTutorial: false });
    expect(response.status).toBe(201);
    expect(onboardingMocks.projects.create).toHaveBeenCalledWith("org-1", expect.objectContaining({ name: "Getting Started" }),
      { lane: "rust", caller: "onboarding", actor: { type: "board", source: "local_implicit", userId: "user-1" }, idempotencyKey: "onboarding-key" });
    expect(onboardingMocks.issues.create).toHaveBeenCalledOnce();
    const createAudits = onboardingMocks.logActivity.mock.calls.filter(([, entry]) => entry.action === "project.created");
    expect(createAudits).toHaveLength(0);
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

  it("routes Rust-owned replacement and hydrated policy through signed requests with separate stable keys", async () => {
    const forward = vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("{}") });
    const actor = { type: "board", source: "local_implicit", userId: "user-1", runId: "run-1" };
    const importRequest = Object.assign(Object.create(express.request), {
      actor, headers: { "x-rudder-idempotency-key": "import-key" },
    }) as Request;
    const { handlers, projects, organizations, agents } = createPortabilityHandlers(
      "rust",
      createImportPlan({ projectAction: "update", hydrate: true }),
      { projectGoalSetMode: "required", start: vi.fn().mockResolvedValue(undefined), projectGoalSet: forward } as unknown as RustFoundationBridge,
    );
    const updated = { id: "project-1", orgId: "org-1", name: "Project", urlKey: "project" };
    projects.getById.mockResolvedValue(updated);
    projects.createWorkspace.mockResolvedValue({ id: "workspace-1" });

    const result = await handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" },
      collisionStrategy: "replace",
    } as never, "user-1", undefined, importRequest);

    expect(result.projects).toEqual([expect.objectContaining({ id: "project-1", action: "updated" })]);
    expect(projects.getMutationOwner).toHaveBeenCalledWith("org-1", "project-1");
    expect(organizations.update).not.toHaveBeenCalled();
    expect(agents.update).not.toHaveBeenCalled();
    expect(projects.update).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(2);
    const calls = forward.mock.calls;
    expect(calls.map(([req]) => req.actor)).toEqual([actor, actor]);
    const keys = calls.map(([req]) => req.header("x-rudder-idempotency-key"));
    expect(new Set(keys).size).toBe(2);
    expect(importRequest.header("x-rudder-idempotency-key")).toBe("import-key");
    expect(JSON.parse(calls[0][3].toString())).toMatchObject({ projectPatch: { name: "Project", description: "Imported description" }, runId: "run-1" });
    expect(JSON.parse(calls[1][3].toString())).toEqual({ projectPatch: { executionWorkspacePolicy: {
      enabled: true, defaultMode: "shared_workspace", defaultProjectWorkspaceId: "workspace-1",
    } }, runId: "run-1", mutationOrigin: "organization_import" });
  });

  it("reuses imported workspace identity after a lost Rust hydrate response and rejects changed content", async () => {
    const plan = createImportPlan({ projectAction: "update", hydrate: true });
    const storedWorkspaces = new Map<string, { id: string; payload: string; workspace: Record<string, unknown> }>();
    const rustReceipts = new Map<string, string>();
    const actor = { type: "board", source: "local_implicit", userId: "user-1", runId: "run-1" };
    const importRequest = Object.assign(Object.create(express.request), {
      actor, headers: { "x-rudder-idempotency-key": "workspace-import-key" },
    }) as Request;
    const success = { status: 200, contentType: "application/json", body: Buffer.from("{}") };
    let loseHydrateResponse = true;
    const forward = vi.fn().mockImplementation(async (
      req: Request,
      _orgId: string,
      _projectId: string,
      body: Buffer,
    ) => {
      const bodyText = body.toString("utf8");
      const requestKey = req.header("x-rudder-idempotency-key")!;
      const previousReceipt = rustReceipts.get(requestKey);
      if (previousReceipt !== undefined) {
        return previousReceipt === bodyText
          ? success
          : { status: 409, contentType: "application/json", body: Buffer.from('{"error":"key conflict"}') };
      }

      rustReceipts.set(requestKey, bodyText);
      const payload = JSON.parse(bodyText) as { projectPatch: Record<string, unknown> };
      const policy = payload.projectPatch.executionWorkspacePolicy as Record<string, unknown> | undefined;
      if (policy?.defaultProjectWorkspaceId && loseHydrateResponse) {
        loseHydrateResponse = false;
        throw new Error("Connection lost after Rust applied the hydrate");
      }
      return success;
    });
    const { handlers, projects } = createPortabilityHandlers(
      "rust",
      plan,
      { projectGoalSetMode: "required", start: vi.fn().mockResolvedValue(undefined), projectGoalSet: forward } as unknown as RustFoundationBridge,
    );
    projects.getById.mockResolvedValue({ id: "project-1", orgId: "org-1", name: "Project", urlKey: "project" });
    projects.createWorkspace.mockImplementation(async (
      projectId: string,
      data: Record<string, unknown>,
      identity: { importKey: string; portableWorkspaceKey: string },
    ) => {
      const identityKey = JSON.stringify([
        identity.importKey,
        "org-1",
        projectId,
        identity.portableWorkspaceKey,
      ]);
      const payload = JSON.stringify(data);
      const existing = storedWorkspaces.get(identityKey);
      if (existing) {
        if (existing.payload !== payload) {
          throw new HttpError(409, "Project workspace import key conflicts with existing workspace content");
        }
        return existing.workspace;
      }
      const workspace = {
        id: `workspace-${storedWorkspaces.size + 1}`,
        orgId: "org-1",
        projectId,
        ...data,
      };
      storedWorkspaces.set(identityKey, { id: workspace.id, payload, workspace });
      return workspace;
    });

    const importBundle = () => handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" },
      collisionStrategy: "replace",
    } as never, "user-1", undefined, importRequest);

    await expect(importBundle()).rejects.toMatchObject({ status: 503 });
    expect(storedWorkspaces.size).toBe(1);
    expect(projects.createWorkspace).toHaveBeenNthCalledWith(
      1,
      "project-1",
      expect.objectContaining({ repoUrl: "https://example.com/repo.git" }),
      { importKey: "workspace-import-key", portableWorkspaceKey: "main" },
    );

    await expect(importBundle()).resolves.toMatchObject({
      projects: [expect.objectContaining({ id: "project-1", action: "updated" })],
    });
    expect(storedWorkspaces.size).toBe(1);
    const hydrationCalls = forward.mock.calls.filter((call) => {
      const payload = JSON.parse(call[3].toString("utf8")) as { projectPatch: Record<string, unknown> };
      const policy = payload.projectPatch.executionWorkspacePolicy as Record<string, unknown> | undefined;
      return Boolean(policy?.defaultProjectWorkspaceId);
    });
    expect(hydrationCalls).toHaveLength(2);
    expect(hydrationCalls.every((call) =>
      JSON.parse(call[3].toString("utf8")).mutationOrigin === "organization_import",
    )).toBe(true);
    expect(hydrationCalls[0]![0].header("x-rudder-idempotency-key")).toBe(
      hydrationCalls[1]![0].header("x-rudder-idempotency-key"),
    );
    expect(hydrationCalls[0]![3].toString("utf8")).toBe(hydrationCalls[1]![3].toString("utf8"));

    plan.source.manifest.projects[0]!.workspaces[0]!.repoUrl = "https://example.com/changed.git";
    await expect(importBundle()).rejects.toMatchObject({ status: 409 });
    expect(storedWorkspaces.size).toBe(1);
    expect(projects.createWorkspace).toHaveBeenCalledTimes(3);
    expect(forward).toHaveBeenCalledTimes(5);
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

    expect(projects.getMutationOwner).toHaveBeenCalledWith("org-1", "project-1");
    expect(projects.update).toHaveBeenCalledWith("project-1", expect.objectContaining({
      name: "Project",
      description: "Imported description",
    }));
  });

  it.each(["missing-actor", "foreign-board", "off", "startup", "outage", "conflict"] as const)("rejects Rust import %s without Node Project fallback", async (failure) => {
    const forward = vi.fn();
    if (failure === "outage") forward.mockRejectedValue(new Error("unavailable"));
    else forward.mockResolvedValue({ status: 409, contentType: "application/json", body: Buffer.from('{"error":"key conflict"}') });
    const start = failure === "startup" ? vi.fn().mockRejectedValue(new Error("not ready")) : vi.fn().mockResolvedValue(undefined);
    const { handlers, projects, organizations, agents } = createPortabilityHandlers("rust", createImportPlan({ projectAction: "update", includeOrganization: failure === "startup", includeAgents: failure === "startup" }), {
      start,
      projectGoalSetMode: failure === "off" ? "off" : "required", projectGoalSet: forward,
    } as unknown as RustFoundationBridge);
    const req = Object.assign(Object.create(express.request), {
      headers: {}, actor: failure === "foreign-board"
        ? { type: "board", source: "session", userId: "user-1", orgIds: ["other-org"] }
        : { type: "board", source: "local_implicit", userId: "user-1" },
    }) as Request;
    await expect(handlers.importBundle({
      source: { type: "inline", rootPath: "bundle", files: {} },
      include: { organization: false, agents: false, projects: true, issues: false, skills: false },
      target: { mode: "existing_organization", orgId: "org-1" }, collisionStrategy: "replace",
    } as never, "user-1", undefined, failure === "missing-actor" ? undefined : req)).rejects.toMatchObject({
      status: failure === "missing-actor" || failure === "foreign-board" ? 403 : failure === "conflict" ? 409 : 503,
    });
    expect(projects.update).not.toHaveBeenCalled();
    expect(projects.createWorkspace).not.toHaveBeenCalled();
    expect(organizations.update).not.toHaveBeenCalled();
    expect(agents.update).not.toHaveBeenCalled();
    expect(forward).toHaveBeenCalledTimes(failure === "outage" || failure === "conflict" ? 1 : 0);
  });

  it.each([undefined, "onboarding-refresh-key"])("refreshes a Rust-owned onboarding description through Rust with key %j", async (key) => {
    onboardingMocks.projects.getById.mockResolvedValue({
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
    const bridge = {
      projectGoalSetMode: "required",
      projectGoalSet: vi.fn().mockResolvedValue({ status: 200, contentType: "application/json", body: Buffer.from("{}") }),
    } as unknown as RustFoundationBridge;
    const server = await createOnboardingServer(createOnboardingDb(), bridge);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const invocation = request(`http://127.0.0.1:${address.port}`)
      .post("/api/orgs/org-1/onboarding/getting-started");
    if (key) invocation.set("x-rudder-idempotency-key", key);
    const response = await invocation.send({ includeTutorial: false });

    expect(response.status).toBe(201);
    expect(response.body.project.description).toBe("Updated onboarding description");
    expect(onboardingMocks.projects.getMutationOwner).toHaveBeenCalledWith("org-1", "project-1");
    expect(onboardingMocks.projects.update).not.toHaveBeenCalled();
    expect(bridge.projectGoalSet).toHaveBeenCalledOnce();
    const [req, orgId, projectId, body, path] = (bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[0];
    expect([orgId, projectId, path]).toEqual(["org-1", "project-1", "/api/orgs/org-1/projects/project-1/goal-set"]);
    expect(req.actor).toEqual({ type: "board", source: "local_implicit", userId: "user-1" });
    expect(req.header("x-rudder-idempotency-key")).toEqual(key ?? expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(JSON.parse(body.toString("utf8"))).toEqual({ projectPatch: { description: expect.any(String) }, runId: null });
    expect(onboardingMocks.projects.getById).toHaveBeenCalledWith("project-1");
    expect(onboardingMocks.logActivity.mock.calls.filter(([, entry]) => entry.entityType === "project")).toHaveLength(0);
    expect(onboardingMocks.issues.create).toHaveBeenCalledOnce();
    expect(onboardingMocks.agents.list).toHaveBeenCalledWith("org-1");
    if (key) {
      // A stale read on retry must send the identical command/key to Rust's
      // receipt replay, never repeat a Node Project write or Project audit.
      const replay = await request(server).post("/api/orgs/org-1/onboarding/getting-started")
        .set("x-rudder-idempotency-key", key).send({ includeTutorial: false });
      expect(replay.status).toBe(201);
      const replayCall = (bridge.projectGoalSet as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(replayCall[0].header("x-rudder-idempotency-key")).toBe(key);
      expect(replayCall[3]).toEqual(body);
      expect(onboardingMocks.projects.update).not.toHaveBeenCalled();
      expect(onboardingMocks.logActivity.mock.calls.filter(([, entry]) => entry.entityType === "project")).toHaveLength(0);
    }
  });

  it.each(["off", "shadow", "outage", "conflict"] as const)("stops Rust-owned description reseed on %s without Node fallback or follow-up writes", async (failure) => {
    const forward = vi.fn();
    if (failure === "outage") forward.mockRejectedValue(new Error("unavailable"));
    else forward.mockResolvedValue({ status: 409, contentType: "application/json", body: Buffer.from('{"error":"idempotency conflict"}') });
    const bridge = {
      projectGoalSetMode: failure === "off" || failure === "shadow" ? failure : "required",
      projectGoalSet: forward,
    } as unknown as RustFoundationBridge;
    const db = createOnboardingDb();
    const server = await createOnboardingServer(db, bridge);
    const response = await request(server).post("/api/orgs/org-1/onboarding/getting-started")
      .set("x-rudder-idempotency-key", "reseed-key").send({ includeTutorial: false });
    expect(response.status).toBe(failure === "conflict" ? 409 : 503);
    if (failure === "conflict") expect(response.body).toEqual({ error: "idempotency conflict" });
    expect(forward).toHaveBeenCalledTimes(failure === "off" || failure === "shadow" ? 0 : 1);
    expect(onboardingMocks.projects.update).not.toHaveBeenCalled();
    expect(onboardingMocks.projects.getById).not.toHaveBeenCalled();
    expect(onboardingMocks.issues.create).not.toHaveBeenCalled();
    expect(onboardingMocks.agents.list).not.toHaveBeenCalled();
    expect(onboardingMocks.logActivity).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("stops if the Node update transaction rejects a concurrent ownership transfer", async () => {
    onboardingMocks.projects.getMutationOwner.mockResolvedValue("node");
    onboardingMocks.projects.update.mockRejectedValue(new HttpError(409, "Project authority changed"));
    const forward = vi.fn();
    const server = await createOnboardingServer(createIssueRowsDb(), { projectGoalSetMode: "required", projectGoalSet: forward } as unknown as RustFoundationBridge);
    const response = await request(server).post("/api/orgs/org-1/onboarding/getting-started").send({ includeTutorial: false });
    expect(response.status).toBe(409);
    expect(onboardingMocks.projects.update).toHaveBeenCalledWith("project-1", { description: expect.any(String) });
    expect(forward).not.toHaveBeenCalled();
    expect(onboardingMocks.issues.create).not.toHaveBeenCalled();
    expect(onboardingMocks.logActivity).not.toHaveBeenCalled();
  });

  it("keeps Node-owned onboarding project updates on the existing service path", async () => {
    onboardingMocks.projects.getMutationOwner.mockResolvedValue("node");
    onboardingMocks.projects.update.mockResolvedValue({ id: "project-1", orgId: "org-1", name: "Getting Started", description: "Updated" });
    onboardingMocks.agents.list.mockResolvedValue([]);
    onboardingMocks.issues.create.mockImplementation(async (_orgId, input) => ({ ...input, id: "issue-1", identifier: "T-1" }));
    const forward = vi.fn();
    const server = await createOnboardingServer(createOnboardingDb(), { projectGoalSetMode: "required", projectGoalSet: forward } as unknown as RustFoundationBridge);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind a TCP port");

    const response = await request(`http://127.0.0.1:${address.port}`)
      .post("/api/orgs/org-1/onboarding/getting-started")
      .send({ includeTutorial: false });

    expect(onboardingMocks.projects.getMutationOwner).toHaveBeenCalledWith("org-1", "project-1");
    expect(onboardingMocks.projects.update).toHaveBeenCalledWith("project-1", {
      description: expect.any(String),
    });
    expect(response.status).toBe(201);
    expect(response.body.project.description).toBe("Updated");
    expect(forward).not.toHaveBeenCalled();
    expect(onboardingMocks.issues.create).toHaveBeenCalledOnce();
    expect(onboardingMocks.logActivity.mock.calls.filter(([, entry]) => entry.entityType === "project")).toHaveLength(0);
  });
});
