import { describe, expect, it, vi } from "vitest";
import {
  configuredProjectGoalMutationProjectIds,
  handoffProjectGoalMutationAuthorityInTransaction,
  lockNodeProjectGoalMutationAuthority,
  lockProjectGoalMutationAuthoritiesForOrganizationDeletion,
} from "./project-goal-mutation-fence.js";

const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function projectRow(projectId: string, organizationId: string) {
  return { project_id: projectId, org_id: organizationId };
}

function projectGoalStateRow(projectId: string, organizationId: string, owner = "node") {
  return {
    ...projectRow(projectId, organizationId),
    mutation_version: "0",
    fence_epoch: "0",
    fence_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    owner,
  };
}

function projectDeleteReceipt(projectId: string, organizationId = ORG_A) {
  return {
    project_id: projectId,
    receipt_format: 1,
    outcome: "applied",
    receipt_org_id: organizationId,
    result_org_id: organizationId,
    result_kind: "project_deleted",
    result_project_id: projectId,
    response_project_id: projectId,
    response_org_id: organizationId,
  };
}

describe("Project-Goal authority scope", () => {
  it("rejects stale Node deletion before its first business write under the organization-first fence", async () => {
    const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const projectId = "11111111-1111-4111-8111-111111111111";
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        owner: "node",
        mutation_version: "0",
        fence_epoch: "0",
        fence_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }])
      .mockResolvedValueOnce([{
        project_id: projectId,
        org_id: organizationId,
        mutation_version: "4",
        fence_epoch: "1",
        fence_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        owner: "rust",
      }]);
    const deleteBusinessRow = vi.fn();

    await expect((async () => {
      await lockNodeProjectGoalMutationAuthority({ execute }, organizationId, projectId);
      deleteBusinessRow();
    })()).rejects.toMatchObject({
      status: 409,
      message: "Project goal mutation authority is owned by Rust",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("organization_mutation_state");
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("project_goal_mutation_state");
    expect(JSON.stringify(execute.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(deleteBusinessRow).not.toHaveBeenCalled();
  });

  it("deduplicates an explicit project allowlist", () => {
    expect(configuredProjectGoalMutationProjectIds([
      "11111111-1111-4111-8111-111111111111",
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ].join(","))).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("deduplicates UUIDs case-insensitively", () => {
    expect(configuredProjectGoalMutationProjectIds([
      "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ].join(","))).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("rejects malformed project allowlists before startup handoff", () => {
    expect(() => configuredProjectGoalMutationProjectIds("not-a-uuid"))
      .toThrow("RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS");
  });

  it("fails closed before updating when an allowlisted project is missing", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          ...projectRow(PROJECT_A, ORG_A),
        }],
      })
      .mockResolvedValueOnce({ rows: [projectGoalStateRow(PROJECT_A, ORG_A)] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [
        PROJECT_A,
        PROJECT_B,
      ],
    )).rejects.toThrow("not provisioned");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("project_delete");
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("receipt_format");
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("outcome");
  });

  it("skips an allowlisted UUID only when both Project rows are gone and a durable delete receipt identifies it", async () => {
    const projectId = PROJECT_A;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [projectDeleteReceipt(projectId)] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_A }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [projectDeleteReceipt(projectId)] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [projectId],
    )).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(7);
    const terminalReceiptCheck = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(terminalReceiptCheck).toContain("organization_mutation_receipts");
    expect(terminalReceiptCheck).toContain("project_delete");
    expect(terminalReceiptCheck).toContain("receipt_format");
    expect(terminalReceiptCheck).toContain("outcome");
    expect(terminalReceiptCheck).toContain("response");
    const organizationLock = JSON.stringify(execute.mock.calls[3]?.[0]);
    expect(organizationLock).toContain("organization_mutation_state");
    expect(organizationLock).toContain("FOR UPDATE");
    expect(JSON.stringify(execute.mock.calls[6]?.[0])).toContain("organization_mutation_receipts");
  });

  it("rejects malformed and wrong-organization delete receipts as startup proof", async () => {
    const projectId = PROJECT_A;
    const validReceipt = projectDeleteReceipt(projectId);
    const invalidReceipts = [
      { ...validReceipt, receipt_format: 2 },
      { ...validReceipt, outcome: "noop" },
      { ...validReceipt, result_org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...validReceipt, result_kind: "project_patch" },
      { ...validReceipt, result_project_id: "22222222-2222-4222-8222-222222222222" },
      { ...validReceipt, response_project_id: "22222222-2222-4222-8222-222222222222" },
      { ...validReceipt, response_org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    ];

    for (const receipt of invalidReceipts) {
      const execute = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [receipt] });
      await expect(handoffProjectGoalMutationAuthorityInTransaction(
        { execute },
        [projectId],
      )).rejects.toThrow(`not provisioned for ${projectId}`);
    }
  });

  it("requires both Project and fence absence before accepting a terminal receipt", async () => {
    const projectId = PROJECT_A;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [projectId],
    )).rejects.toThrow(`not provisioned for ${projectId}`);

    const terminalReceiptCheck = JSON.stringify(execute.mock.calls[2]?.[0]);
    expect(terminalReceiptCheck).toContain("organization_mutation_receipts");
  });

  it("keeps missing allowlist targets fail-closed after their organization is deleted", async () => {
    const projectId = PROJECT_A;
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [projectId],
    )).rejects.toThrow("not provisioned");

    expect(execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("organization_mutation_receipts");
  });

  it("hands off a receipt-backed project recreated before the organization lock", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [projectDeleteReceipt(PROJECT_A)] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_A }] })
      .mockResolvedValueOnce({ rows: [projectRow(PROJECT_A, ORG_A)] })
      .mockResolvedValueOnce({ rows: [projectGoalStateRow(PROJECT_A, ORG_A)] })
      .mockResolvedValueOnce({ rows: [{ project_id: PROJECT_A }] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [PROJECT_A],
    )).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(7);
    expect(JSON.stringify(execute.mock.calls[3]?.[0])).toContain("organization_mutation_state");
    expect(JSON.stringify(execute.mock.calls[3]?.[0])).toContain("FOR UPDATE");
    expect(JSON.stringify(execute.mock.calls[4]?.[0])).toContain("FROM projects");
    expect(JSON.stringify(execute.mock.calls[5]?.[0])).toContain("project_goal_mutation_state");
    expect(JSON.stringify(execute.mock.calls[6]?.[0])).toContain("UPDATE project_goal_mutation_state");
  });

  it("rechecks a live target deleted while waiting on its organization lock", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [projectRow(PROJECT_A, ORG_A)] })
      .mockResolvedValueOnce({ rows: [projectGoalStateRow(PROJECT_A, ORG_A)] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_A }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [projectDeleteReceipt(PROJECT_A)] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [PROJECT_A],
    )).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(execute.mock.calls[2]?.[0])).toContain("FOR UPDATE");
    expect(JSON.stringify(execute.mock.calls[5]?.[0])).toContain("organization_mutation_receipts");
  });

  it("fails closed when a receipt-backed target's organization disappeared before locking", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [projectDeleteReceipt(PROJECT_A)] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [PROJECT_A],
    )).rejects.toThrow("organization authority is not provisioned");

    expect(execute).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(execute.mock.calls[3]?.[0])).toContain("FOR UPDATE");
  });

  it("keeps an already Rust-owned row stable during an idempotent handoff", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [projectRow(PROJECT_A, ORG_A), projectRow(PROJECT_B, ORG_B)],
      })
      .mockResolvedValueOnce({
        rows: [projectGoalStateRow(PROJECT_A, ORG_A), projectGoalStateRow(PROJECT_B, ORG_B, "rust")],
      })
      .mockResolvedValueOnce({
        rows: [{ org_id: ORG_A }, { org_id: ORG_B }],
      })
      .mockResolvedValueOnce({ rows: [projectRow(PROJECT_A, ORG_A), projectRow(PROJECT_B, ORG_B)] })
      .mockResolvedValueOnce({ rows: [projectGoalStateRow(PROJECT_A, ORG_A), projectGoalStateRow(PROJECT_B, ORG_B, "rust")] })
      .mockResolvedValueOnce({ rows: [{ project_id: PROJECT_A }] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [PROJECT_A, PROJECT_B],
    )).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("rejects an unknown owner before issuing the batch handoff update", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [projectRow(PROJECT_A, ORG_A), projectRow(PROJECT_B, ORG_B)],
      })
      .mockResolvedValueOnce({
        rows: [projectGoalStateRow(PROJECT_A, ORG_A), projectGoalStateRow(PROJECT_B, ORG_B, "maintenance")],
      })
      .mockResolvedValueOnce({
        rows: [{ org_id: ORG_A }, { org_id: ORG_B }],
      })
      .mockResolvedValueOnce({
        rows: [projectRow(PROJECT_A, ORG_A), projectRow(PROJECT_B, ORG_B)],
      })
      .mockResolvedValueOnce({
        rows: [projectGoalStateRow(PROJECT_A, ORG_A), projectGoalStateRow(PROJECT_B, ORG_B, "maintenance")],
      });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [PROJECT_A, PROJECT_B],
    )).rejects.toThrow("invalid owner");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it("locks organization and all Project-Goal rows in deletion order", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce([{
        owner: "node",
        mutation_version: "4",
        fence_epoch: "1",
        fence_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }])
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "11111111-1111-4111-8111-111111111111",
            org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mutation_version: "2",
            fence_epoch: "1",
            fence_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            owner: "rust",
          },
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mutation_version: "0",
            fence_epoch: "0",
            fence_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            owner: "node",
          },
        ],
      });

    await expect(lockProjectGoalMutationAuthoritiesForOrganizationDeletion(
      { execute },
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    )).resolves.toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("ORDER BY project_id");
    expect(JSON.stringify(execute.mock.calls[1]?.[0])).toContain("FOR UPDATE");
  });
});
