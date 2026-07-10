import { describe, expect, it, vi } from "vitest";
import { workProductService } from "../services/work-products.ts";

function createWorkProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-03-17T00:00:00.000Z");
  return {
    id: "work-product-1",
    orgId: "organization-1",
    projectId: "project-1",
    issueId: "issue-1",
    executionWorkspaceId: null,
    runtimeServiceId: null,
    type: "pull_request",
    provider: "github",
    externalId: null,
    title: "PR 1",
    url: "https://example.com/pr/1",
    status: "open",
    reviewState: "draft",
    isPrimary: true,
    healthStatus: "unknown",
    summary: null,
    metadata: null,
    createdByRunId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createWorkProductInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    type: "pull_request",
    provider: "github",
    title: "PR 1",
    status: "active",
    reviewState: "none",
    isPrimary: false,
    healthStatus: "unknown",
    ...overrides,
  };
}

function createTransactionHarness(input: {
  selectResults?: Array<Array<Record<string, unknown>>>;
  insertedRow?: Record<string, unknown>;
  updatedRow?: Record<string, unknown>;
} = {}) {
  const selectResults = [...(input.selectResults ?? [])];
  const selectWhere = vi.fn(async () => selectResults.shift() ?? []);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertReturning = vi.fn(async () => [input.insertedRow ?? createWorkProductRow()]);
  const insertValues = vi.fn(() => ({ returning: insertReturning }));
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateReturning = vi.fn(async () => [input.updatedRow ?? createWorkProductRow()]);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const tx = { select, insert, update };
  const transaction = vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx));
  return {
    db: { transaction } as any,
    tx,
    select,
    insert,
    insertValues,
    update,
    updateSet,
  };
}

describe("workProductService", () => {
  it("uses a transaction when creating a new primary work product", async () => {
    const updatedWhere = vi.fn(async () => undefined);
    const updateSet = vi.fn(() => ({ where: updatedWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const insertedRow = createWorkProductRow();
    const insertReturning = vi.fn(async () => [insertedRow]);
    const insertValues = vi.fn(() => ({ returning: insertReturning }));
    const txInsert = vi.fn(() => ({ values: insertValues }));

    const tx = {
      update: txUpdate,
      insert: txInsert,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.createForIssue("issue-1", "organization-1", {
      type: "pull_request",
      provider: "github",
      title: "PR 1",
      status: "open",
      reviewState: "draft",
      isPrimary: true,
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txUpdate).toHaveBeenCalledTimes(1);
    expect(txInsert).toHaveBeenCalledTimes(1);
    expect(result?.id).toBe("work-product-1");
  });

  it("uses a transaction when promoting an existing work product to primary", async () => {
    const existingRow = createWorkProductRow({ isPrimary: false });

    const selectWhere = vi.fn(async () => [existingRow]);
    const selectFrom = vi.fn(() => ({ where: selectWhere }));
    const txSelect = vi.fn(() => ({ from: selectFrom }));

    const updateReturning = vi
      .fn()
      .mockResolvedValue([createWorkProductRow({ reviewState: "ready_for_review" })]);
    const updateWhere = vi.fn(() => ({ returning: updateReturning }));
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const txUpdate = vi.fn(() => ({ set: updateSet }));

    const tx = {
      select: txSelect,
      update: txUpdate,
    };
    const transaction = vi.fn(async (callback: (input: typeof tx) => Promise<unknown>) => await callback(tx));

    const svc = workProductService({ transaction } as any);
    const result = await svc.update("work-product-1", {
      isPrimary: true,
      reviewState: "ready_for_review",
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txSelect).toHaveBeenCalledTimes(2);
    expect(txUpdate).toHaveBeenCalledTimes(2);
    expect(result?.reviewState).toBe("ready_for_review");
  });

  it.each([
    ["project", { projectId: "foreign-project" }],
    ["run workspace alias", { runWorkspaceId: "foreign-workspace" }],
    ["runtime service", { runtimeServiceId: "foreign-service" }],
    ["creator run", { createdByRunId: "foreign-run" }],
  ])("rejects a foreign-organization %s when creating", async (_label, referencePatch) => {
    const harness = createTransactionHarness({ selectResults: [[]] });
    const svc = workProductService(harness.db);

    await expect(
      svc.createForIssue(
        "issue-1",
        "organization-1",
        createWorkProductInput(referencePatch) as any,
      ),
    ).rejects.toMatchObject({
      status: 422,
      message: "One or more work product references are invalid for this organization",
    });
    expect(harness.insert).not.toHaveBeenCalled();
  });

  it.each([
    ["project", { projectId: "foreign-project" }],
    ["run workspace alias", { runWorkspaceId: "foreign-workspace" }],
    ["runtime service", { runtimeServiceId: "foreign-service" }],
    ["creator run", { createdByRunId: "foreign-run" }],
  ])("rejects a foreign-organization %s when updating", async (_label, referencePatch) => {
    const existing = createWorkProductRow({
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
    });
    const harness = createTransactionHarness({ selectResults: [[existing], []] });
    const svc = workProductService(harness.db);

    await expect(svc.update("work-product-1", referencePatch as any)).rejects.toMatchObject({
      status: 422,
      message: "One or more work product references are invalid for this organization",
    });
    expect(harness.update).not.toHaveBeenCalled();
  });

  it("accepts same-organization references and stores runWorkspaceId in the legacy column", async () => {
    const inserted = createWorkProductRow({
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "service-1",
      createdByRunId: "run-1",
    });
    const harness = createTransactionHarness({
      selectResults: [
        [{ id: "project-1" }],
        [{ id: "workspace-1" }],
        [{ id: "service-1" }],
        [{ id: "run-1" }],
      ],
      insertedRow: inserted,
    });
    const svc = workProductService(harness.db);

    await expect(svc.createForIssue("issue-1", "organization-1", createWorkProductInput({
      projectId: "project-1",
      runWorkspaceId: "workspace-1",
      runtimeServiceId: "service-1",
      createdByRunId: "run-1",
    }) as any)).resolves.toMatchObject({
      projectId: "project-1",
      runWorkspaceId: "workspace-1",
      runtimeServiceId: "service-1",
      createdByRunId: "run-1",
    });

    expect(harness.select).toHaveBeenCalledTimes(4);
    expect(harness.insertValues).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "organization-1",
      issueId: "issue-1",
      executionWorkspaceId: "workspace-1",
    }));
    expect(harness.insertValues.mock.calls[0]?.[0]).not.toHaveProperty("runWorkspaceId");
  });

  it("validates references preserved by an unrelated update", async () => {
    const existing = createWorkProductRow({
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "service-1",
      createdByRunId: "run-1",
    });
    const updated = createWorkProductRow({ ...existing, title: "Updated" });
    const harness = createTransactionHarness({
      selectResults: [
        [existing],
        [{ id: "project-1" }],
        [{ id: "workspace-1" }],
        [{ id: "service-1" }],
        [{ id: "run-1" }],
      ],
      updatedRow: updated,
    });
    const svc = workProductService(harness.db);

    await expect(svc.update("work-product-1", { title: "Updated" })).resolves.toMatchObject({
      title: "Updated",
    });
    expect(harness.select).toHaveBeenCalledTimes(5);
  });

  it("allows every optional reference to be cleared through the run workspace alias", async () => {
    const existing = createWorkProductRow({
      projectId: "project-1",
      executionWorkspaceId: "workspace-1",
      runtimeServiceId: "service-1",
      createdByRunId: "run-1",
    });
    const updated = createWorkProductRow({
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
    });
    const harness = createTransactionHarness({
      selectResults: [[existing]],
      updatedRow: updated,
    });
    const svc = workProductService(harness.db);

    await expect(svc.update("work-product-1", {
      projectId: null,
      runWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
    })).resolves.toMatchObject({
      projectId: null,
      runWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
    });

    expect(harness.select).toHaveBeenCalledTimes(1);
    expect(harness.updateSet).toHaveBeenCalledWith(expect.objectContaining({
      projectId: null,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      createdByRunId: null,
    }));
    expect(harness.updateSet.mock.calls.at(-1)?.[0]).not.toHaveProperty("runWorkspaceId");
  });
});
