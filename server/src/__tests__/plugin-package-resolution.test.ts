import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginRecord } from "@rudderhq/shared";
import { resolvePluginUiDir } from "../routes/plugin-ui-static.js";
import { resolveWorkerEntrypoint } from "../services/plugin-loader.worker-paths.js";

function makePluginRecord(
  packagePath: string | null = null,
  packageName = "@rudderhq/plugin-linear",
): PluginRecord & { packagePath?: string | null } {
  return {
    id: "plugin-1",
    pluginKey: "rudder.linear",
    packageName,
    version: "0.1.0",
    apiVersion: 1,
    categories: ["connector"],
    status: "ready",
    manifestJson: {
      id: "rudder.linear",
      apiVersion: 1,
      version: "0.1.0",
      displayName: "Linear",
      description: "Import-first Linear connector for Rudder issues.",
      author: "Rudder",
      categories: ["connector"],
      capabilities: [],
      entrypoints: {
        worker: "./dist/worker.js",
        ui: "./dist/ui",
      },
    },
    installOrder: null,
    installedAt: new Date(),
    updatedAt: new Date(),
    packagePath,
    lastError: null,
  } as PluginRecord & { packagePath?: string | null };
}

describe("plugin package resolution", () => {
  it("falls back to the bundled first-party plugin worker when the managed install is missing", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const bundledWorker = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "worker.js",
    );
    mkdirSync(path.dirname(bundledWorker), { recursive: true });
    writeFileSync(bundledWorker, "export default {};\n");

    expect(
      resolveWorkerEntrypoint(makePluginRecord(), localPluginDir, { serverPackageRoot }),
    ).toBe(bundledWorker);
  });

  it("falls back to the bundled first-party plugin worker when the persisted package path is stale", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-stale-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const stalePackagePath = path.join(tempRoot, "stale-linear");
    const bundledWorker = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "worker.js",
    );
    mkdirSync(stalePackagePath, { recursive: true });
    mkdirSync(path.dirname(bundledWorker), { recursive: true });
    writeFileSync(bundledWorker, "export default {};\n");

    expect(
      resolveWorkerEntrypoint(makePluginRecord(stalePackagePath), localPluginDir, { serverPackageRoot }),
    ).toBe(bundledWorker);
  });

  it("does not resolve similarly named third-party packages to first-party bundled plugin workers", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-third-party-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const bundledWorker = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "worker.js",
    );
    mkdirSync(path.dirname(bundledWorker), { recursive: true });
    writeFileSync(bundledWorker, "export default {};\n");

    expect(() =>
      resolveWorkerEntrypoint(makePluginRecord(null, "@acme/plugin-linear"), localPluginDir, { serverPackageRoot }),
    ).toThrow("Worker entrypoint not found");
  });

  it("falls back to the bundled first-party plugin UI directory when the managed install is missing", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-ui-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const bundledUi = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "ui",
    );
    mkdirSync(bundledUi, { recursive: true });

    expect(
      resolvePluginUiDir(
        localPluginDir,
        "@rudderhq/plugin-linear",
        "./dist/ui",
        null,
        { serverPackageRoot },
      ),
    ).toBe(bundledUi);
  });

  it("falls back to the bundled first-party plugin UI directory when the persisted package path is stale", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-stale-ui-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const stalePackagePath = path.join(tempRoot, "stale-linear");
    const bundledUi = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "ui",
    );
    mkdirSync(stalePackagePath, { recursive: true });
    mkdirSync(bundledUi, { recursive: true });

    expect(
      resolvePluginUiDir(
        localPluginDir,
        "@rudderhq/plugin-linear",
        "./dist/ui",
        stalePackagePath,
        { serverPackageRoot },
      ),
    ).toBe(bundledUi);
  });

  it("does not resolve similarly named third-party UI packages to first-party bundled plugins", () => {
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rudder-plugin-third-party-ui-resolution-"));
    const localPluginDir = path.join(tempRoot, "plugins");
    const serverPackageRoot = path.join(tempRoot, "server");
    const bundledUi = path.join(
      serverPackageRoot,
      "dist",
      "bundled-plugins",
      "plugin-linear",
      "dist",
      "ui",
    );
    mkdirSync(bundledUi, { recursive: true });

    expect(
      resolvePluginUiDir(
        localPluginDir,
        "@acme/plugin-linear",
        "./dist/ui",
        null,
        { serverPackageRoot },
      ),
    ).toBeNull();
  });
});
