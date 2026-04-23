import { beforeEach, describe, expect, it, vi } from "vitest";
import { organizationService } from "../services/orgs.ts";
import { agentService } from "../services/agents.ts";

function createSelectSequenceDb(results: unknown[]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pending.shift() ?? []))),
  };

  return {
    db: {
      select: vi.fn(() => chain),
    },
  };
}

describe("monthly spend hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recomputes organization spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const dbStub = createSelectSequenceDb([
      [{
        id: "organization-1",
        name: "Rudder",
        description: null,
        status: "active",
        issuePrefix: "PAP",
        issueCounter: 1,
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        requireBoardApprovalForNewAgents: false,
        brandColor: null,
        logoAssetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [{
        orgId: "organization-1",
        spentMonthlyCents: 420,
      }],
    ]);

    const organizations = organizationService(dbStub.db as any);
    const [organization] = await organizations.list();

    expect(organization.spentMonthlyCents).toBe(420);
  });

  it("recomputes agent spentMonthlyCents from the current utc month instead of returning stale stored values", async () => {
    const dbStub = createSelectSequenceDb([
      [{
        id: "agent-1",
        orgId: "organization-1",
        name: "Budget Agent",
        role: "general",
        title: null,
        reportsTo: null,
        capabilities: null,
        agentRuntimeType: "claude-local",
        agentRuntimeConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 5000,
        spentMonthlyCents: 999999,
        metadata: null,
        permissions: null,
        status: "idle",
        pauseReason: null,
        pausedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      }],
      [],
      [{
        agentId: "agent-1",
        spentMonthlyCents: 175,
      }],
    ]);

    const agents = agentService(dbStub.db as any);
    const agent = await agents.getById("agent-1");

    expect(agent?.spentMonthlyCents).toBe(175);
  });
});
