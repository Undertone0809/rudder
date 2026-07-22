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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("Desktop Local Apps native controller", () => {
  it("does not let start overtake an in-flight stop for the same binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-stop-start-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.approveDefinition(created.id, prepared.trustFingerprint);

    const stopEntered = deferred<void>();
    const releaseStop = deferred<void>();
    const calls: string[] = [];
    const runtime = {
      start: vi.fn(async () => {
        calls.push("start");
        return { status: "running" as const };
      }),
      stop: vi.fn(async () => {
        calls.push("stop-entered");
        stopEntered.resolve();
        await releaseStop.promise;
        calls.push("stop-finished");
        return { status: "stopped" as const };
      }),
      status: vi.fn(async () => ({ status: "stopped" as const })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition: vi.fn(async () => true),
    });

    const stopping = controller.stop(created.id);
    await stopEntered.promise;
    const starting = controller.start(created.id);
    await nextTurn();
    expect(runtime.start).not.toHaveBeenCalled();

    releaseStop.resolve();
    await expect(Promise.all([stopping, starting])).resolves.toEqual([
      { status: "stopped" },
      { status: "running" },
    ]);
    expect(calls).toEqual(["stop-entered", "stop-finished", "start"]);
  });

  it("does not let stop overtake an in-flight start for the same binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-start-stop-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.approveDefinition(created.id, prepared.trustFingerprint);

    const startEntered = deferred<void>();
    const releaseStart = deferred<void>();
    const calls: string[] = [];
    const runtime = {
      start: vi.fn(async () => {
        calls.push("start-entered");
        startEntered.resolve();
        await releaseStart.promise;
        calls.push("start-finished");
        return { status: "running" as const };
      }),
      stop: vi.fn(async () => {
        calls.push("stop");
        return { status: "stopped" as const };
      }),
      status: vi.fn(async () => ({ status: "stopped" as const })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition: vi.fn(async () => true),
    });

    const starting = controller.start(created.id);
    await startEntered.promise;
    const stopping = controller.stop(created.id);
    await nextTurn();
    expect(runtime.stop).not.toHaveBeenCalled();

    releaseStart.resolve();
    await expect(Promise.all([starting, stopping])).resolves.toEqual([
      { status: "running" },
      { status: "stopped" },
    ]);
    expect(calls).toEqual(["start-entered", "start-finished", "stop"]);
  });

  it("closes admission before waiting for a blocked native start approval during shutdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-shutdown-approval-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    const approvalEntered = deferred<void>();
    const releaseApproval = deferred<boolean>();
    const runtime = {
      start: vi.fn(async () => ({ status: "running" as const })),
      stop: vi.fn(),
      status: vi.fn(async () => ({ status: "stopped" as const })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(async () => undefined),
    };
    const controller = new LocalAppsController({
      registry,
      runtime,
      selectFolder: vi.fn(async () => null),
      confirmDefinition: vi.fn(async (_definition, action) => {
        if (action === "start") {
          approvalEntered.resolve();
          return releaseApproval.promise;
        }
        return true;
      }),
    });

    const starting = controller.start(created.id);
    await approvalEntered.promise;
    const shuttingDown = controller.shutdown();
    await nextTurn();
    expect(runtime.shutdown).not.toHaveBeenCalled();

    releaseApproval.resolve(true);
    await expect(starting).rejects.toThrow("shutting down");
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(runtime.start).not.toHaveBeenCalled();
    expect((await registry.getDefinition(created.id)).approvedFingerprint).toBeNull();
    await expect(controller.start(created.id)).rejects.toThrow("shutting down");
  });

  it("does not let delete overtake an in-flight start for the same binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-start-delete-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    await registry.approveDefinition(created.id, prepared.trustFingerprint);

    let runtimeStatus = "stopped" as "stopped" | "running";
    const startEntered = deferred<void>();
    const releaseStart = deferred<void>();
    const runtime = {
      start: vi.fn(async () => {
        startEntered.resolve();
        await releaseStart.promise;
        runtimeStatus = "running";
        return { status: "running" as const };
      }),
      stop: vi.fn(),
      status: vi.fn(async () => ({ status: runtimeStatus })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition: vi.fn(async () => true),
    });

    const starting = controller.start(created.id);
    await startEntered.promise;
    const deleting = controller.deleteDefinition(created.id);
    const outcomes = Promise.allSettled([starting, deleting]);
    await nextTurn();
    const statusChecksBeforeStartSettled = runtime.status.mock.calls.length;
    releaseStart.resolve();
    const [startResult, deleteResult] = await outcomes;

    expect(statusChecksBeforeStartSettled).toBe(0);
    expect(startResult.status).toBe("fulfilled");
    expect(deleteResult.status).toBe("rejected");
    if (deleteResult.status === "rejected") expect(deleteResult.reason).toMatchObject({ message: expect.stringContaining("active") });
    await expect(registry.getDefinition(created.id)).resolves.toBeTruthy();
  });

  it("keeps start approval atomic against a concurrent update of the same binding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-start-update-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    const approvalEntered = deferred<void>();
    const releaseApproval = deferred<boolean>();
    let runtimeStatus = "stopped" as "stopped" | "running";
    const confirmDefinition = vi.fn(async (_definition, action) => {
      if (action !== "start") return true;
      approvalEntered.resolve();
      return releaseApproval.promise;
    });
    const runtime = {
      start: vi.fn(async () => {
        runtimeStatus = "running";
        return { status: "running" as const };
      }),
      stop: vi.fn(),
      status: vi.fn(async () => ({ status: runtimeStatus })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition,
    });

    const starting = controller.start(created.id);
    await approvalEntered.promise;
    const updating = controller.updateDefinition(created.id, { ...draft(root), openPath: "/changed-concurrently" });
    const outcomes = Promise.allSettled([starting, updating]);
    await nextTurn();
    const statusChecksBeforeApprovalSettled = runtime.status.mock.calls.length;
    releaseApproval.resolve(true);
    const [startResult, updateResult] = await outcomes;

    expect(statusChecksBeforeApprovalSettled).toBe(0);
    expect(startResult.status).toBe("fulfilled");
    expect(updateResult.status).toBe("rejected");
    if (updateResult.status === "rejected") expect(updateResult.reason).toMatchObject({ message: expect.stringContaining("active") });
    expect((await registry.getDefinition(created.id)).openPath).toBe("/outreach");
  });

  it("releases a failed binding operation so the next operation can proceed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-lock-release-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const prepared = await registry.prepareDefinition(draft(root));
    const created = await registry.createDefinition(prepared);
    const runtime = {
      start: vi.fn(), stop: vi.fn(), status: vi.fn(async () => ({ status: "stopped" as const })),
      logs: vi.fn(), attestedTarget: vi.fn(), shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry, runtime, selectFolder: vi.fn(async () => null), confirmDefinition: vi.fn(async () => false),
    });

    await expect(controller.start(created.id)).rejects.toThrow("canceled");
    await expect(controller.deleteDefinition(created.id)).resolves.toBeUndefined();
    await expect(registry.getDefinition(created.id)).rejects.toThrow("not found");
  });

  it("does not serialize operations for different bindings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rudder-local-app-controller-distinct-bindings-"));
    const registry = new LocalAppRegistry({ registryPath: path.join(root, "registry.json"), installationId: "install-a" });
    const firstPrepared = await registry.prepareDefinition({ ...draft(root), title: "First" });
    const secondPrepared = await registry.prepareDefinition({ ...draft(root), title: "Second" });
    const first = await registry.createDefinition(firstPrepared);
    const second = await registry.createDefinition(secondPrepared);
    const approvalEntered = deferred<void>();
    const releaseApproval = deferred<boolean>();
    const runtime = {
      start: vi.fn(async () => ({ status: "running" as const })),
      stop: vi.fn(),
      status: vi.fn(async () => ({ status: "stopped" as const })),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
      shutdown: vi.fn(),
    };
    const controller = new LocalAppsController({
      registry,
      runtime,
      selectFolder: vi.fn(async () => null),
      confirmDefinition: vi.fn(async (definition, action) => {
        if (action === "start" && "id" in definition && definition.id === first.id) {
          approvalEntered.resolve();
          return releaseApproval.promise;
        }
        return true;
      }),
    });

    const starting = controller.start(first.id);
    await approvalEntered.promise;
    const deleting = controller.deleteDefinition(second.id);
    const outcomes = Promise.allSettled([starting, deleting]);
    await nextTurn();
    const checkedSecondBeforeApprovalSettled = runtime.status.mock.calls.some(([id]) => id === second.id);
    releaseApproval.resolve(true);
    const [startResult, deleteResult] = await outcomes;

    expect(checkedSecondBeforeApprovalSettled).toBe(true);
    expect(startResult.status).toBe("fulfilled");
    expect(deleteResult.status).toBe("fulfilled");
    await expect(registry.getDefinition(second.id)).rejects.toThrow("not found");
  });

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
