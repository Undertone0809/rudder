import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listAvailableIdeTargets,
  listWorkspaceLaunchTargets,
  openWorkspace,
  openWorkspaceFileInIde,
  resolveWorkspaceRootDirectory,
  resolveWorkspaceFileAbsolutePath,
} from "./ide-opener.js";

describe("listAvailableIdeTargets", () => {
  it("prefers detected macOS app bundles in the configured IDE order", async () => {
    const targets = await listAvailableIdeTargets({
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) =>
        targetPath === "/Applications/Cursor.app"
        || targetPath === "/Applications/Zed.app",
      commandExists: async () => false,
    });

    expect(targets).toEqual([
      { id: "cursor", label: "Cursor" },
      { id: "zed", label: "Zed" },
    ]);
  });

  it("falls back to PATH-based CLI detection when no macOS app bundle is present", async () => {
    const targets = await listAvailableIdeTargets({
      platform: "linux",
      pathExists: async () => false,
      commandExists: async (command) => command === "code" || command === "idea",
    });

    expect(targets).toEqual([
      { id: "vscode", label: "VS Code" },
      { id: "intellij", label: "IntelliJ IDEA" },
    ]);
  });
});

describe("listWorkspaceLaunchTargets", () => {
  it("detects editors, terminals, and the folder fallback in launcher order", async () => {
    const targets = await listWorkspaceLaunchTargets({
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) =>
        targetPath === "/Applications/Visual Studio Code.app"
        || targetPath === "/Applications/Cursor.app"
        || targetPath === "/Applications/Xcode.app"
        || targetPath === "/Applications/Terminal.app"
        || targetPath === "/Applications/Warp.app",
      commandExists: async () => false,
    });

    expect(targets).toEqual([
      { id: "vscode", label: "VS Code", kind: "ide" },
      { id: "cursor", label: "Cursor", kind: "ide" },
      { id: "xcode", label: "Xcode", kind: "ide" },
      { id: "terminal", label: "Terminal", kind: "terminal" },
      { id: "warp", label: "Warp", kind: "terminal" },
      { id: "finder", label: "Finder", kind: "folder" },
    ]);
  });

  it("keeps folder fallback available when no app or command is detected", async () => {
    const targets = await listWorkspaceLaunchTargets({
      platform: "linux",
      pathExists: async () => false,
      commandExists: async () => false,
    });

    expect(targets).toEqual([
      { id: "finder", label: "Folder", kind: "folder" },
    ]);
  });
});

describe("openWorkspace", () => {
  it("opens an IDE with the workspace root path", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-open-"));
    const openDarwinApp = vi.fn(async () => {});

    const result = await openWorkspace(root, "vscode", {
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) => targetPath === "/Applications/Visual Studio Code.app",
      commandExists: async () => false,
      openDarwinApp,
    });

    expect(openDarwinApp).toHaveBeenCalledWith("/Applications/Visual Studio Code.app", root);
    expect(result).toEqual({
      id: "vscode",
      label: "VS Code",
      kind: "ide",
      absolutePath: root,
    });
  });

  it("opens terminal targets with the workspace root as cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-terminal-"));
    const runTerminalCommand = vi.fn(async () => {});

    await openWorkspace(root, "terminal", {
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) => targetPath === "/Applications/Terminal.app",
      commandExists: async () => false,
      runTerminalCommand,
    });

    expect(runTerminalCommand).toHaveBeenCalledWith("/Applications/Terminal.app", root, "darwin");
  });

  it("opens Warp as a terminal target rooted at the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-warp-"));
    const runTerminalCommand = vi.fn(async () => {});

    await openWorkspace(root, "warp", {
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) => targetPath === "/Applications/Warp.app",
      commandExists: async () => false,
      runTerminalCommand,
    });

    expect(runTerminalCommand).toHaveBeenCalledWith("/Applications/Warp.app", root, "darwin");
  });

  it("opens the folder fallback with the workspace root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-folder-"));
    const openFolder = vi.fn(async () => {});

    await openWorkspace(root, "finder", {
      platform: "linux",
      pathExists: async () => false,
      commandExists: async () => false,
      openFolder,
    });

    expect(openFolder).toHaveBeenCalledWith(root, "linux");
  });
});

describe("openWorkspaceFileInIde", () => {
  it("opens the selected file with the preferred detected IDE", async () => {
    const openDarwinApp = vi.fn(async () => {});

    const result = await openWorkspaceFileInIde(
      "/Users/tester/workspaces/org-1",
      "plans/next-step.md",
      "cursor",
      {
        platform: "darwin",
        homeDir: "/Users/tester",
        pathExists: async (targetPath) => targetPath === "/Applications/Cursor.app",
        commandExists: async () => false,
        openDarwinApp,
      },
    );

    expect(openDarwinApp).toHaveBeenCalledWith(
      "/Applications/Cursor.app",
      "/Users/tester/workspaces/org-1/plans/next-step.md",
    );
    expect(result).toEqual({
      id: "cursor",
      label: "Cursor",
      absolutePath: "/Users/tester/workspaces/org-1/plans/next-step.md",
    });
  });

  it("rejects file paths that escape the workspace root", async () => {
    await expect(
      openWorkspaceFileInIde("/tmp/org", "../secrets.txt", "cursor", {
        platform: "linux",
        pathExists: async () => false,
        commandExists: async () => true,
      }),
    ).rejects.toThrow("Workspace file path must stay inside the workspace root.");
  });

  it("throws when the requested IDE is unavailable", async () => {
    await expect(
      openWorkspaceFileInIde("/tmp/org", "notes.md", "cursor", {
        platform: "linux",
        pathExists: async () => false,
        commandExists: async () => false,
      }),
    ).rejects.toThrow("No supported local IDE was detected.");
  });
});

describe("resolveWorkspaceRootDirectory", () => {
  it("resolves existing workspace root directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-root-"));

    await expect(resolveWorkspaceRootDirectory(root)).resolves.toBe(root);
  });

  it("rejects file paths as workspace roots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-file-root-"));
    const filePath = path.join(root, "notes.md");
    await fs.writeFile(filePath, "# Notes\n", "utf8");

    await expect(resolveWorkspaceRootDirectory(filePath)).rejects.toThrow("Workspace root must be a directory.");
  });
});

describe("resolveWorkspaceFileAbsolutePath", () => {
  it("joins workspace root and relative file paths with native resolution", () => {
    expect(resolveWorkspaceFileAbsolutePath("/tmp/org", "skills/test/SKILL.md")).toBe("/tmp/org/skills/test/SKILL.md");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => resolveWorkspaceFileAbsolutePath("/tmp/org", "../outside.md"))
      .toThrow("Workspace file path must stay inside the workspace root.");
  });
});
