import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { APP_BUILDER_INHERITED_ENV_NAMES } from "./app-builder-package-store.mjs";
import { AppBuilderPreviewController } from "./app-builder-preview.js";
import { LocalAppRegistry } from "./local-apps-registry.js";

function manifest(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rudder-app-preview-"));
  const appRoot = path.join(root, "app");
  await mkdir(appRoot);
  const registry = new LocalAppRegistry({
    registryPath: path.join(root, "registry.json"),
    installationId: "desktop-installation",
  });
  const localApps = {
    start: vi.fn(async () => ({
      status: "running" as const,
      generation: "generation",
      origin: "http://127.0.0.1:43123",
      openPath: "/",
    })),
    stop: vi.fn(async () => ({ status: "stopped" as const, generation: "generation" })),
    status: vi.fn(async () => ({ status: "stopped" as const, generation: null })),
    attestedTarget: vi.fn(async () => ({
      origin: "http://127.0.0.1:43123",
      openPath: "/",
      partition: "persist:test",
    })),
    createDefinition: vi.fn(async (draft: unknown) => {
      const created = await registry.createDefinition(draft as never);
      return registry.approveDefinition(created.id, created.trustFingerprint);
    }),
    updateDefinition: vi.fn(async (id: string, draft: unknown) => {
      const status = await localApps.status(id);
      if (status.status === "running") throw new Error("Cannot update an active Local App");
      const updated = await registry.updateDefinition(id, draft as never);
      return registry.approveDefinition(updated.id, updated.trustFingerprint);
    }),
  };
  const controller = new AppBuilderPreviewController({
    registry,
    localApps,
    runnerExecutable: process.execPath,
    buildRunnerArgv: ({ appRoot: managedRoot }) => ["runner.mjs", "--app-root", managedRoot],
    inheritedEnvNames: APP_BUILDER_INHERITED_ENV_NAMES,
  });
  return { root, appRoot, registry, localApps, controller };
}

describe("App Builder managed preview", () => {
  it("routes an existing app without fresh scaffold provenance through native Local App review", async () => {
    const { appRoot, localApps, controller } = await fixture();
    const binding = await controller.ensureBinding({ appRoot, manifest: manifest() });
    expect(localApps.createDefinition).toHaveBeenCalledOnce();
    expect(binding.desktopInstallationId).toBe("desktop-installation");
  });

  it("creates and internally approves a fixed-runner Local App definition", async () => {
    const { appRoot, registry, controller } = await fixture();
    const binding = await controller.ensureBinding({
      appRoot,
      manifest: manifest(),
      allowManagedAutoApproval: true,
    });
    const definition = await registry.getDefinition(binding.definitionId);
    const canonicalAppRoot = await realpath(appRoot);

    expect(definition.cwd).toBe(canonicalAppRoot);
    expect(definition.executable).toBe(process.execPath);
    expect(definition.argv).toEqual(["runner.mjs", "--app-root", canonicalAppRoot]);
    expect(definition.inheritedEnvNames).toEqual(APP_BUILDER_INHERITED_ENV_NAMES);
    expect(definition.approvedFingerprint).toBe(definition.trustFingerprint);
    expect(binding.localBindingId).toBe(binding.definitionId);
  });

  it("reuses the binding, refreshes inactive definitions, and rejects active command changes", async () => {
    const { appRoot, registry, localApps, controller } = await fixture();
    const binding = await controller.ensureBinding({ appRoot, manifest: manifest(), allowManagedAutoApproval: true });
    const refreshed = await controller.ensureBinding({
      appRoot,
      manifest: manifest({ app: { name: "Renamed CRM", slug: "cold-email-crm" } }),
      binding,
    });
    expect(refreshed).toEqual(binding);
    expect((await registry.getDefinition(binding.definitionId)).title).toBe("Renamed CRM");
    expect(await registry.listDefinitions()).toHaveLength(1);

    localApps.status.mockResolvedValueOnce({ status: "running", generation: "generation" });
    await expect(controller.ensureBinding({
      appRoot,
      manifest: manifest({
        runtime: { ...manifest().runtime, openPath: "/dashboard" },
      }),
      binding,
    })).rejects.toThrow("active");
  });

  it("will not repurpose a persisted binding for another app root", async () => {
    const { root, appRoot, controller } = await fixture();
    const binding = await controller.ensureBinding({ appRoot, manifest: manifest(), allowManagedAutoApproval: true });
    const anotherRoot = path.join(root, "another-app");
    await mkdir(anotherRoot);
    await expect(controller.ensureBinding({
      appRoot: anotherRoot,
      manifest: manifest(),
      binding,
    })).rejects.toThrow("another app root");
  });

  it("stops a preview that starts without an attested loopback target", async () => {
    const { appRoot, localApps, controller } = await fixture();
    const binding = await controller.ensureBinding({ appRoot, manifest: manifest(), allowManagedAutoApproval: true });
    localApps.attestedTarget.mockResolvedValueOnce(null);
    await expect(controller.start(binding)).rejects.toThrow("attested target");
    expect(localApps.stop).toHaveBeenCalledWith(binding.definitionId);
  });
});
