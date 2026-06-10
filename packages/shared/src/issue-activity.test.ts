import { describe, expect, it } from "vitest";
import {
  hasMaterialIssueUpdateFields,
  isLowSignalIssueContentOnlyUpdate,
  issueUpdatedChangedKeys,
} from "./issue-activity.js";

describe("issue activity helpers", () => {
  it("treats title and description-only issue updates as low signal", () => {
    const details = {
      title: "Renamed",
      description: "Edited",
      identifier: "RUD-1",
      _previous: { title: "Old", description: "Original" },
    };

    expect(issueUpdatedChangedKeys(details)).toEqual(["title", "description"]);
    expect(hasMaterialIssueUpdateFields(details)).toBe(false);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(true);
  });

  it("keeps mixed content and workflow updates material", () => {
    const details = {
      title: "Renamed",
      status: "in_progress",
      _previous: { title: "Old", status: "todo" },
    };

    expect(hasMaterialIssueUpdateFields(details)).toBe(true);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(false);
  });

  it("hides internal run workspace persistence fields from activity summaries", () => {
    const details = {
      projectId: "project-2",
      executionWorkspaceId: null,
      executionWorkspaceSettings: { mode: "shared_workspace" },
      runWorkspaceId: "run-workspace-1",
      _previous: {
        projectId: "project-1",
        executionWorkspaceId: "old-execution-workspace",
      },
    };

    expect(issueUpdatedChangedKeys(details)).toEqual(["projectId"]);
    expect(hasMaterialIssueUpdateFields(details)).toBe(true);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(false);
  });

  it("treats run workspace-only issue updates as non-material", () => {
    const details = {
      executionWorkspaceId: "old-execution-workspace",
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: { mode: "shared_workspace" },
      _previous: { executionWorkspaceId: null },
    };

    expect(issueUpdatedChangedKeys(details)).toEqual([]);
    expect(hasMaterialIssueUpdateFields(details)).toBe(false);
    expect(isLowSignalIssueContentOnlyUpdate("issue.updated", details)).toBe(false);
  });
});
