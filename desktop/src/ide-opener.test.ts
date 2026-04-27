import { describe, expect, it, vi } from "vitest";
import {
  listAvailableIdeTargets,
  openWorkspaceFileInIde,
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

describe("resolveWorkspaceFileAbsolutePath", () => {
  it("joins workspace root and relative file paths with native resolution", () => {
    expect(resolveWorkspaceFileAbsolutePath("/tmp/org", "skills/test/SKILL.md")).toBe("/tmp/org/skills/test/SKILL.md");
  });

  it("rejects paths outside the workspace root", () => {
    expect(() => resolveWorkspaceFileAbsolutePath("/tmp/org", "../outside.md"))
      .toThrow("Workspace file path must stay inside the workspace root.");
  });
});
