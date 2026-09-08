import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeModuleMocks = vi.hoisted(() => ({
  ensureRuntimeInstalled: vi.fn(),
  importRuntimeServerModule: vi.fn(),
}));

vi.mock("./install.js", () => runtimeModuleMocks);

import { loadServerRuntimeModule, startServerFromModule } from "./server-entry.js";

describe("server runtime startup policy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    runtimeModuleMocks.ensureRuntimeInstalled.mockReset();
    runtimeModuleMocks.importRuntimeServerModule.mockReset();
  });

  it("uses an explicit packaged runtime before the repository development entry", async () => {
    const runtimeModule = { startManagedLocalServer: vi.fn() };
    const runtimePackageDir = "/tmp/rudder-candidate-server-package";
    runtimeModuleMocks.importRuntimeServerModule.mockResolvedValue(runtimeModule);

    await expect(loadServerRuntimeModule({
      version: "0.7.20",
      runtimePackageDir,
    })).resolves.toBe(runtimeModule);

    expect(runtimeModuleMocks.importRuntimeServerModule).toHaveBeenCalledWith(runtimePackageDir);
    expect(runtimeModuleMocks.ensureRuntimeInstalled).not.toHaveBeenCalled();
  });

  it("preserves takeover for ordinary CLI runtime starts by default", async () => {
    const startManagedLocalServer = vi.fn(async () => ({
      apiUrl: "http://127.0.0.1:3200/api",
      databaseUrl: null,
      host: "127.0.0.1",
      listenPort: 3200,
      runtime: {
        mode: "owned" as const,
        instanceId: "default",
        localEnv: "prod_local",
        ownerKind: "cli",
        version: "0.7.19",
      },
      stop: async () => {},
      dispose: async () => {},
    }));

    await expect(startServerFromModule({ startManagedLocalServer })).resolves.toMatchObject({
      runtime: { mode: "owned" },
    });
    expect(startManagedLocalServer).toHaveBeenCalledWith({
      ownerKind: "cli",
      takeoverOnVersionMismatch: true,
    });
  });
});
