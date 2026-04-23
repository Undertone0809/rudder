import { afterEach, describe, expect, it, vi } from "vitest";
import type { Organization } from "@rudder/shared";

import { sortOrganizationsByStoredOrder } from "./organization-order";

describe("sortOrganizationsByStoredOrder", () => {
  const organizations: Organization[] = [
    {
      id: "org-1",
      name: "One",
      urlKey: "one",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "ONE",
      issueCounter: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
      defaultChatIssueCreationMode: "manual_approval",
      defaultChatAgentRuntimeType: null,
      defaultChatAgentRuntimeConfig: null,
      workspace: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "org-2",
      name: "Two",
      urlKey: "two",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "TWO",
      issueCounter: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
      defaultChatIssueCreationMode: "manual_approval",
      defaultChatAgentRuntimeType: null,
      defaultChatAgentRuntimeConfig: null,
      workspace: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    {
      id: "org-3",
      name: "Three",
      urlKey: "three",
      description: null,
      status: "active",
      pauseReason: null,
      pausedAt: null,
      issuePrefix: "THREE",
      issueCounter: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      requireBoardApprovalForNewAgents: false,
      defaultChatIssueCreationMode: "manual_approval",
      defaultChatAgentRuntimeType: null,
      defaultChatAgentRuntimeConfig: null,
      workspace: null,
      brandColor: null,
      logoAssetId: null,
      logoUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns api order when no stored order exists", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => null,
      },
    });

    expect(sortOrganizationsByStoredOrder(organizations)).toEqual(organizations);
  });

  it("prioritizes ids from local storage and appends the rest", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => JSON.stringify(["org-3", "org-1"]),
      },
    });

    expect(sortOrganizationsByStoredOrder(organizations)).toEqual([
      organizations[2],
      organizations[0],
      organizations[1],
    ]);
  });
});
