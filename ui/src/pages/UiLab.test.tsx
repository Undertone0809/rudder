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
      "ActivityCharts",
      "FilterBar",
      "InlineEditor",
      "InlineEntitySelector",
      "PageSkeleton",
      "Identity",
      "AgentIdentity",
      "AgentAvatar",
      "AssigneeLabel",
      "ReportsToPicker",
      "IssueLabelChip",
      "ActivityRow",
      "IssueRow",
      "ApprovalCard",
      "AgentActionButtons",
      "AgentIconPicker",
      "AgentProperties",
      "ApprovalPayload",
      "ApprovalPayloadRenderer",
      "DashboardDateRangeControl",
      "GoalProperties",
      "GoalTree",
      "HeartbeatEnabledButtons",
      "JsonSchemaForm",
      "MarkdownBody",
      "PackageFileTree",
      "PageTabBar",
      "ProjectProperties",
      "ResourceLocatorField",
      "ScheduleEditor",
      "BudgetPolicyCard",
      "BudgetIncidentCard",
      "FinanceKindCard",
      "FinanceTimelineCard",
      "RudderLogo",
      "SkillReferenceToken",
      "SidebarNavItem",
      "SidebarSection",
      "SidebarSectionHeader",
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

  it("does not leave common shell and workflow surfaces out of the inventory", () => {
    const coverage = getUiLabCoverage();
    const componentIds = new Set(coverage.map((entry) => entry.componentId));

    for (const expected of [
      "ActiveAgentsPanel",
      "AgentActionsMenu",
      "BreadcrumbBar",
      "DesktopUpdateStatusCard",
      "DevRestartBanner",
      "InstanceSidebar",
      "MessengerContextSidebar",
      "MobileBottomNav",
      "MobileWorkspaceDrawer",
      "OrganizationSettingsSidebar",
      "OrganizationSwitcher",
      "SettingsSidebar",
      "SidebarAgents",
      "SidebarChatSessions",
      "SidebarProjects",
      "WorkspaceBackupFilesSidebar",
      "NewAgentDialog",
      "NewGoalDialog",
      "NewProjectDialog",
    ]) {
      expect(componentIds.has(expected), expected).toBe(true);
    }
  });
});
