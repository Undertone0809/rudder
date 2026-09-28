import { describe, expect, it, vi } from "vitest";
import {
  configuredProjectGoalMutationProjectIds,
  handoffProjectGoalMutationAuthorityInTransaction,
  lockProjectGoalMutationAuthoritiesForOrganizationDeletion,
} from "./project-goal-mutation-fence.js";

describe("Project-Goal authority scope", () => {
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

  it("rejects malformed project allowlists before startup handoff", () => {
    expect(() => configuredProjectGoalMutationProjectIds("not-a-uuid"))
      .toThrow("RUDDER_RUST_PROJECT_GOAL_PROJECT_IDS");
  });

  it("fails closed before updating when an allowlisted project is missing", async () => {
    const execute = vi.fn().mockResolvedValueOnce({
      rows: [{
        project_id: "11111111-1111-4111-8111-111111111111",
        org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }],
    });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    )).rejects.toThrow("not provisioned");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps an already Rust-owned row stable during an idempotent handoff", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { project_id: "11111111-1111-4111-8111-111111111111", org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          { project_id: "22222222-2222-4222-8222-222222222222", org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          { org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "11111111-1111-4111-8111-111111111111",
            org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mutation_version: "0",
            fence_epoch: "0",
            fence_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            owner: "node",
          },
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            mutation_version: "0",
            fence_epoch: "0",
            fence_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            owner: "rust",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ project_id: "11111111-1111-4111-8111-111111111111" }] });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    )).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("rejects an unknown owner before issuing the batch handoff update", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({
        rows: [
          { project_id: "11111111-1111-4111-8111-111111111111", org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          { project_id: "22222222-2222-4222-8222-222222222222", org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          { org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: "11111111-1111-4111-8111-111111111111",
            org_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            mutation_version: "0",
            fence_epoch: "0",
            fence_token: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            owner: "node",
          },
          {
            project_id: "22222222-2222-4222-8222-222222222222",
            org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            mutation_version: "0",
            fence_epoch: "0",
            fence_token: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            owner: "maintenance",
          },
        ],
      });

    await expect(handoffProjectGoalMutationAuthorityInTransaction(
      { execute },
      [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    )).rejects.toThrow("invalid owner");
    expect(execute).toHaveBeenCalledTimes(3);
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
