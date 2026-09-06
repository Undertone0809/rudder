import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readWorkspaceFileNative,
  WorkspaceFileNativeError,
} from "../services/workspace-file-native.js";
import { resolveNativeWorkspaceFilesBinary } from "../services/workspace-files-native.js";

const originalNativePath = process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH;
const cleanupDirs = new Set<string>();

afterEach(async () => {
  if (originalNativePath === undefined) delete process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH;
  else process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = originalNativePath;
  await Promise.all([...cleanupDirs].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("native workspace file reads", () => {
  it("returns bounded UTF-8 content from the real Rust binary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "readme.md"), "Aé🙂Z", "utf8");
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = resolveNativeWorkspaceFilesBinary();

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).resolves.toMatchObject({
      filePath: "docs/readme.md",
      byteSize: 8,
      content: "Aé🙂Z",
    });
  });

  it("fails closed for traversal and cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = resolveNativeWorkspaceFilesBinary();

    await expect(readWorkspaceFileNative(root, "../outside")).rejects.toMatchObject({
      code: "workspace_file_path_invalid",
      fallbackAllowed: false,
      pathRejected: false,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(readWorkspaceFileNative(root, "docs/readme.md", controller.signal)).rejects.toMatchObject({
      code: "workspace_file_cancelled",
      fallbackAllowed: false,
    });
  });

  it.runIf(process.platform !== "win32")("does not trust an invalid native failure envelope", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'wrong.capability', protocolVersion: 1, accepted: false, errorCode: 'workspace_file_not_found' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).rejects.toMatchObject({
      code: "workspace_file_process_failed",
      fallbackAllowed: true,
      pathRejected: false,
    });
    expect(WorkspaceFileNativeError).toBeDefined();
  });
});
