import fs, { type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWorkspaceFileNative,
  readWorkspaceFileNode,
  readWorkspaceFileNodeBytes,
  WORKSPACE_FILE_PATH_MAX_BYTES,
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

  it("classifies native invalid UTF-8 as content rejection", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = resolveNativeWorkspaceFilesBinary();

    await expect(readWorkspaceFileNative(root, "invalid.md")).rejects.toMatchObject({
      code: "non_utf8_workspace_file",
      fallbackAllowed: false,
      contentRejected: true,
    });
  });

  it("fails closed for traversal, path limits, and cancellation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = resolveNativeWorkspaceFilesBinary();

    await expect(readWorkspaceFileNative(root, "../outside")).rejects.toMatchObject({
      code: "workspace_file_path_invalid",
      fallbackAllowed: false,
      pathRejected: false,
    });
    await expect(readWorkspaceFileNative(root, "a".repeat(WORKSPACE_FILE_PATH_MAX_BYTES + 1))).rejects.toMatchObject({
      code: "workspace_file_path_invalid",
      fallbackAllowed: false,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(readWorkspaceFileNative(root, "docs/readme.md", controller.signal)).rejects.toMatchObject({
      code: "workspace_file_cancelled",
      fallbackAllowed: false,
    });
  });

  it.runIf(process.platform !== "win32")("keeps the Node fallback bounded and cancellable", async () => {
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

  it.runIf(process.platform !== "win32")("rejects symlink escapes in the Node fallback", async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(outer);
    const root = path.join(outer, "workspace");
    const outside = path.join(outer, "outside.md");
    await fs.mkdir(root);
    await fs.writeFile(outside, "outside", "utf8");
    await fs.symlink(outside, path.join(root, "escape.md"));

    await expect(readWorkspaceFileNode(root, "escape.md")).rejects.toMatchObject({
      code: "workspace_path_escape",
      fallbackAllowed: false,
      pathRejected: true,
    });
  });

  it.runIf(process.platform !== "win32")("rejects invalid UTF-8 in the Node fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "invalid.md"), Buffer.from([0xc3, 0x28]));

    await expect(readWorkspaceFileNode(root, "invalid.md")).rejects.toMatchObject({
      code: "non_utf8_workspace_file",
      fallbackAllowed: false,
      contentRejected: true,
    });
  });

  it.runIf(process.platform !== "win32")("returns bounded raw bytes without decoding binary content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const bytes = Buffer.from([0, 0xc3, 0x28]);
    await fs.writeFile(path.join(root, "binary"), bytes);

    await expect(readWorkspaceFileNodeBytes(root, "binary")).resolves.toMatchObject({
      filePath: "binary",
      byteSize: bytes.length,
      bytes,
    });
  });

  it.runIf(process.platform !== "win32")("closes an in-flight Node fallback read when the request is aborted", async () => {
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

  it.runIf(process.platform === "win32")("fails closed instead of using an unsafe Node fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "readme.md"), "content", "utf8");

    await expect(readWorkspaceFileNode(root, "readme.md")).rejects.toMatchObject({
      code: "workspace_file_node_fallback_unsupported",
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
      code: "workspace_file_protocol_invalid",
      fallbackAllowed: false,
      pathRejected: false,
    });
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

  it.runIf(process.platform !== "win32")("fails closed when native containment cannot be proven", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'workspace.read', protocolVersion: 1, accepted: false, errorCode: 'workspace_file_containment_unproven' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).rejects.toMatchObject({
      code: "workspace_file_containment_unproven",
      fallbackAllowed: false,
      pathRejected: false,
    });
  });

  it.runIf(process.platform !== "win32")("fails closed when native file identity cannot be proven", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'workspace.read', protocolVersion: 1, accepted: false, errorCode: 'workspace_file_identity_unavailable' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).rejects.toMatchObject({
      code: "workspace_file_identity_unavailable",
      fallbackAllowed: false,
      pathRejected: false,
    });
  });

  it.runIf(process.platform !== "win32")("keeps ordinary native I/O failures eligible for fallback", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(
      fakeBinary,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({ ok: false, capability: 'workspace.read', protocolVersion: 1, accepted: false, errorCode: 'workspace_file_read_failed' }) + '\\n');",
        "process.exitCode = 2;",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;

    await expect(readWorkspaceFileNative(root, "docs/readme.md")).rejects.toMatchObject({
      code: "workspace_file_read_failed",
      fallbackAllowed: true,
      pathRejected: false,
    });
  });

  it("exports a typed native error for callers to classify", () => {
    expect(new WorkspaceFileNativeError("workspace_file_protocol_invalid", false, false))
      .toBeInstanceOf(WorkspaceFileNativeError);
  });
});
