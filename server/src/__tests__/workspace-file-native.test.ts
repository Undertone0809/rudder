import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkspaceFileNative,
  readWorkspaceFileNode,
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

  it("keeps the Node fallback bounded and cancellable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "large.md"), Buffer.alloc(1_000_001, 97));

    await expect(readWorkspaceFileNode(root, "large.md")).rejects.toMatchObject({
      code: "workspace_file_size_limit",
      fallbackAllowed: false,
      limitExceeded: true,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(readWorkspaceFileNode(root, "large.md", controller.signal)).rejects.toMatchObject({
      code: "workspace_file_cancelled",
      fallbackAllowed: false,
    });
  });

  it("rejects invalid UTF-8 in the Node fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(readWorkspaceFileNode(root, "invalid.md")).rejects.toMatchObject({
      code: "non_utf8_workspace_file",
      fallbackAllowed: false,
      contentRejected: true,
    });
  });

  it("closes an in-flight Node fallback read when the request is aborted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const filePath = path.join(root, "pending.md");
    await fs.writeFile(filePath, "pending", "utf8");
    const stat = await fs.stat(filePath);
    let resolveRead!: (result: { bytesRead: number }) => void;
    let resolveReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      resolveReadStarted = resolve;
    });
    const readResult = new Promise<{ bytesRead: number }>((resolve) => {
      resolveRead = resolve;
    });
    const handle = {
      stat: vi.fn(async () => stat),
      read: vi.fn(async () => {
        resolveReadStarted();
        return readResult;
      }),
      close: vi.fn(async () => {
        resolveRead({ bytesRead: 0 });
      }),
    } as unknown as FileHandle;
    const openSpy = vi.spyOn(fs, "open").mockResolvedValue(handle);
    const controller = new AbortController();
    try {
      const pending = readWorkspaceFileNode(root, "pending.md", controller.signal);
      await readStarted;
      controller.abort();

      await expect(pending).rejects.toMatchObject({
        code: "workspace_file_cancelled",
        fallbackAllowed: false,
      });
      expect(handle.close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
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

  it.runIf(process.platform !== "win32")("does not fall back after the native size boundary is reached", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'workspace.read', protocolVersion: 1, accepted: false, errorCode: 'workspace_file_size_limit' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).rejects.toMatchObject({
      code: "workspace_file_size_limit",
      fallbackAllowed: false,
      limitExceeded: true,
    });
  });
});
