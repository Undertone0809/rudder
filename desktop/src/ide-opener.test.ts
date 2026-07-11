import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listAvailableIdeTargets,
  listWorkspaceLaunchTargets,
  openWorkspace,
  openWorkspaceFileInIde,
  openWorkspaceFileLocation,
  resolveWorkspaceFileAbsolutePath,
  resolveWorkspaceRootDirectory,
  windowsTerminalLaunchArgs,
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
  it("detects local editors, terminals, and the folder fallback in launcher order", async () => {
    const targets = await listWorkspaceLaunchTargets({
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) =>
        targetPath === "/Applications/Cursor.app"
        || targetPath === "/Applications/Visual Studio Code.app"
        || targetPath === "/System/Applications/Utilities/Terminal.app"
        || targetPath === "/Applications/Warp.app",
      commandExists: async () => false,
    });

    expect(targets).toEqual([
      { id: "cursor", label: "Cursor", kind: "ide", iconPath: "/Applications/Cursor.app" },
      { id: "vscode", label: "VS Code", kind: "ide", iconPath: "/Applications/Visual Studio Code.app" },
      { id: "terminal", label: "Terminal", kind: "terminal", iconPath: "/System/Applications/Utilities/Terminal.app" },
      { id: "warp", label: "Warp", kind: "terminal", iconPath: "/Applications/Warp.app" },
      { id: "finder", label: "Finder", kind: "folder", iconPath: "/System/Library/CoreServices/Finder.app" },
    ]);
  });

  it("detects installed Windows editors without requiring PATH commands or showing macOS-only launchers", async () => {
    const commandExists = vi.fn(async () => false);
    const targets = await listWorkspaceLaunchTargets({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        ProgramFiles: "C:\\Program Files",
        SystemRoot: "C:\\Windows",
      },
      pathExists: async (targetPath) =>
        targetPath === "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe"
        || targetPath === "C:\\Windows\\System32\\cmd.exe"
        || targetPath === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      commandExists,
    });

    expect(targets).toEqual([
      {
        id: "cursor",
        label: "Cursor",
        kind: "ide",
        iconPath: "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
      },
      {
        id: "commandPrompt",
        label: "Command Prompt",
        kind: "terminal",
        iconPath: "C:\\Windows\\System32\\cmd.exe",
      },
      {
        id: "powershell",
        label: "PowerShell",
        kind: "terminal",
        iconPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      },
      { id: "finder", label: "Folder", kind: "folder" },
    ]);
    expect(commandExists).not.toHaveBeenCalledWith("xed", "win32");
  });

  it("keeps the folder fallback available when no app or command is detected", async () => {
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

    const result = await openWorkspace(root, "cursor", {
      platform: "darwin",
      homeDir: "/Users/tester",
      pathExists: async (targetPath) => targetPath === "/Applications/Cursor.app",
      commandExists: async () => false,
      openDarwinApp,
    });

    expect(openDarwinApp).toHaveBeenCalledWith("/Applications/Cursor.app", root);
    expect(result).toEqual({
      id: "cursor",
      label: "Cursor",
      kind: "ide",
      absolutePath: root,
    });
  });

  it("opens an installed Windows IDE executable without shell command parsing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-windows-open-"));
    const runExecutable = vi.fn(async () => {});

    const result = await openWorkspace(root, "cursor", {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: {
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      },
      pathExists: async (targetPath) =>
        targetPath === "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
      commandExists: async () => false,
      runExecutable,
    });

    expect(runExecutable).toHaveBeenCalledWith(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
      root,
      "win32",
    );
    expect(result).toEqual({
      id: "cursor",
      label: "Cursor",
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

  it("opens Windows shell targets with the workspace root as cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-windows-shell-"));
    const runTerminalCommand = vi.fn(async () => {});

    await openWorkspace(root, "powershell", {
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
      },
      pathExists: async (targetPath) =>
        targetPath === "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      commandExists: async () => false,
      runTerminalCommand,
    });

    expect(runTerminalCommand).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      root,
      "win32",
    );
  });

  it("opens Command Prompt with the workspace root as cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-windows-cmd-"));
    const runTerminalCommand = vi.fn(async () => {});

    await openWorkspace(root, "commandPrompt", {
      platform: "win32",
      env: {
        SystemRoot: "C:\\Windows",
      },
      pathExists: async (targetPath) => targetPath === "C:\\Windows\\System32\\cmd.exe",
      commandExists: async () => false,
      runTerminalCommand,
    });

    expect(runTerminalCommand).toHaveBeenCalledWith("C:\\Windows\\System32\\cmd.exe", root, "win32");
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

  it("opens a workspace file with an installed Windows IDE executable", async () => {
    const runExecutable = vi.fn(async () => {});

    const result = await openWorkspaceFileInIde(
      "/Users/tester/workspaces/org-1",
      "plans/next-step.md",
      "cursor",
      {
        platform: "win32",
        homeDir: "C:\\Users\\tester",
        env: {
          LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        },
        pathExists: async (targetPath) =>
          targetPath === "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
        commandExists: async () => false,
        runExecutable,
      },
    );

    expect(runExecutable).toHaveBeenCalledWith(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Cursor\\Cursor.exe",
      "/Users/tester/workspaces/org-1/plans/next-step.md",
      "win32",
    );
    expect(result).toEqual({
      id: "cursor",
      label: "Cursor",
      absolutePath: "/Users/tester/workspaces/org-1/plans/next-step.md",
    });
  });

  it("opens a workspace file with the system default app", async () => {
    const openDefaultApp = vi.fn(async () => {});

    const result = await openWorkspaceFileInIde(
      "/Users/tester/workspaces/org-1",
      "plans/next-step.docx",
      "defaultApp",
      {
        platform: "darwin",
        pathExists: async () => false,
        commandExists: async () => false,
        openDefaultApp,
      },
    );

    expect(openDefaultApp).toHaveBeenCalledWith(
      "/Users/tester/workspaces/org-1/plans/next-step.docx",
      "darwin",
    );
    expect(result).toEqual({
      id: "defaultApp",
      label: "Default app",
      absolutePath: "/Users/tester/workspaces/org-1/plans/next-step.docx",
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

describe("openWorkspaceFileLocation", () => {
  it("reveals the selected file in the folder target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-file-location-"));
    const filePath = path.join("reports", "launch.md");
    await fs.mkdir(path.join(root, "reports"));
    await fs.writeFile(path.join(root, filePath), "# Launch\n", "utf8");
    const revealFile = vi.fn(async () => {});

    await openWorkspaceFileLocation(root, filePath, "finder", {
      platform: "darwin",
      pathExists: async () => false,
      commandExists: async () => false,
      revealFile,
    });

    expect(revealFile).toHaveBeenCalledWith(path.join(root, filePath), "darwin");
  });

  it("opens a terminal target with the file parent directory as cwd", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-file-terminal-"));
    const filePath = path.join("reports", "launch.md");
    await fs.mkdir(path.join(root, "reports"));
    await fs.writeFile(path.join(root, filePath), "# Launch\n", "utf8");
    const runTerminalCommand = vi.fn(async () => {});

    await openWorkspaceFileLocation(root, filePath, "terminal", {
      platform: "darwin",
      pathExists: async (targetPath) => targetPath === "/System/Applications/Utilities/Terminal.app",
      commandExists: async () => false,
      runTerminalCommand,
    });

    expect(runTerminalCommand).toHaveBeenCalledWith(
      "/System/Applications/Utilities/Terminal.app",
      path.join(root, "reports"),
      "darwin",
    );
  });

  it("rejects file locations that escape the workspace root", async () => {
    const revealFile = vi.fn(async () => {});

    await expect(
      openWorkspaceFileLocation("/tmp/org", "../secrets.txt", "finder", {
        platform: "darwin",
        pathExists: async () => false,
        commandExists: async () => false,
        revealFile,
      }),
    ).rejects.toThrow("Workspace file path must stay inside the workspace root.");
    expect(revealFile).not.toHaveBeenCalled();
  });

  it("rejects renderer-provided roots outside the trusted workspace home", async () => {
    const workspaceHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-trusted-workspaces-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-untrusted-workspace-"));
    await fs.writeFile(path.join(outsideRoot, "secret.md"), "secret\n", "utf8");
    const revealFile = vi.fn(async () => {});

    await expect(
      openWorkspaceFileLocation(outsideRoot, "secret.md", "finder", {
        platform: "darwin",
        allowedRootPaths: [workspaceHome],
        pathExists: async () => false,
        commandExists: async () => false,
        revealFile,
      }),
    ).rejects.toThrow("Workspace root is not inside an allowed workspace home.");
    expect(revealFile).not.toHaveBeenCalled();
  });

  it("rejects symlinks that resolve outside the trusted workspace root", async () => {
    const workspaceHome = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-trusted-workspaces-"));
    const root = path.join(workspaceHome, "example-org");
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-untrusted-workspace-"));
    await fs.mkdir(root);
    await fs.writeFile(path.join(outsideRoot, "secret.md"), "secret\n", "utf8");
    await fs.symlink(path.join(outsideRoot, "secret.md"), path.join(root, "linked.md"));
    const revealFile = vi.fn(async () => {});

    await expect(
      openWorkspaceFileLocation(root, "linked.md", "finder", {
        platform: "darwin",
        allowedRootPaths: [workspaceHome],
        pathExists: async () => false,
        commandExists: async () => false,
        revealFile,
      }),
    ).rejects.toThrow("Workspace file path must stay inside the workspace root.");
    expect(revealFile).not.toHaveBeenCalled();
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

describe("windowsTerminalLaunchArgs", () => {
  it("keeps Command Prompt and PowerShell sessions open after launch", () => {
    expect(windowsTerminalLaunchArgs("C:\\Windows\\System32\\cmd.exe")).toEqual(["/d", "/s", "/k"]);
    expect(windowsTerminalLaunchArgs("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toEqual([
      "-NoLogo",
      "-NoExit",
    ]);
    expect(windowsTerminalLaunchArgs("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toEqual(["-NoLogo", "-NoExit"]);
  });
});
