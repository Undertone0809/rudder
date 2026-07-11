import type { BrowserDataImportResult } from "./browser-cookie-import.js";
import type { BrowserImportSource } from "./browser-import-sources.js";
import type { BrowserProfileController } from "./browser-profile.js";

export const BROWSER_IPC_CHANNELS = {
  getPartition: "desktop:get-browser-partition",
  clearData: "desktop:clear-browser-data",
  setEnabled: "desktop:set-browser-enabled",
  listImportSources: "desktop:list-browser-import-sources",
  importData: "desktop:import-browser-data",
} as const;

type BrowserIpcEvent = {
  sender: unknown;
};

type BrowserIpcMain = {
  handle(
    channel: string,
    handler: (event: BrowserIpcEvent, ...args: any[]) => unknown,
  ): void;
};

function requireCurrentMainRenderer(event: BrowserIpcEvent, getMainRenderer: () => unknown): void {
  const currentMainRenderer = getMainRenderer();
  if (!currentMainRenderer || event.sender !== currentMainRenderer) {
    throw new Error("Rudder Browser IPC is available only to the current Rudder renderer.");
  }
}

export function registerBrowserIpcHandlers(ipcMain: BrowserIpcMain, options: {
  getMainRenderer(): unknown;
  controller: Pick<BrowserProfileController, "getPartition" | "clearBrowserData" | "setEnabled">;
  importer: {
    listBrowserImportSources(): Promise<BrowserImportSource[]>;
    importBrowserData(input: { sourceId: string; importCookies: true }): Promise<BrowserDataImportResult>;
  };
}): void {
  ipcMain.handle(BROWSER_IPC_CHANNELS.getPartition, async (event) => {
    requireCurrentMainRenderer(event, options.getMainRenderer);
    return options.controller.getPartition();
  });
  ipcMain.handle(BROWSER_IPC_CHANNELS.clearData, async (event) => {
    requireCurrentMainRenderer(event, options.getMainRenderer);
    await options.controller.clearBrowserData();
  });
  ipcMain.handle(BROWSER_IPC_CHANNELS.setEnabled, async (event, enabled: unknown) => {
    requireCurrentMainRenderer(event, options.getMainRenderer);
    if (typeof enabled !== "boolean") {
      throw new TypeError("Rudder Browser enabled state must be a boolean.");
    }
    await options.controller.setEnabled(enabled);
  });
  ipcMain.handle(BROWSER_IPC_CHANNELS.listImportSources, async (event) => {
    requireCurrentMainRenderer(event, options.getMainRenderer);
    return options.importer.listBrowserImportSources();
  });
  ipcMain.handle(BROWSER_IPC_CHANNELS.importData, async (event, input: unknown) => {
    requireCurrentMainRenderer(event, options.getMainRenderer);
    if (!input || typeof input !== "object") {
      throw new TypeError("Browser import input must be an object.");
    }
    return options.importer.importBrowserData(input as { sourceId: string; importCookies: true });
  });
}
