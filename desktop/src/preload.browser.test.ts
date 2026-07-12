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
  openExternal(target: string): Promise<void>;
  forceOpenExternal(target: string): Promise<void>;
  onOpenWebLink(listener: (request: unknown) => void): () => void;
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

  it("preserves structured aggregated import issues from IPC", async () => {
    const importResult = {
      status: "succeeded",
      importedCount: 12,
      skippedCount: 553,
      failedCount: 0,
      errors: [{
        errorCode: "COOKIE_PARTITION_UNSUPPORTED",
        message: "A partitioned cookie is not supported by this version of Rudder.",
        count: 553,
        kind: "skipped",
      }],
    };
    electronMocks.invoke.mockResolvedValueOnce(importResult);

    await expect(desktopShell().importBrowserData({
      sourceId: "opaque-source",
      importCookies: true,
    })).resolves.toEqual(importResult);
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

  it("routes normal and explicit external links through separate channels", async () => {
    const shell = desktopShell();
    const listener = vi.fn();

    await shell.openExternal("https://example.com/normal");
    await shell.forceOpenExternal("https://example.com/explicit");
    const remove = shell.onOpenWebLink(listener);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === "desktop:open-web-link");
    const request = { url: "https://example.com/popup", source: "browser_popup" };
    registration?.[1]({}, request);

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "desktop:open-external", "https://example.com/normal");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "desktop:force-open-external", "https://example.com/explicit");
    expect(listener).toHaveBeenCalledWith(request);
    remove();
    expect(electronMocks.removeListener).toHaveBeenCalledWith("desktop:open-web-link", registration?.[1]);
  });
});
