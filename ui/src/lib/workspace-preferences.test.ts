// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as workspacePreferences from "./workspace-preferences";
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
  it("exposes an unsupported-file target resolver", () => {
    expect("workspaceUnsupportedFileLaunchTargets" in workspacePreferences).toBe(true);
  });

  it("builds unsupported-file targets from the currently available Desktop capabilities", () => {
    const targets = workspacePreferences.workspaceUnsupportedFileLaunchTargets([
      { id: "vscode", label: "VS Code", kind: "ide" },
      { id: "xcode", label: "Xcode", kind: "ide" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "finder", label: "Finder", kind: "folder" },
    ], {
      canOpenFile: true,
      canOpenLocation: true,
    });

    expect(targets.map((target: { id: string }) => target.id)).toEqual([
      "defaultApp",
      "vscode",
      "terminal",
      "finder",
    ]);
    expect(workspacePreferences.workspaceUnsupportedFileLaunchTargets([
      { id: "terminal", label: "Terminal", kind: "terminal" },
    ], {
      canOpenFile: true,
      canOpenLocation: false,
    }).map((target: { id: string }) => target.id)).toEqual(["defaultApp"]);
    expect(workspacePreferences.workspaceUnsupportedFileLaunchTargets([], {
      canOpenFile: false,
      canOpenLocation: true,
    })).toEqual([]);
  });

  it("restores only a currently compatible unsupported-file target", () => {
    const targets = workspacePreferences.workspaceUnsupportedFileLaunchTargets([
      { id: "vscode", label: "VS Code", kind: "ide" },
      { id: "finder", label: "Finder", kind: "folder" },
    ], {
      canOpenFile: true,
      canOpenLocation: true,
    });
    const resolve = (workspacePreferences as typeof workspacePreferences & {
      resolveWorkspaceUnsupportedFileLaunchTarget: (
        targets: Array<{ id: string }>,
        storedId: string | null,
      ) => { id: string } | null;
    }).resolveWorkspaceUnsupportedFileLaunchTarget;

    expect(resolve(targets, "finder")?.id).toBe("finder");
    expect(resolve(targets, "terminal")?.id).toBe("defaultApp");
    expect(resolve(targets, "xcode")?.id).toBe("defaultApp");
  });

  it("persists valid successful unsupported-file targets and ignores malformed storage", () => {
    const preferences = workspacePreferences as typeof workspacePreferences & {
      readStoredWorkspaceUnsupportedFileLaunchTargetId: () => string | null;
      writeStoredWorkspaceUnsupportedFileLaunchTargetId: (targetId: string) => void;
    };
    preferences.writeStoredWorkspaceUnsupportedFileLaunchTargetId("finder");
    expect(preferences.readStoredWorkspaceUnsupportedFileLaunchTargetId()).toBe("finder");
    window.localStorage.setItem("rudder.workspace.unsupportedFileLaunchTargetId", "unknown-app");
    expect(preferences.readStoredWorkspaceUnsupportedFileLaunchTargetId()).toBeNull();
  });

  it("treats a blocked unsupported-file preference read as no stored target", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage access denied", "SecurityError");
    });

    expect(workspacePreferences.readStoredWorkspaceUnsupportedFileLaunchTargetId()).toBeNull();
    expect(getItem).toHaveBeenCalledWith("rudder.workspace.unsupportedFileLaunchTargetId");
  });

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
