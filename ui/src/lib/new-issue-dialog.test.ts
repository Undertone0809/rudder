import { describe, expect, it } from "vitest";
import {
  buildNewIssueCreateRequest,
  resolveDraftBackedNewIssueValues,
  resolveDefaultNewIssueProjectId,
} from "./new-issue-dialog";

const projects = [
  { id: "project-1", name: "Launch Prep", urlKey: "launch-prep" },
  { id: "project-2", name: "Ops Cleanup", urlKey: "ops-cleanup" },
];

describe("resolveDefaultNewIssueProjectId", () => {
  it("prefers an explicit project id over route context", () => {
    expect(
      resolveDefaultNewIssueProjectId({
        explicitProjectId: "project-explicit",
        pathname: "/RUD/issues",
        search: "?projectId=project-1",
        projects,
      }),
    ).toBe("project-explicit");
  });

  it("uses the selected project from an issues filter query", () => {
    expect(
      resolveDefaultNewIssueProjectId({
        pathname: "/RUD/issues",
        search: "?projectId=project-2",
        projects,
      }),
    ).toBe("project-2");
  });

  it("maps a project route ref back to the project id", () => {
    expect(
      resolveDefaultNewIssueProjectId({
        pathname: "/RUD/projects/launch-prep/issues",
        search: "",
        projects,
      }),
    ).toBe("project-1");
  });

  it("returns an empty string when no project context exists", () => {
    expect(
      resolveDefaultNewIssueProjectId({
        pathname: "/RUD/issues",
        search: "",
        projects,
      }),
    ).toBe("");
  });
});

describe("buildNewIssueCreateRequest", () => {
  it("includes selected label ids in the create payload", () => {
    expect(
      buildNewIssueCreateRequest({
        title: "Wire labels",
        description: "Make label selection work in the new issue dialog.",
        status: "todo",
        priority: "",
        projectId: "",
        labelIds: ["label-1"],
        projectWorkspaceId: "",
        executionWorkspacePolicyEnabled: false,
        executionWorkspaceMode: "shared_workspace",
        selectedExecutionWorkspaceId: "",
      }),
    ).toEqual(
      expect.objectContaining({
        title: "Wire labels",
        description: "Make label selection work in the new issue dialog.",
        priority: "medium",
        labelIds: ["label-1"],
      }),
    );
  });
});

describe("resolveDraftBackedNewIssueValues", () => {
  it("prefers explicit dialog defaults over a saved draft", () => {
    expect(
      resolveDraftBackedNewIssueValues({
        defaults: {
          status: "todo",
          priority: "high",
          projectId: "project-2",
          labelIds: ["label-1"],
          assigneeAgentId: "agent-1",
        },
        draft: {
          status: "blocked",
          priority: "low",
          projectId: "project-1",
          labelIds: ["label-draft"],
          assigneeValue: "user:user-1",
        },
        defaultProjectId: "project-2",
        defaultAssigneeValue: "agent:agent-1",
      }),
    ).toEqual({
      status: "todo",
      priority: "high",
      projectId: "project-2",
      labelIds: ["label-1"],
      assigneeValue: "agent:agent-1",
    });
  });

  it("falls back to the saved draft when no explicit defaults are provided", () => {
    expect(
      resolveDraftBackedNewIssueValues({
        defaults: {},
        draft: {
          status: "in_review",
          priority: "medium",
          projectId: "project-1",
          labelIds: ["label-draft"],
          assigneeValue: "user:user-1",
        },
        defaultProjectId: "",
        defaultAssigneeValue: "",
      }),
    ).toEqual({
      status: "in_review",
      priority: "medium",
      projectId: "project-1",
      labelIds: ["label-draft"],
      assigneeValue: "user:user-1",
    });
  });
});
