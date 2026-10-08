import { ChildProcess } from "node:child_process";
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

async function waitForPath(filePath: string) {
  await vi.waitFor(async () => {
    await fs.access(filePath);
  }, { timeout: 5_000, interval: 20 });
}

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
    const rootHandle = {
      stat: vi.fn(async () => await fs.stat(root)),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (requestedPath) => (
      String(requestedPath) === root ? rootHandle : handle
    ));
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
      expect(rootHandle.close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32")("fails closed when the workspace root is replaced during a read", async () => {
    const outer = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(outer);
    const root = path.join(outer, "workspace");
    const movedRoot = path.join(outer, "moved-workspace");
    const filePath = path.join(root, "mutable.md");
    await fs.mkdir(root);
    await fs.writeFile(filePath, "before", "utf8");
    const openedStat = await fs.stat(filePath);
    const rootStat = await fs.stat(root);
    const rootHandle = {
      stat: vi.fn(async () => rootStat),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const handle = {
      stat: vi.fn(async () => openedStat),
      read: vi.fn(async () => {
        await fs.rename(root, movedRoot);
        await fs.mkdir(root);
        await fs.writeFile(path.join(root, "mutable.md"), "replacement", "utf8");
        return { bytesRead: 0 };
      }),
      close: vi.fn(async () => undefined),
    } as unknown as FileHandle;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (requestedPath) => (
      String(requestedPath) === root ? rootHandle : handle
    ));
    try {
      await expect(readWorkspaceFileNodeBytes(root, "mutable.md")).rejects.toMatchObject({
        code: "workspace_file_changed",
        fallbackAllowed: false,
      });
      expect(rootHandle.close).toHaveBeenCalledTimes(1);
    } finally {
      openSpy.mockRestore();
    }
  });

  it.runIf(process.platform !== "win32").each(["immediate", "delayed", "ignored", "unconfirmed"] as const)(
    "cancels an in-flight native child and waits for close (%s SIGTERM exit)",
    { timeout: 30_000 },
    async (mode) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
      cleanupDirs.add(root);
      const startedPath = path.join(root, "native-started");
      const stoppedPath = path.join(root, "native-stopped");
      const releasePath = path.join(root, "native-release");
      const fakeBinary = path.join(root, "fake-native");
      await fs.writeFile(
        fakeBinary,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          // The ready marker must mean the SIGTERM handler is already installed.
          "process.on('SIGTERM', () => {",
          `  fs.writeFileSync(${JSON.stringify(stoppedPath)}, 'received');`,
          mode === "immediate" ? "  process.exit(143);" : "",
          mode === "delayed" ? `  setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(143); }, 10);` : "",
          "});",
          `fs.writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));`,
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;
      const controller = new AbortController();
      const originalKill = ChildProcess.prototype.kill;
      const killSpy = vi.spyOn(ChildProcess.prototype, "kill");
      let child: ChildProcess | undefined;
      let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let settled = false;
      let closedAtSettlement = false;
      const pending = readWorkspaceFileNative(root, "pending.md", controller.signal).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ).then((result) => {
        settled = true;
        closedAtSettlement = closed !== undefined;
        return result;
      });

      try {
        await waitForPath(startedPath);
        const pid = Number(await fs.readFile(startedPath, "utf8"));
        const abortedAt = Date.now();
        controller.abort();
        child = killSpy.mock.contexts[0] as ChildProcess | undefined;
        expect(child?.pid).toBe(pid);
        child!.once("close", (code, signal) => { closed = { code, signal }; });

        if (mode === "unconfirmed") {
          // Simulate an OS that cannot deliver the escalation; the real owned
          // child is killed and reaped unconditionally in finally below.
          killSpy.mockImplementation(function (this: ChildProcess, signal) {
            return signal === "SIGKILL" ? false : originalKill.call(this, signal);
          });
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          await vi.advanceTimersByTimeAsync(5_000);
          await expect(pending).resolves.toMatchObject({
            error: { code: "workspace_file_cleanup_failed", fallbackAllowed: false },
          });
          expect(closedAtSettlement).toBe(false);
          expect(closed).toBeUndefined();
          expect(child!.exitCode).toBeNull();
          expect(child!.signalCode).toBeNull();
          expect(() => process.kill(pid, 0)).not.toThrow();
          return;
        }
        if (mode === "delayed") {
          await waitForPath(stoppedPath);
          // Hold the handler open until the parent observes that cancellation
          // has not completed. This catches an immediate AbortError settlement.
          expect(settled).toBe(false);
          expect(closed).toBeUndefined();
          await fs.writeFile(releasePath, "exit");
        }
        await expect(pending).resolves.toMatchObject({
          error: { code: "workspace_file_cancelled", fallbackAllowed: false },
        });
        expect(closedAtSettlement).toBe(true);
        expect(closed).toEqual(mode === "ignored"
          ? { code: null, signal: "SIGKILL" }
          : { code: 143, signal: null });
        expect(child!.exitCode).toBe(closed!.code);
        expect(child!.signalCode).toBe(closed!.signal);
        expect(() => process.kill(pid, 0)).toThrow();
        expect(await fs.readFile(stoppedPath, "utf8")).toBe("received");
        expect(killSpy.mock.calls.map(([signal]) => signal ?? "SIGTERM")).toEqual(
          mode === "ignored" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"],
        );
        if (mode === "ignored") expect(Date.now() - abortedAt).toBeLessThan(5_000);
      } finally {
        vi.useRealTimers();
        controller.abort();
        child ??= killSpy.mock.contexts[0] as ChildProcess | undefined;
        if (child && child.exitCode === null && child.signalCode === null) {
          const close = new Promise<void>((resolve) => child!.once("close", () => resolve()));
          originalKill.call(child, "SIGKILL");
          await close;
        }
        await pending;
        killSpy.mockRestore();
      }
    },
  );

  it("preserves spawn failures and cancellation before a failed spawn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = path.join(root, "missing-native");
    await expect(readWorkspaceFileNative(root, "pending.md")).rejects.toMatchObject({
      code: "workspace_file_process_failed", fallbackAllowed: true,
    });

    const controller = new AbortController();
    const pending = readWorkspaceFileNative(root, "pending.md", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "workspace_file_cancelled", fallbackAllowed: false,
    });
  });

  it.runIf(process.platform !== "win32")("keeps the native timeout classification", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rudder-workspace-read-"));
    cleanupDirs.add(root);
    const fakeBinary = path.join(root, "fake-native");
    await fs.writeFile(fakeBinary, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
    process.env.RUDDER_NATIVE_WORKSPACE_FILE_PATH = fakeBinary;
    vi.stubEnv("RUDDER_NATIVE_WORKSPACE_FILE_TIMEOUT_MS", "100");
    try {
      await expect(readWorkspaceFileNative(root, "pending.md")).rejects.toMatchObject({
        code: "workspace_file_timeout", fallbackAllowed: true,
      });
    } finally {
      vi.unstubAllEnvs();
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
