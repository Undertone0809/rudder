import type { AppBuilderApp } from "@rudderhq/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  updateBuild: vi.fn(),
  bindLocalRuntime: vi.fn(),
  clearLocalRuntime: vi.fn(),
}));

vi.mock("@/api/app-builder", () => ({ appBuilderApi: apiMocks }));

import { launchManagedApp } from "./app-builder-launch";

const app: AppBuilderApp = {
  id: "44444444-4444-4444-8444-444444444444",
  orgId: "11111111-1111-4111-8111-111111111111",
  projectId: null,
  conversationId: null,
  name: "CRM",
  sourceRoot: "apps/crm",
  scaffoldVersion: "1",
  buildStatus: "verified_source_ready",
  latestBuildRunId: null,
  latestVerificationRunId: "55555555-5555-4555-8555-555555555555",
  desktopInstallationId: null,
  appPublicId: null,
  localBindingId: null,
  createdAt: new Date("2026-08-09T00:00:00.000Z"),
  updatedAt: new Date("2026-08-09T00:00:00.000Z"),
};

function desktopShell(options: {
  failStart?: boolean;
  pendingStart?: boolean;
  pendingStatus?: boolean;
  pendingAttestedTarget?: boolean;
  readinessTimeoutMs?: number;
} = {}) {
  const binding = {
    desktopInstallationId: "desktop-1",
    definitionId: "definition-1",
    appPublicId: "crm",
    localBindingId: "binding-1",
  };
  const inspect = vi.fn().mockResolvedValue({
    manifest: { runtime: { readinessTimeoutMs: options.readinessTimeoutMs ?? 1_000 } },
  });
  const ensurePreview = vi.fn().mockResolvedValue(binding);
  const startPreview = options.failStart
    ? vi.fn().mockRejectedValue(new Error("Readiness failed"))
    : options.pendingStart
      ? vi.fn().mockReturnValue(new Promise(() => undefined))
      : vi.fn().mockResolvedValue({ runtime: { status: "running" }, target: {} });
  const stopPreview = vi.fn().mockResolvedValue({ status: "stopped" });
  const list = vi.fn().mockResolvedValue([]);
  const status = options.pendingStatus
    ? vi.fn().mockReturnValue(new Promise(() => undefined))
    : vi.fn().mockResolvedValue({ status: "running" });
  const attestedTarget = options.pendingAttestedTarget
    ? vi.fn().mockReturnValue(new Promise(() => undefined))
    : vi.fn().mockResolvedValue({
        origin: "http://127.0.0.1:43123",
        openPath: "/",
        partition: "persist:app",
      });
  const deleteDefinition = vi.fn().mockResolvedValue(undefined);
  return {
    shell: {
      appBuilder: {
        supported: true,
        inspect,
        ensurePreview,
        startPreview,
        stopPreview,
      },
      localApps: {
        supported: true,
        list,
        status,
        attestedTarget,
        delete: deleteDefinition,
      },
    },
    binding,
    inspect,
    ensurePreview,
    startPreview,
    stopPreview,
    deleteDefinition,
    status,
    attestedTarget,
  };
}

describe("managed App automatic launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.updateBuild.mockResolvedValue(app);
    apiMocks.bindLocalRuntime.mockResolvedValue(app);
    apiMocks.clearLocalRuntime.mockResolvedValue(app);
  });

  it("claims verified source before binding, starting, and marking ready", async () => {
    const desktop = desktopShell();
    await expect(launchManagedApp({
      app,
      desktopShell: desktop.shell as never,
      expectedStatus: "verified_source_ready",
    })).resolves.toEqual(desktop.binding);

    expect(apiMocks.updateBuild.mock.calls).toEqual([
      [app.orgId, app.id, {
        status: "verifying",
        expectedStatus: "verified_source_ready",
        runKind: "verification",
      }],
      [app.orgId, app.id, {
        status: "ready",
        expectedStatus: "verifying",
        runKind: "verification",
      }],
    ]);
    expect(desktop.inspect).toHaveBeenCalledBefore(desktop.ensurePreview);
    expect(desktop.ensurePreview).toHaveBeenCalledBefore(desktop.startPreview);
    expect(apiMocks.bindLocalRuntime).toHaveBeenCalledWith(app.orgId, app.id, {
      desktopInstallationId: "desktop-1",
      appPublicId: "crm",
      localBindingId: "binding-1",
    });
  });

  it("cleans up a new binding and records a causal failure", async () => {
    const desktop = desktopShell({ failStart: true });
    await expect(launchManagedApp({
      app,
      desktopShell: desktop.shell as never,
      expectedStatus: "verified_source_ready",
    })).rejects.toThrow("Readiness failed");

    expect(desktop.stopPreview).toHaveBeenCalled();
    expect(desktop.deleteDefinition).toHaveBeenCalledWith("definition-1");
    expect(apiMocks.clearLocalRuntime).not.toHaveBeenCalled();
    expect(apiMocks.updateBuild).toHaveBeenLastCalledWith(app.orgId, app.id, {
      status: "launch_failed",
      expectedStatus: "verifying",
      runKind: "verification",
    });
  });

  it("continues when Desktop proves a runtime is ready before the start IPC settles", async () => {
    const desktop = desktopShell({ pendingStart: true });
    await expect(launchManagedApp({
      app,
      desktopShell: desktop.shell as never,
      expectedStatus: "verified_source_ready",
    })).resolves.toEqual(desktop.binding);

    expect(desktop.status).toHaveBeenCalledWith("definition-1");
    expect(desktop.attestedTarget).toHaveBeenCalledWith("definition-1");
    expect(apiMocks.bindLocalRuntime).toHaveBeenCalled();
    expect(apiMocks.updateBuild).toHaveBeenLastCalledWith(app.orgId, app.id, {
      status: "ready",
      expectedStatus: "verifying",
      runKind: "verification",
    });
  });

  it.each([
    ["runtime status", { pendingStatus: true }],
    ["runtime attestation", { pendingAttestedTarget: true }],
  ])("fails causally when the %s probe stalls past readiness", async (_label, probe) => {
    const desktop = desktopShell({
      pendingStart: true,
      readinessTimeoutMs: 20,
      ...probe,
    });
    await expect(launchManagedApp({
      app,
      desktopShell: desktop.shell as never,
      expectedStatus: "verified_source_ready",
    })).rejects.toThrow("readiness deadline");

    expect(desktop.stopPreview).toHaveBeenCalled();
    expect(desktop.deleteDefinition).toHaveBeenCalledWith("definition-1");
    expect(apiMocks.updateBuild).toHaveBeenLastCalledWith(app.orgId, app.id, {
      status: "launch_failed",
      expectedStatus: "verifying",
      runKind: "verification",
    });
  });

  it("ignores a late start rejection after attested runtime recovery wins", async () => {
    let rejectStart!: (error: Error) => void;
    const desktop = desktopShell({ pendingStart: true });
    desktop.startPreview.mockReturnValue(new Promise((_resolve, reject) => {
      rejectStart = reject;
    }));

    await expect(launchManagedApp({
      app,
      desktopShell: desktop.shell as never,
      expectedStatus: "verified_source_ready",
    })).resolves.toEqual(desktop.binding);
    rejectStart(new Error("late IPC rejection"));
    await Promise.resolve();

    expect(apiMocks.updateBuild).toHaveBeenCalledTimes(2);
    expect(apiMocks.updateBuild).toHaveBeenLastCalledWith(app.orgId, app.id, {
      status: "ready",
      expectedStatus: "verifying",
      runKind: "verification",
    });
  });
});
