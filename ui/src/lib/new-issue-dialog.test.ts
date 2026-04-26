import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNewIssueCreateRequest,
  clearIssueDraft,
  hasMeaningfulIssueDraft,
  ISSUE_DRAFT_STORAGE_KEY,
  readIssueDraft,
  resolveDraftBackedNewIssueValues,
  resolveDefaultNewIssueProjectId,
  saveIssueDraft,
  summarizeIssueDraft,
} from "./new-issue-dialog";

const projects = [
  { id: "project-1", name: "Launch Prep", urlKey: "launch-prep" },
  { id: "project-2", name: "Ops Cleanup", urlKey: "ops-cleanup" },
];

function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => store.clear()),
    key: vi.fn((index: number) => [...store.keys()][index] ?? null),
    get length() {
      return store.size;
    },
  } as Storage;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createLocalStorageMock());
  vi.stubGlobal("dispatchEvent", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

describe("issue draft persistence", () => {
  const draft = {
    orgId: "org-1",
    title: "Recover me",
    description: "Draft body",
    status: "backlog",
    priority: "high",
    labelIds: ["label-1"],
    assigneeValue: "agent:agent-1",
    projectId: "project-1",
    projectWorkspaceId: "",
    assigneeModelOverride: "",
    assigneeThinkingEffort: "",
    assigneeChrome: false,
    executionWorkspaceMode: "shared_workspace",
    selectedExecutionWorkspaceId: "",
  };

  it("treats a description-only draft as meaningful", () => {
    expect(hasMeaningfulIssueDraft({ ...draft, title: "", description: "Some context" })).toBe(true);
  });

  it("does not treat untouched default fields as a meaningful draft", () => {
    expect(hasMeaningfulIssueDraft({
      title: "",
      description: "",
      status: "todo",
      priority: "medium",
      labelIds: [],
      assigneeValue: "",
      projectId: "",
      projectWorkspaceId: "",
      assigneeModelOverride: "",
      assigneeThinkingEffort: "",
      assigneeChrome: false,
      executionWorkspaceMode: "shared_workspace",
      selectedExecutionWorkspaceId: "",
    })).toBe(false);
  });

  it("persists and summarizes an issue draft for the selected organization", () => {
    saveIssueDraft(draft);

    expect(localStorage.getItem(ISSUE_DRAFT_STORAGE_KEY)).toContain("Recover me");
    expect(readIssueDraft("org-1")).toMatchObject({ title: "Recover me", projectId: "project-1" });
    expect(summarizeIssueDraft("org-1")).toEqual({
      title: "Recover me",
      description: "Draft body",
      projectId: "project-1",
      status: "backlog",
      priority: "high",
    });
  });

  it("does not expose another organization's draft", () => {
    saveIssueDraft(draft);

    expect(readIssueDraft("org-2")).toBeNull();
    expect(summarizeIssueDraft("org-2")).toBeNull();
  });

  it("clears the saved draft", () => {
    saveIssueDraft(draft);
    clearIssueDraft();

    expect(readIssueDraft("org-1")).toBeNull();
  });
});
