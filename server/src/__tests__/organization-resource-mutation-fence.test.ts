import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { lockNodeOrganizationResourceMutationAuthority } from "../services/organization-resource-mutation-fence.js";

const orgId = "33333333-3333-4333-8333-333333333333";
const resourceId = "55555555-5555-4555-8555-555555555555";
const state = {
  resource_id: resourceId,
  org_id: orgId,
  owner: "node",
  mutation_version: "0",
  fence_epoch: "0",
  fence_token: "66666666-6666-4666-8666-666666666666",
};
const dialect = new PgDialect();
const statements = (execute: ReturnType<typeof vi.fn>) => execute.mock.calls
  .map(([query]) => dialect.sqlToQuery(query as SQL).sql.trim());

describe("Node organization resource fence ordering", () => {
  it.each([true, false])("rejects an existing Rust owner before DML (initialize=%s)", async (initializeFromCanonical) => {
    const execute = vi.fn().mockResolvedValue([{ ...state, owner: "rust", fence_epoch: "2" }]);
    await expect(lockNodeOrganizationResourceMutationAuthority(
      { execute }, orgId, resourceId, { initializeFromCanonical },
    )).rejects.toMatchObject({ status: 409 });
    expect(statements(execute)).toHaveLength(1);
    expect(statements(execute)[0]).toMatch(/^SELECT[\s\S]*FOR UPDATE$/);
  });

  it("reuses existing Node authority without provisioning DML", async () => {
    const execute = vi.fn().mockResolvedValue([state]);
    await expect(lockNodeOrganizationResourceMutationAuthority(
      { execute }, orgId, resourceId, { initializeFromCanonical: true },
    )).resolves.toEqual(state);
    expect(statements(execute)).toHaveLength(1);
  });

  it("provisions only a missing canonical fence and validates the locked result", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([state]);
    await expect(lockNodeOrganizationResourceMutationAuthority(
      { execute }, orgId, resourceId, { initializeFromCanonical: true },
    )).resolves.toEqual(state);
    expect(statements(execute).map((statement) => statement.split(/\s/)[0])).toEqual(["SELECT", "INSERT", "SELECT"]);
    expect(statements(execute)[1]).toContain("ON CONFLICT (resource_id) DO NOTHING");
  });

  it("does not provision a missing tombstone or accept missing canonical authority", async () => {
    const missing = vi.fn().mockResolvedValue([]);
    await expect(lockNodeOrganizationResourceMutationAuthority({ execute: missing }, orgId, resourceId)).resolves.toBeNull();
    expect(statements(missing)).toHaveLength(1);
    const canonical = vi.fn().mockResolvedValue([]);
    await expect(lockNodeOrganizationResourceMutationAuthority(
      { execute: canonical }, orgId, resourceId, { initializeFromCanonical: true },
    )).rejects.toMatchObject({ status: 409 });
    expect(statements(canonical)).toHaveLength(3);
  });
});
