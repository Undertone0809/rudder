import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { organizationWorkspaceBrowserService } from "../services/organization-workspace-browser.js";

const mocks = vi.hoisted(() => ({
  rootPath: "",
  getOrganization: vi.fn(),
  getOrCreateWorkspaceFileEntry: vi.fn(),
}));

vi.mock("../home-paths.js", () => ({
  ensureOrganizationWorkspaceLayout: vi.fn(),
  resolveOrganizationWorkspaceRoot: vi.fn(() => mocks.rootPath),
}));

vi.mock("../services/orgs.js", () => ({
  organizationService: () => ({ getById: mocks.getOrganization }),
}));

vi.mock("../services/library-entries.js", () => ({
  libraryEntryService: () => ({
    getOrCreateWorkspaceFileEntry: mocks.getOrCreateWorkspaceFileEntry,
  }),
}));

describe("organization workspace browser filesystem boundaries", () => {
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getOrganization.mockResolvedValue({ id: "organization-1" });
    mocks.getOrCreateWorkspaceFileEntry.mockResolvedValue({ id: "library-entry-1" });
  });

  afterEach(async () => {
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("rejects reads, attachments, updates, and creates through symbolic links", async () => {
    if (process.platform === "win32") return;

    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-browser-root-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-browser-outside-"));
    cleanupDirs.add(root);
    cleanupDirs.add(outsideRoot);
    mocks.rootPath = root;

    const projectRoot = path.join(root, "projects", "linked");
    const outsideFile = path.join(outsideRoot, "secret.md");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(outsideFile, "host secret\n", "utf8");
    await fs.symlink(outsideFile, path.join(projectRoot, "secret.md"));
    await fs.symlink(outsideRoot, path.join(projectRoot, "outside"), "dir");

    const workspaceBrowser = organizationWorkspaceBrowserService({} as any);
    await expect(workspaceBrowser.readFile("organization-1", "projects/linked/secret.md"))
      .rejects.toThrow("cannot traverse symbolic links");
    await expect(workspaceBrowser.readAttachmentFile("organization-1", "projects/linked/secret.md"))
      .rejects.toThrow("cannot traverse symbolic links");
    await expect(workspaceBrowser.writeFile("organization-1", "projects/linked/secret.md", "overwritten\n"))
      .rejects.toThrow("cannot traverse symbolic links");
    await expect(workspaceBrowser.createFile("organization-1", "projects/linked/outside/created.md", "escaped\n"))
      .rejects.toThrow("cannot traverse symbolic links");

    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("host secret\n");
    await expect(fs.stat(path.join(outsideRoot, "created.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues to read and update regular files inside the Library root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-browser-regular-"));
    cleanupDirs.add(root);
    mocks.rootPath = root;

    const filePath = path.join(root, "projects", "safe", "notes.md");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "before\n", "utf8");

    const workspaceBrowser = organizationWorkspaceBrowserService({} as any);
    await expect(workspaceBrowser.readFile("organization-1", "projects/safe/notes.md"))
      .resolves.toMatchObject({ content: "before\n" });
    await expect(workspaceBrowser.writeFile("organization-1", "projects/safe/notes.md", "after\n"))
      .resolves.toMatchObject({ content: "after\n" });
    await expect(fs.readFile(filePath, "utf8")).resolves.toBe("after\n");
  });
});
