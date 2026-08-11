import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { type AppBuilderDataManager } from "./app-builder-data.js";
import { AppBuilderController } from "./app-builder-ipc.js";
import {
  APP_BUILDER_MANIFEST_FILENAME,
  readAppBuilderManifest,
} from "./app-builder-manifest.js";
import type {
  AppBuilderPreviewBinding,
  AppBuilderPreviewController,
} from "./app-builder-preview.js";

function templateManifest() {
  return {
    schemaVersion: 1,
    app: { name: "Template App", slug: "template-app" },
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
      productionPath: "data/production/app.sqlite",
      developmentPath: "data/development/dev.sqlite",
      migrationsDir: "migrations",
      backupBeforeMigrate: true,
      exportFormat: "rudder-app-data/v1",
    },
    jobs: { mode: "in_process", lifecycle: "with_rudder", defaultCatchUpPolicy: "prompt" },
    secrets: [],
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-app-controller-"));
  const projectRoot = path.join(root, "project");
  const templateRoot = path.join(root, "template");
  await mkdir(path.join(templateRoot, "data", "production"), { recursive: true });
  await mkdir(projectRoot);
  await writeFile(
    path.join(templateRoot, APP_BUILDER_MANIFEST_FILENAME),
    JSON.stringify(templateManifest()),
  );
  await writeFile(path.join(templateRoot, "data", "production", "app.sqlite"), "template-data");
  await writeFile(path.join(templateRoot, "package.json"), "{}\n");
  return { root, projectRoot, templateRoot };
}

describe("App Builder controller facade", () => {
  it("scaffolds and inspects the real bundled Skill asset", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-real-app-asset-"));
    const templateRoot = fileURLToPath(new URL(
      "../../server/resources/bundled-skills/app-builder/assets/scaffold",
      import.meta.url,
    ));
    const controller = new AppBuilderController({
      templateRoot,
      resolveProjectRoot: async () => root,
      preview: {} as AppBuilderPreviewController,
      data: {} as AppBuilderDataManager,
      selectExportDirectory: async () => null,
      selectImportPackage: async () => null,
    });
    await controller.scaffold("project-1", "crm", "real-crm", "Real CRM");
    const inspected = await controller.inspect("project-1", "crm");
    expect(inspected.manifest.app).toEqual({ name: "Real CRM", slug: "real-crm" });
    expect(inspected.manifest.runtime.engine).toBe("managed-node-22");
    expect(JSON.parse(await readFile(path.join(root, "crm", "package.json"), "utf8")))
      .toMatchObject({ name: "real-crm" });
    expect(JSON.parse(await readFile(path.join(root, "crm", "rudder.ui.json"), "utf8")))
      .toMatchObject({ preset: "rudder", revision: 1, sourceOwnership: "app" });
    expect(JSON.parse(await readFile(path.join(root, "crm", "components.json"), "utf8")))
      .toMatchObject({ style: "new-york", iconLibrary: "lucide" });
    await expect(readFile(path.join(root, "crm", "components", "ui", "table.tsx"), "utf8"))
      .resolves.toContain("export function Table");
    await expect(readFile(path.join(root, "crm", "next.config.ts"), "utf8"))
      .resolves.toContain("commonjs ${request}");
  });

  it("creates a customized app from the fixed official scaffold", async () => {
    const { projectRoot, templateRoot } = await fixture();
    const controller = new AppBuilderController({
      templateRoot,
      resolveProjectRoot: async () => projectRoot,
      preview: {} as AppBuilderPreviewController,
      data: {} as AppBuilderDataManager,
      selectExportDirectory: async () => null,
      selectImportPackage: async () => null,
    });

    const result = await controller.scaffold(
      "project-1",
      "apps/cold-email",
      "cold-email-crm",
      "Cold Email CRM",
    );
    expect(result.manifest.app.slug).toBe("cold-email-crm");
    expect(result.manifest.app.name).toBe("Cold Email CRM");
    await expect(readAppBuilderManifest(path.join(projectRoot, "apps", "cold-email")))
      .resolves.toEqual(result.manifest);
  });

  it("stops a running managed preview before snapshotting real data and strips internal paths", async () => {
    const { projectRoot, templateRoot } = await fixture();
    const appRoot = path.join(projectRoot, "app");
    await mkdir(path.join(appRoot, "data", "development"), { recursive: true });
    await mkdir(path.join(appRoot, "data", "production"), { recursive: true });
    await writeFile(
      path.join(appRoot, APP_BUILDER_MANIFEST_FILENAME),
      JSON.stringify({ ...templateManifest(), app: { name: "CRM", slug: "cold-email-crm" } }),
    );
    await writeFile(path.join(appRoot, "data", "development", "dev.sqlite"), "preview-data");
    await writeFile(path.join(appRoot, "data", "production", "app.sqlite"), "real-data");

    const preview = {
      assertBinding: vi.fn(async () => undefined),
      status: vi.fn(async () => ({ status: "running", generation: "generation" })),
      stop: vi.fn(async () => ({ status: "stopped", generation: "generation" })),
    };
    const data = {
      snapshot: vi.fn(async () => ({
        id: "snapshot-1",
        root: "/internal/never-return-this",
        manifest: {
          schemaVersion: 1,
          kind: "rudder-app-data",
          appId: "cold-email-crm",
          createdAt: "2026-07-29T00:00:00.000Z",
          files: [],
        },
      })),
      rollbackRelease: vi.fn(async () => ({
        safetySnapshot: {
          id: "safety-1",
          root: "/internal/safety",
          manifest: {
            schemaVersion: 1,
            kind: "rudder-app-data",
            appId: "cold-email-crm",
            createdAt: "2026-07-29T00:00:00.000Z",
            files: [],
          },
        },
      })),
    };
    const controller = new AppBuilderController({
      templateRoot,
      resolveProjectRoot: async () => projectRoot,
      preview: preview as unknown as AppBuilderPreviewController,
      data: data as unknown as AppBuilderDataManager,
      selectExportDirectory: async () => null,
      selectImportPackage: async () => null,
    });
    const binding: AppBuilderPreviewBinding = {
      desktopInstallationId: "desktop",
      definitionId: "definition",
      appPublicId: "public",
      localBindingId: "binding",
    };

    const result = await controller.snapshot("project-1", "app", binding);
    expect(preview.stop).toHaveBeenCalledWith(binding);
    expect(data.snapshot).toHaveBeenCalled();
    expect(data.snapshot).toHaveBeenCalledWith(
      "binding",
      "cold-email-crm",
      path.join(appRoot, "data", "development"),
    );
    expect(preview.stop.mock.invocationCallOrder[0]).toBeLessThan(
      data.snapshot.mock.invocationCallOrder[0],
    );
    expect(result).not.toHaveProperty("root");
    expect(JSON.stringify(result)).not.toContain("/internal");
    expect(await readFile(path.join(appRoot, "data", "production", "app.sqlite"), "utf8"))
      .toBe("real-data");

    const rollback = await controller.rollbackRelease(
      "project-1",
      "app",
      "snapshot-1",
      null,
      binding,
    );
    expect(data.rollbackRelease).toHaveBeenCalledWith(expect.objectContaining({
      appKey: "binding",
      appId: "cold-email-crm",
      snapshotId: "snapshot-1",
      targetReleaseId: null,
    }));
    expect(rollback).not.toHaveProperty("root");
    expect(JSON.stringify(rollback)).not.toContain("/internal");
  });
});
