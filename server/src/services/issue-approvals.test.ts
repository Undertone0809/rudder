import { describe, expect, it, vi } from "vitest";
import { issueApprovalService } from "./issue-approvals.js";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const APPROVAL_ID = "00000000-0000-0000-0000-000000000040";
const ISSUE_ID = "00000000-0000-0000-0000-000000000010";
const SECOND_ISSUE_ID = "00000000-0000-0000-0000-000000000011";

type DbStub = {
  db: {
    delete: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  execute: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

function createDbStub(selectResults: unknown[][], insertedRows: unknown[] = []): DbStub {
  const pendingSelectResults = [...selectResults];
  const execute = vi.fn(async () => []);
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve(pendingSelectResults.shift() ?? [])),
    })),
  }));
  const onConflictDoNothing = vi.fn(() => ({
    returning: vi.fn(async () => insertedRows),
  }));
  const insert = vi.fn(() => ({
    values: vi.fn(() => ({ onConflictDoNothing })),
  }));
  const deleteWhere = vi.fn(async () => []);
  const deleteQuery = vi.fn(() => ({ where: deleteWhere }));
  const tx = { execute, select, insert, delete: deleteQuery };
  const transaction = vi.fn(async (callback: (client: typeof tx) => unknown) => callback(tx));

  return {
    db: {
      execute,
      select,
      insert,
      delete: deleteQuery,
      transaction,
    },
    execute,
    insert,
    select,
    delete: deleteQuery,
    transaction,
  };
}

const issue = { id: ISSUE_ID, orgId: ORG_ID };
const approval = { id: APPROVAL_ID, orgId: ORG_ID };
const firstLink = { orgId: ORG_ID, issueId: ISSUE_ID, approvalId: APPROVAL_ID };
const secondLink = { orgId: ORG_ID, issueId: SECOND_ISSUE_ID, approvalId: APPROVAL_ID };

function expectApprovalRowLock(execute: ReturnType<typeof vi.fn>) {
  const statement = execute.mock.calls[0]?.[0] as { queryChunks?: Array<string | { value?: string[] }> } | undefined;
  const text = (statement?.queryChunks ?? [])
    .map((chunk) => typeof chunk === "string" ? chunk : chunk.value?.join("") ?? "")
    .join("");
  expect(text).toContain("FOR UPDATE");
}

describe("issueApprovalService association locking", () => {
  it("locks the parent approval inside the link transaction before inserting", async () => {
    const stub = createDbStub([[issue], [approval], [firstLink]]);
    const service = issueApprovalService(stub.db as any);

    await expect(service.link(ISSUE_ID, APPROVAL_ID)).resolves.toEqual(firstLink);

    expect(stub.transaction).toHaveBeenCalledTimes(1);
    expect(stub.execute).toHaveBeenCalledTimes(1);
    expectApprovalRowLock(stub.execute);
    expect(stub.execute.mock.invocationCallOrder[0]).toBeLessThan(stub.select.mock.invocationCallOrder[0]);
    expect(stub.insert).toHaveBeenCalledTimes(1);
  });

  it("locks the parent approval inside the unlink transaction before deleting", async () => {
    const stub = createDbStub([[issue], [approval]]);
    const service = issueApprovalService(stub.db as any);

    await expect(service.unlink(ISSUE_ID, APPROVAL_ID)).resolves.toBeUndefined();

    expect(stub.transaction).toHaveBeenCalledTimes(1);
    expect(stub.execute).toHaveBeenCalledTimes(1);
    expectApprovalRowLock(stub.execute);
    expect(stub.execute.mock.invocationCallOrder[0]).toBeLessThan(stub.select.mock.invocationCallOrder[0]);
    expect(stub.db.delete).toHaveBeenCalledTimes(1);
  });

  it("locks the parent approval while preserving one-to-many linkMany semantics", async () => {
    const rows = [issue, { id: SECOND_ISSUE_ID, orgId: ORG_ID }];
    const stub = createDbStub([[approval], rows], [firstLink, secondLink]);
    const service = issueApprovalService(stub.db as any);

    await expect(service.linkManyForApproval(APPROVAL_ID, [ISSUE_ID, SECOND_ISSUE_ID])).resolves.toEqual([
      firstLink,
      secondLink,
    ]);

    expect(stub.transaction).toHaveBeenCalledTimes(1);
    expect(stub.execute).toHaveBeenCalledTimes(1);
    expectApprovalRowLock(stub.execute);
    expect(stub.execute.mock.invocationCallOrder[0]).toBeLessThan(stub.select.mock.invocationCallOrder[0]);
    expect(stub.insert).toHaveBeenCalledTimes(1);
  });
});
