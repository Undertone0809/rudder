import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectService, type ProjectCreateContext } from "./projects.js";
import type { RustFoundationBridge } from "./rust-foundation-bridge.js";

const mocks = vi.hoisted(() => ({
  organizationLock: vi.fn(),
  projectLock: vi.fn(),
  organizationLayout: vi.fn(),
  projectLayout: vi.fn(),
}));
vi.mock("./organization-mutation-fence.js", () => ({ lockNodeMutationAuthority: mocks.organizationLock }));
vi.mock("./project-goal-mutation-fence.js", () => ({ lockNodeProjectGoalMutationAuthority: mocks.projectLock }));
vi.mock("../home-paths.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../home-paths.js")>(),
  ensureOrganizationWorkspaceLayout: mocks.organizationLayout,
  ensureProjectLibraryLayout: mocks.projectLayout,
  resolveOrganizationWorkspaceRoot: () => "/fixture/org",
  resolveRudderInstanceRoot: () => "/fixture/instance",
}));
vi.mock("./resource-catalog.js", () => ({
  listProjectResourceAttachmentsByProjectIds: vi.fn(async () => new Map()),
  replaceProjectResourceAttachments: vi.fn(),
}));
vi.mock("./workspace-runtime.js", () => ({
  listWorkspaceRuntimeServicesForProjectWorkspaces: vi.fn(async () => new Map()),
}));

const orgId = "10000000-0000-4000-8000-000000000001";
const projectId = "20000000-0000-4000-8000-000000000001";
const actor = { type: "board", source: "local_implicit", userId: "operator", runId: "30000000-0000-4000-8000-000000000001" } as const;
const context: ProjectCreateContext = { lane: "rust", caller: "public", actor };
const result = {
  id: projectId, orgId, name: "Release", goalId: null, goalIds: [], goals: [],
  resources: [], workspaces: [], primaryWorkspace: null,
  createdAt: "2026-09-29T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z",
};
function bridgeResponse(status = 201, body: unknown = result) {
  return { status, contentType: "application/json", body: Buffer.from(JSON.stringify(body)) };
}
function fixture() {
  const db = { transaction: vi.fn(), select: vi.fn(), insert: vi.fn() };
  const bridge = {
    projectGoalSetMode: "required",
    projectCreate: vi.fn().mockResolvedValue(bridgeResponse()),
  };
  return { db, bridge, service: projectService(db as never, bridge as unknown as RustFoundationBridge) };
}

describe("Project create service authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.organizationLayout.mockResolvedValue({ root: "/fixture/org" });
  });

  it("forwards unchanged input and explicit actor/key before Node business work", async () => {
    const { db, bridge, service } = fixture();
    const data = { name: "Release", goalId: projectId, goalIds: [], color: null };
    expect(await service.create(orgId, data, { ...context, idempotencyKey: "stable-key" })).toEqual(result);
    expect(bridge.projectCreate).toHaveBeenCalledWith(actor, orgId, data, "stable-key", {}, {
      organizationWorkspaceRoot: "/fixture/org",
      projectCreateStateRoot: "/fixture/instance/data",
    });
    expect(mocks.organizationLayout).toHaveBeenCalledWith(orgId);
    expect(data).toEqual({ name: "Release", goalId: projectId, goalIds: [], color: null });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.projectLayout).not.toHaveBeenCalled();
  });

  it("generates a key for ordinary clients and returns stored replay without hydration", async () => {
    const { db, bridge, service } = fixture();
    await service.create(orgId, { name: "Release" }, context);
    expect(bridge.projectCreate.mock.calls[0]?.[3]).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridge.projectCreate).toHaveBeenCalledOnce();
    expect(db.select).not.toHaveBeenCalled();
    expect(mocks.projectLayout).not.toHaveBeenCalled();
  });

  it.each([403, 409, 422, 500])("preserves Rust failure status %s without Node fallback", async (status) => {
    const { db, bridge, service } = fixture();
    bridge.projectCreate.mockResolvedValue(bridgeResponse(status, { error: "mutation_rejected" }));
    await expect(service.create(orgId, { name: "Release" }, context)).rejects.toMatchObject({ status, message: "mutation_rejected" });
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.projectLayout).not.toHaveBeenCalled();
  });

  it("fails closed on outage or disabled mode", async () => {
    const { db, bridge, service } = fixture();
    bridge.projectCreate.mockRejectedValue(new Error("lost acknowledgement"));
    await expect(service.create(orgId, { name: "Release" }, context)).rejects.toMatchObject({ status: 503 });
    bridge.projectGoalSetMode = "off";
    bridge.projectCreate.mockClear();
    await expect(service.create(orgId, { name: "Release" }, context)).rejects.toMatchObject({ status: 503 });
    expect(bridge.projectCreate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("rejects cross-org and non-board onboarding contexts before dispatch", async () => {
    const { db, bridge, service } = fixture();
    const agent = { type: "agent", source: "agent_key", agentId: projectId, orgId: "other-org" } as const;
    await expect(service.create(orgId, { name: "Release" }, { ...context, actor: agent })).rejects.toMatchObject({ status: 403 });
    await expect(service.create(orgId, { name: "Release" }, { lane: "rust", caller: "onboarding", actor: { ...agent, orgId } })).rejects.toMatchObject({ status: 403 });
    expect(bridge.projectCreate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.organizationLayout).not.toHaveBeenCalled();
  });

  it("stops before Rust dispatch when existing organization layout ownership checks fail", async () => {
    const { db, bridge, service } = fixture();
    const error = new Error("organization workspace belongs to another organization");
    mocks.organizationLayout.mockRejectedValueOnce(error);
    await expect(service.create(orgId, { name: "Release" }, context)).rejects.toBe(error);
    expect(bridge.projectCreate).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(mocks.projectLayout).not.toHaveBeenCalled();
  });

  it("keeps trusted import Node-owned and locks before mutable resolution and first write", async () => {
    const { db, bridge, service } = fixture();
    const events: string[] = [];
    mocks.organizationLock.mockImplementation(async () => { events.push("lock"); });
    mocks.projectLayout.mockImplementation(async () => { events.push("library"); });
    const tx = {
      select: vi.fn(() => {
        events.push("resolve");
        return { from: () => ({ where: async () => [{ id: "existing", name: "Release", color: null }] }) };
      }),
      insert: vi.fn(() => ({ values: (data: Record<string, unknown>) => {
        events.push("insert");
        return { returning: async () => [{ ...data, createdAt: new Date(), updatedAt: new Date() }] };
      } })),
    };
    db.transaction.mockImplementation(async (callback) => callback(tx));
    const query: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "where", "orderBy"]) query[method] = () => query;
    query.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve);
    db.select.mockReturnValue(query);

    const created = await service.create(orgId, { name: "Release" }, { lane: "node", caller: "import" });
    expect(created.name).toBe("Release 2");
    expect(events.slice(0, 4)).toEqual(["lock", "resolve", "library", "insert"]);
    expect(bridge.projectCreate).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledOnce();
  });
});
