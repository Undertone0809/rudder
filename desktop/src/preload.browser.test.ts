import { beforeEach, describe, expect, it, vi } from "vitest";

const electronMocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: electronMocks.exposeInMainWorld,
  },
  ipcRenderer: {
    invoke: electronMocks.invoke,
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

await import("./preload.js");

type ExposedDesktopShell = {
  listBrowserImportSources(): Promise<unknown[]>;
  importBrowserData(input: { sourceId: string; importCookies: true }): Promise<unknown>;
  getBrowserPartition(): Promise<string>;
  clearBrowserData(): Promise<void>;
  setBrowserEnabled(enabled: boolean): Promise<void>;
  onBrowserReset(listener: (event: unknown) => void): () => void;
};

function desktopShell(): ExposedDesktopShell {
  const exposed = electronMocks.exposeInMainWorld.mock.calls.find(([name]) => name === "desktopShell");
  if (!exposed) throw new Error("desktopShell was not exposed");
  return exposed[1] as ExposedDesktopShell;
}

describe("Rudder Browser preload bridge", () => {
  beforeEach(() => {
    electronMocks.invoke.mockClear();
    electronMocks.on.mockClear();
    electronMocks.removeListener.mockClear();
  });

  it("wires import, partition, clear, and enable calls to their Browser IPC channels", async () => {
    const shell = desktopShell();

    await shell.listBrowserImportSources();
    await shell.importBrowserData({ sourceId: "opaque-source", importCookies: true });
    await shell.getBrowserPartition();
    await shell.clearBrowserData();
    await shell.setBrowserEnabled(false);
    await shell.setBrowserEnabled("false" as never);

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "desktop:list-browser-import-sources");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "desktop:import-browser-data", {
      sourceId: "opaque-source",
      importCookies: true,
    });
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "desktop:get-browser-partition");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(4, "desktop:clear-browser-data");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(5, "desktop:set-browser-enabled", false);
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(6, "desktop:set-browser-enabled", "false");
  });

  it("subscribes and unsubscribes Browser reset listeners", () => {
    const shell = desktopShell();
    const listener = vi.fn();
    const remove = shell.onBrowserReset(listener);
    const resetRegistration = electronMocks.on.mock.calls.find(([channel]) => channel === "desktop:browser-reset");
    expect(resetRegistration).toBeDefined();

    const payload = { reason: "disabled", enabled: false, available: false };
    resetRegistration?.[1]({}, payload);
    expect(listener).toHaveBeenCalledWith(payload);

    remove();
    expect(electronMocks.removeListener).toHaveBeenCalledWith("desktop:browser-reset", resetRegistration?.[1]);
  });
});
