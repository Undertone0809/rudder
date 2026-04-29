import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildNewIssueCreateRequest,
  clearIssueAutosave,
  createIssueDraft,
  hasMeaningfulIssueDraft,
  ISSUE_AUTOSAVE_STORAGE_KEY,
  ISSUE_DRAFTS_STORAGE_KEY,
  listIssueDrafts,
  readIssueAutosave,
  readSavedIssueDraft,
  resolveDraftBackedNewIssueValues,
  resolveDefaultNewIssueProjectId,
  saveIssueAutosave,
  summarizeIssueDrafts,
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

describe("issue autosave and draft persistence", () => {
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
    })).toBe(false);
  });

  it("persists autosave without adding a saved draft", () => {
    saveIssueAutosave(draft);

    expect(localStorage.getItem(ISSUE_AUTOSAVE_STORAGE_KEY)).toContain("Recover me");
    expect(readIssueAutosave("org-1")).toMatchObject({ title: "Recover me", projectId: "project-1" });
    expect(listIssueDrafts("org-1")).toEqual([]);
  });

  it("creates multiple saved drafts for the selected organization", () => {
    const first = createIssueDraft(draft);
    const second = createIssueDraft({ ...draft, title: "Second draft" });

    expect(localStorage.getItem(ISSUE_DRAFTS_STORAGE_KEY)).toContain("Second draft");
    expect(first?.id).toBeTruthy();
    expect(second?.id).toBeTruthy();
    expect(listIssueDrafts("org-1")).toHaveLength(2);
    expect(readSavedIssueDraft(second?.id, "org-1")).toMatchObject({ title: "Second draft" });
    expect(summarizeIssueDrafts("org-1")[0]).toMatchObject({
      id: second?.id,
      title: "Second draft",
    });
  });

  it("summarizes a saved draft for the selected organization", () => {
    const savedDraft = createIssueDraft(draft);

    expect(summarizeIssueDrafts("org-1")[0]).toMatchObject({
      id: savedDraft?.id,
      title: "Recover me",
      description: "Draft body",
      projectId: "project-1",
      status: "backlog",
      priority: "high",
    });
  });

  it("does not expose another organization's draft", () => {
    const savedDraft = createIssueDraft(draft);

    expect(readIssueAutosave("org-2")).toBeNull();
    expect(readSavedIssueDraft(savedDraft?.id, "org-2")).toBeNull();
    expect(summarizeIssueDrafts("org-2")).toEqual([]);
  });

  it("clears autosave without clearing saved drafts", () => {
    saveIssueAutosave(draft);
    createIssueDraft(draft);
    clearIssueAutosave();

    expect(readIssueAutosave("org-1")).toBeNull();
    expect(listIssueDrafts("org-1")).toHaveLength(1);
  });
});
