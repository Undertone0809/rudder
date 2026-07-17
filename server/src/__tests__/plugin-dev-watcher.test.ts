import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginDevWatcher,
  resolvePluginWatchTargets,
} from "../services/plugin-dev-watcher.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempPluginDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-watch-"));
  tempDirs.push(dir);
  return dir;
}

function createLifecycle() {
  const lifecycle = new EventEmitter() as EventEmitter & {
    restartWorker: ReturnType<typeof vi.fn>;
  };
  lifecycle.restartWorker = vi.fn(async () => undefined);
  return lifecycle;
}

describe("resolvePluginWatchTargets", () => {
  it("watches package metadata plus concrete declared runtime files", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "ui"), { recursive: true });
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@acme/example",
        rudderPlugin: {
          manifest: "./dist/manifest.js",
          worker: "./dist/worker.js",
          ui: "./dist/ui",
        },
      }),
    );
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "worker.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "ui", "index.css"), "body {}\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.css"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "ui", "index.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "worker.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
    ]);
  });

  it("falls back to dist when package metadata does not declare entrypoints", () => {
    const pluginDir = makeTempPluginDir();
    mkdirSync(path.join(pluginDir, "dist", "nested"), { recursive: true });
    writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/example" }));
    writeFileSync(path.join(pluginDir, "dist", "manifest.js"), "export default {};\n");
    writeFileSync(path.join(pluginDir, "dist", "nested", "chunk.js"), "export default {};\n");

    const targets = resolvePluginWatchTargets(pluginDir);

    expect(targets).toEqual([
      { path: path.join(pluginDir, "package.json"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "manifest.js"), recursive: false, kind: "file" },
      { path: path.join(pluginDir, "dist", "nested", "chunk.js"), recursive: false, kind: "file" },
    ]);
  });
});

describe("PluginDevWatcher lifecycle", () => {
  it("awaits every watcher handle close and prevents watches after close", async () => {
    const pluginDir = makeTempPluginDir();
    writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/example" }));
    let releaseFirstWatcher!: () => void;
    let releaseSecondWatcher!: () => void;
    const firstWatcherClosed = new Promise<void>((resolve) => {
      releaseFirstWatcher = resolve;
    });
    const secondWatcherClosed = new Promise<void>((resolve) => {
      releaseSecondWatcher = resolve;
    });
    const firstWatcherHandle = {
      close: vi.fn(() => firstWatcherClosed),
      on: vi.fn(),
    };
    const secondWatcherHandle = {
      close: vi.fn(() => secondWatcherClosed),
      on: vi.fn(),
    };
    firstWatcherHandle.on.mockReturnValue(firstWatcherHandle);
    secondWatcherHandle.on.mockReturnValue(secondWatcherHandle);
    const createWatcher = vi.fn()
      .mockReturnValueOnce(firstWatcherHandle)
      .mockReturnValueOnce(secondWatcherHandle);
    const watcher = createPluginDevWatcher(
      createLifecycle() as never,
      undefined,
      { watch: createWatcher as never },
    );
    watcher.watch("plugin-1", pluginDir);
    watcher.watch("plugin-2", pluginDir);

    const firstClose = watcher.close();
    const duplicateClose = watcher.close();
    let closeFinished = false;
    void firstClose.then(() => {
      closeFinished = true;
    });
    await Promise.resolve();

    expect(duplicateClose).toBe(firstClose);
    expect(firstWatcherHandle.close).toHaveBeenCalledTimes(1);
    expect(secondWatcherHandle.close).toHaveBeenCalledTimes(1);
    expect(closeFinished).toBe(false);
    watcher.watch("plugin-3", pluginDir);
    expect(createWatcher).toHaveBeenCalledTimes(2);

    releaseFirstWatcher();
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    releaseSecondWatcher();
    await firstClose;
    expect(closeFinished).toBe(true);
  });

  it("does not create a watcher when an async package resolver finishes after close", async () => {
    const pluginDir = makeTempPluginDir();
    writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@acme/example" }));
    let resolvePackagePath!: (packagePath: string) => void;
    const packagePath = new Promise<string>((resolve) => {
      resolvePackagePath = resolve;
    });
    const resolvePluginPackagePath = vi.fn(() => packagePath);
    const createWatcher = vi.fn();
    const lifecycle = createLifecycle();
    const watcher = createPluginDevWatcher(
      lifecycle as never,
      resolvePluginPackagePath,
      { watch: createWatcher as never },
    );
    lifecycle.emit("plugin.loaded", { pluginId: "plugin-1" });
    await vi.waitFor(() => expect(resolvePluginPackagePath).toHaveBeenCalledTimes(1));

    await watcher.close();
    resolvePackagePath(pluginDir);
    await packagePath;
    await Promise.resolve();
    expect(createWatcher).not.toHaveBeenCalled();
  });
});
