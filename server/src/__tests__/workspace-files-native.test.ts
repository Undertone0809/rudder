import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listWorkspaceDirectoryNative,
  resolveNativeWorkspaceFilesBinary,
  WorkspaceFilesNativeError,
} from "../services/workspace-files-native.js";

const originalNativePath = process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH;
const cleanupDirs = new Set<string>();

afterEach(async () => {
  if (originalNativePath === undefined) delete process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH;
  else process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH = originalNativePath;
  await Promise.all([...cleanupDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("native workspace directory listing", () => {
  it("returns bounded portable entries from the real Rust binary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-list-"));
    cleanupDirs.add(root);
    await fs.mkdir(path.join(root, "projects", "zeta"), { recursive: true });
    await fs.writeFile(path.join(root, "projects", "alpha.md"), "alpha", "utf8");
    process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH = resolveNativeWorkspaceFilesBinary();

    await expect(listWorkspaceDirectoryNative(root, "projects")).resolves.toEqual([
      { name: "alpha.md", path: "projects/alpha.md", isDirectory: false },
      { name: "zeta", path: "projects/zeta", isDirectory: true },
    ]);
  });

  it("fails closed for traversal and cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-list-"));
    cleanupDirs.add(root);
    process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH = resolveNativeWorkspaceFilesBinary();

    const traversal = await listWorkspaceDirectoryNative(root, "../outside").catch((error) => error);
    expect(traversal).toBeInstanceOf(WorkspaceFilesNativeError);
    expect(traversal).toMatchObject({ code: "unsafe_workspace_path", pathRejected: true, fallbackAllowed: false });

    const controller = new AbortController();
    controller.abort();
    await expect(listWorkspaceDirectoryNative(root, "", controller.signal)).rejects.toMatchObject({
      code: "workspace_list_cancelled",
      fallbackAllowed: false,
    });
  });

  it.runIf(process.platform !== "win32")("does not trust an invalid native failure envelope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-list-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'wrong.capability', protocolVersion: 1, accepted: false, errorCode: 'workspace_directory_not_found' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILES_PATH = fakeBinary;

    await expect(listWorkspaceDirectoryNative(root, "projects")).rejects.toMatchObject({
      code: "workspace_list_process_failed",
      fallbackAllowed: true,
      pathRejected: false,
    });
  });
});
