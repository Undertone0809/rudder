import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APP_BUILDER_MANIFEST_FILENAME,
  parseAppBuilderManifest,
  readAppBuilderManifest,
  resolveAppBuilderPath,
} from "./app-builder-manifest.js";

function validManifest() {
  return {
    schemaVersion: 1,
    app: { name: "Cold Email CRM", slug: "cold-email-crm" },
    template: { id: "rudder-next-sqlite", revision: 1 },
    runtime: {
      engine: "managed-node-22",
      packageManager: "managed-pnpm",
      readinessPath: "/api/health",
      openPath: "/",
      readinessTimeoutMs: 30_000,
    },
    data: {
      provider: "sqlite",
      productionPath: "data/app.sqlite",
      developmentPath: "data/dev.sqlite",
      migrationsDir: "migrations",
      backupBeforeMigrate: true,
      exportFormat: "rudder-app-data/v1",
    },
    jobs: { mode: "in_process", lifecycle: "with_rudder", defaultCatchUpPolicy: "prompt" },
    secrets: [],
  };
}

describe("App Builder manifest", () => {
  it("accepts the real bundled App Builder scaffold manifest", async () => {
    const assetPath = fileURLToPath(new URL(
      "../../server/resources/bundled-skills/app-builder/assets/scaffold/rudder.app.json",
      import.meta.url,
    ));
    const asset = JSON.parse(await readFile(assetPath, "utf8")) as unknown;
    expect(parseAppBuilderManifest(asset)).toEqual(asset);
    expect(parseAppBuilderManifest(asset).runtime.readinessTimeoutMs).toBe(600_000);
  });

  it("accepts the fixed official scaffold contract", () => {
    expect(parseAppBuilderManifest(validManifest())).toEqual(validManifest());
  });

  it.each([
    ["parent traversal", { data: { ...validManifest().data, productionPath: "../outside" } }],
    ["Windows absolute path", { data: { ...validManifest().data, productionPath: "C:\\Users\\data" } }],
    ["POSIX absolute path", { data: { ...validManifest().data, productionPath: "/tmp/data" } }],
    ["unknown scaffold", { template: { id: "custom", revision: 1 } }],
    ["cross-origin readiness route", { runtime: { ...validManifest().runtime, readinessPath: "//example.com" } }],
    ["unsupported field", { arbitraryCommand: "rm -rf" }],
  ])("rejects %s", (_label, change) => {
    const manifest = {
      ...validManifest(),
      ...change,
    };
    expect(() => parseAppBuilderManifest(manifest)).toThrow();
  });

  it("reads a bounded regular manifest from the app root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-app-manifest-"));
    await writeFile(
      path.join(root, APP_BUILDER_MANIFEST_FILENAME),
      JSON.stringify(validManifest()),
    );
    await expect(readAppBuilderManifest(root)).resolves.toEqual(validManifest());
  });

  it.runIf(process.platform !== "win32")(
    "rejects an existing path that resolves through a symlink outside the app root",
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), "rudder-app-path-"));
      const outside = await mkdtemp(path.join(tmpdir(), "rudder-app-path-outside-"));
      await mkdir(path.join(outside, "data"));
      await symlink(outside, path.join(root, "linked"));
      await expect(resolveAppBuilderPath(root, "linked/data", { mustExist: true }))
        .rejects.toThrow("outside");
    },
  );
});
