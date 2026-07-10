import type { Db } from "@rudderhq/db";
import { describe, expect, it, vi } from "vitest";
import { agentService } from "../services/agents.js";

const agentId = "11111111-1111-4111-8111-111111111111";

function createPendingApprovalFixture() {
  const pendingAgent = {
    id: agentId,
    orgId: "22222222-2222-4222-8222-222222222222",
    name: "Pending Builder",
    role: "engineer",
    status: "pending_approval",
    permissions: { canCreateAgents: false, canManageSkills: false },
    metadata: null,
    workspaceKey: "pending-builder",
    spentMonthlyCents: 0,
  };
  const update = vi.fn();
  const insert = vi.fn();
  const db = {
    select: vi.fn((selection?: unknown) => {
      if (selection === undefined) {
        return {
          from: () => ({
            where: () => Promise.resolve([pendingAgent]),
          }),
        };
      }
      return {
        from: () => ({
          where: () => ({
            groupBy: () => Promise.resolve([]),
          }),
        }),
      };
    }),
    update,
    insert,
  };

  return {
    service: agentService(db as unknown as Db),
    update,
    insert,
  };
}

describe("agent pending-approval lifecycle guards", () => {
  it("rejects pausing an agent that still requires approval", async () => {
    const { service, update } = createPendingApprovalFixture();

    await expect(service.pause(agentId)).rejects.toMatchObject({
      status: 409,
      message: "Pending approval agents cannot be paused",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("continues to reject resuming an agent that still requires approval", async () => {
    const { service, update } = createPendingApprovalFixture();

    await expect(service.resume(agentId)).rejects.toMatchObject({
      status: 409,
      message: "Pending approval agents cannot be resumed",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("continues to reject API-key creation until the agent is approved", async () => {
    const { service, insert } = createPendingApprovalFixture();

    await expect(service.createApiKey(agentId, "default")).rejects.toMatchObject({
      status: 409,
      message: "Cannot create keys for pending approval agents",
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
