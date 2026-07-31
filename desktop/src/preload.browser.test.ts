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
  openSystemPermissionSettings(permission: "fullDiskAccess" | "accessibility" | "automation"): Promise<void>;
  onBrowserShortcut(listener: (request: unknown) => void): () => void;
  onOpenWebLink(listener: (request: unknown) => void): () => void;
  listBrowserImportSources(): Promise<unknown[]>;
  importBrowserData(input: { sourceId: string; importCookies: true }): Promise<unknown>;
  getBrowserPartition(): Promise<string>;
  clearBrowserData(): Promise<void>;
  setBrowserEnabled(enabled: boolean): Promise<void>;
  onBrowserReset(listener: (event: unknown) => void): () => void;
  localApps: {
    supported: boolean;
    list(): Promise<unknown[]>;
    discover(): Promise<unknown>;
    create(definition: unknown): Promise<unknown>;
    update(id: string, definition: unknown): Promise<unknown>;
    delete(id: string): Promise<void>;
    start(id: string): Promise<unknown>;
    stop(id: string): Promise<unknown>;
    status(id: string): Promise<unknown>;
    logs(id: string): Promise<string[]>;
    attestedTarget(id: string): Promise<unknown>;
  };
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
    await shell.openSystemPermissionSettings("fullDiskAccess");
    const remove = shell.onOpenWebLink(listener);
    const registration = electronMocks.on.mock.calls.find(([channel]) => channel === "desktop:open-web-link");
    const request = {
      url: "https://example.com/popup",
      source: "browser_popup",
      sourceWebContentsId: 42,
    };
    registration?.[1]({}, request);
    registration?.[1]({}, {
      ...request,
      sourceWebContentsId: -1,
    });
    registration?.[1]({}, undefined);
    registration?.[1]({}, {
      source: "unknown",
      url: "https://example.com/ignored",
    });

    expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "desktop:open-external", "https://example.com/normal");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "desktop:force-open-external", "https://example.com/explicit");
    expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "desktop:open-system-permission-settings", "fullDiskAccess");
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(request);
    remove();
    expect(electronMocks.removeListener).toHaveBeenCalledWith("desktop:open-web-link", registration?.[1]);
  });

  it("delivers Browser shortcuts with the exact positive source guest id", () => {
    const shell = desktopShell();
    const listener = vi.fn();
    const remove = shell.onBrowserShortcut(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:browser-shortcut",
    );
    const request = { action: "new_tab", sourceWebContentsId: 42 };

    registration?.[1]({}, request);
    registration?.[1]({}, { ...request, sourceWebContentsId: 0 });
    registration?.[1]({}, { action: "unknown", sourceWebContentsId: 42 });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(request);
    remove();
    expect(electronMocks.removeListener).toHaveBeenCalledWith(
      "desktop:browser-shortcut",
      registration?.[1],
    );
  });

  it("delivers exact-owner Browser close requests", () => {
    const listener = vi.fn();
    const remove = desktopShell().onBrowserShortcut(listener);
    const registration = electronMocks.on.mock.calls.find(
      ([channel]) => channel === "desktop:browser-shortcut",
    );
    const request = { action: "close_tab", sourceWebContentsId: 42 };

    registration?.[1]({}, request);

    expect(listener).toHaveBeenCalledWith(request);
    remove();
  });

  it("exposes only narrow Local App DTO and opaque-id IPC calls", async () => {
    const localApps = desktopShell().localApps;
    expect(localApps.supported).toBe(["darwin", "linux", "win32"].includes(process.platform));
    const definition = { title: "fixture" };
    await localApps.list();
    await localApps.discover();
    await localApps.create(definition);
    await localApps.update("binding-1", definition);
    await localApps.delete("binding-1");
    await localApps.start("binding-1");
    await localApps.stop("binding-1");
    await localApps.status("binding-1");
    await localApps.logs("binding-1");
    await localApps.attestedTarget("binding-1");

    expect(electronMocks.invoke.mock.calls).toEqual([
      ["desktop:local-apps:list"],
      ["desktop:local-apps:discover"],
      ["desktop:local-apps:create", { definition }],
      ["desktop:local-apps:update", { id: "binding-1", definition }],
      ["desktop:local-apps:delete", { id: "binding-1" }],
      ["desktop:local-apps:start", { id: "binding-1" }],
      ["desktop:local-apps:stop", { id: "binding-1" }],
      ["desktop:local-apps:status", { id: "binding-1" }],
      ["desktop:local-apps:logs", { id: "binding-1" }],
      ["desktop:local-apps:attested-target", { id: "binding-1" }],
    ]);
  });
});
