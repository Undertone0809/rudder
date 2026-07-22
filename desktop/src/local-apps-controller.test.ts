import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LocalAppsController } from "./local-apps-controller.js";
import { LocalAppRegistry, type LocalAppDefinitionDraft } from "./local-apps-registry.js";

function draft(cwd: string): LocalAppDefinitionDraft {
  return {
    title: "Native review fixture",
    executable: process.execPath,
    argv: ["fixture.mjs", "--safe"],
    cwd,
    inheritedEnvNames: ["PATH", "RUDDER_TEST_TOKEN"],
    readiness: { path: "/api/health", timeoutMs: 5_000 },
    openPath: "/outreach",
  };
}

describe("Desktop Local Apps native controller", () => {
  it("confirms create and trusted-field changes, then starts an approved definition without another prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const confirmDefinition = vi.fn(async () => true);
    const runtime = {
      start: vi.fn(async () => ({ status: "running" })), stop: vi.fn(), status: vi.fn(async () => ({ status: "stopped" })),
      logs: vi.fn(), attestedTarget: vi.fn(), shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry,
      runtime,
      selectFolder: vi.fn(async () => null),
      confirmDefinition,
    });

    const created = await controller.createDefinition(draft(root));
    expect(confirmDefinition).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: await realpath(root),
      executable: process.execPath,
      argv: ["fixture.mjs", "--safe"],
      inheritedEnvNames: ["PATH", "RUDDER_TEST_TOKEN"],
      readiness: { path: "/api/health", timeoutMs: 5_000 },
      openPath: "/outreach",
    }), "create");
    await expect(registry.requireApprovedDefinition(created.id)).resolves.toBeTruthy();

    await controller.updateDefinition(created.id, { ...draft(root), openPath: "/changed" });
    expect(confirmDefinition).toHaveBeenLastCalledWith(expect.objectContaining({ openPath: "/changed" }), "update");
    await controller.start(created.id);
    expect(confirmDefinition).toHaveBeenCalledTimes(2);
    expect(runtime.start).toHaveBeenCalledWith(created.id);
  });

  it("reviews and approves an unapproved definition before start", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-review-start-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const definition = await registry.createDefinition(prepared);
    const confirmDefinition = vi.fn(async () => true);
    const runtime = {
      start: vi.fn(async () => ({ status: "running" })), stop: vi.fn(), status: vi.fn(async () => ({ status: "stopped" })),
      logs: vi.fn(), attestedTarget: vi.fn(), shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition,
    });
    await controller.start(definition.id);
    expect(confirmDefinition).toHaveBeenCalledOnce();
    expect(confirmDefinition).toHaveBeenCalledWith(expect.objectContaining({
      trustFingerprint: prepared.trustFingerprint,
    }), "start");
    await expect(registry.requireApprovedDefinition(definition.id)).resolves.toBeTruthy();
  });

  it("does not persist or start when native confirmation is canceled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-cancel-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const runtime = {
      start: vi.fn(), stop: vi.fn(), status: vi.fn(async () => ({ status: "stopped" })),
      logs: vi.fn(), attestedTarget: vi.fn(), shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry,
      runtime,
      selectFolder: vi.fn(async () => null),
      confirmDefinition: vi.fn(async () => false),
    });
    await expect(controller.createDefinition(draft(root))).rejects.toThrow("canceled");
    expect(await registry.listDefinitions()).toEqual([]);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("never deletes a running binding or implicitly stops it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-delete-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const definition = await registry.createDefinition(prepared);
    const runtime = {
      start: vi.fn(), stop: vi.fn(), status: vi.fn(async () => ({ status: "running" as const })),
      logs: vi.fn(), attestedTarget: vi.fn(), shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition: vi.fn(async () => true),
    });
    await expect(controller.deleteDefinition(definition.id)).rejects.toThrow("active");
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(await registry.listDefinitions()).toHaveLength(1);
  });
});
