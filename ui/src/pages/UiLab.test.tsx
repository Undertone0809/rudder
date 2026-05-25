// @vitest-environment node

import { describe, expect, it } from "vitest";
import { getUiLabCoverage } from "./UiLab";

describe("UiLab coverage registry", () => {
  it("tracks the common components that should be visible in the lab", () => {
    const coverage = getUiLabCoverage();
    const componentIds = new Set(coverage.map((entry) => entry.componentId));

    for (const expected of [
      "Button",
      "StatusBadge",
      "StatusIcon",
      "PriorityIcon",
      "EntityRow",
      "MetricCard",
      "FilterBar",
      "InlineEditor",
      "PageSkeleton",
      "Identity",
      "AgentIdentity",
      "AssigneeLabel",
      "IssueLabelChip",
      "ActivityRow",
      "IssueRow",
      "ApprovalCard",
      "AgentActionButtons",
      "CommandPalette",
      "RunTranscriptView",
    ]) {
      expect(componentIds.has(expected), expected).toBe(true);
    }
  });

  it("keeps context-bound surfaces explicit instead of counting them as rendered", () => {
    const coverage = getUiLabCoverage();
    const issueProperties = coverage.find((entry) => entry.componentId === "IssueProperties");

    expect(issueProperties?.status).toBe("context-required");
    expect(issueProperties?.gaps).toContain("issue");
  });
});
