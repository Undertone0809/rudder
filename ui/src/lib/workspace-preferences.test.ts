// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendWorkspaceOpenFilePath,
  isWorkspaceLaunchTargetId,
  normalizeWorkspaceOpenFilePaths,
  normalizeWorkspaceOpenFileTabState,
  readStoredWorkspaceLaunchTargetId,
  readStoredWorkspaceOpenFileTabState,
  workspaceFileOpenTargets,
  workspaceLaunchMenuOpeningId,
  writeStoredWorkspaceLaunchTargetId,
  writeStoredWorkspaceOpenFileTabState,
} from "./workspace-preferences";

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("workspace launch preferences", () => {
  it("accepts only supported workspace target ids", () => {
    expect(isWorkspaceLaunchTargetId("cursor")).toBe(true);
    expect(isWorkspaceLaunchTargetId("defaultApp")).toBe(false);
    expect(workspaceLaunchMenuOpeningId("defaultApp")).toBeNull();
    expect(workspaceLaunchMenuOpeningId("vscode")).toBe("vscode");
  });

  it("persists valid launch targets and ignores malformed stored values", () => {
    writeStoredWorkspaceLaunchTargetId("terminal");
    expect(readStoredWorkspaceLaunchTargetId()).toBe("terminal");
    window.localStorage.setItem("rudder.workspace.launchTargetId", "unknown-app");
    expect(readStoredWorkspaceLaunchTargetId()).toBeNull();
  });

  it("builds file targets from supported IDEs without treating Xcode as a file editor", () => {
    const targets = workspaceFileOpenTargets([
      { id: "vscode", label: "VS Code", kind: "ide" },
      { id: "xcode", label: "Xcode", kind: "ide" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ]);
    expect(targets.map((target) => target.id)).toEqual(["defaultApp", "vscode"]);
  });
});

describe("workspace tab persistence", () => {
  it("deduplicates paths, keeps the selected file, and caps restored tabs", () => {
    const paths = Array.from({ length: 26 }, (_, index) => `docs/${index}.md`);
    const state = normalizeWorkspaceOpenFileTabState([" docs/0.md ", ...paths, "docs/25.md"], "docs/selected.md");
    expect(state.openFilePaths).toHaveLength(24);
    expect(state.openFilePaths.at(-1)).toBe("docs/selected.md");
    expect(state.selectedFilePath).toBe("docs/selected.md");
    expect(new Set(state.openFilePaths).size).toBe(state.openFilePaths.length);
  });

  it("reads legacy arrays, isolates organizations, and tolerates malformed session state", () => {
    window.sessionStorage.setItem("rudder.workspace.openFileTabs:org-a", JSON.stringify(["docs/a.md", "docs/b.md"]));
    expect(readStoredWorkspaceOpenFileTabState("org-a")).toEqual({
      openFilePaths: ["docs/a.md", "docs/b.md"],
      selectedFilePath: "docs/a.md",
    });
    expect(readStoredWorkspaceOpenFileTabState("org-b")).toEqual({ openFilePaths: [], selectedFilePath: null });
    window.sessionStorage.setItem("rudder.workspace.openFileTabs:org-a", "{");
    expect(readStoredWorkspaceOpenFileTabState("org-a")).toEqual({ openFilePaths: [], selectedFilePath: null });
  });

  it("writes normalized state and avoids duplicating an already open path", () => {
    writeStoredWorkspaceOpenFileTabState("org-a", ["docs/a.md", "docs/a.md"], "docs/b.md");
    expect(JSON.parse(window.sessionStorage.getItem("rudder.workspace.openFileTabs:org-a") ?? "null")).toEqual({
      openFilePaths: ["docs/a.md", "docs/b.md"],
      selectedFilePath: "docs/b.md",
    });
    expect(appendWorkspaceOpenFilePath(["docs/a.md"], "docs/a.md")).toEqual(["docs/a.md"]);
    expect(normalizeWorkspaceOpenFilePaths(["", null, " docs/a.md "])).toEqual(["docs/a.md"]);
  });
});
