import type { BrowserProfileController } from "./browser-profile.js";

export const BROWSER_IPC_CHANNELS = {
  getPartition: "desktop:get-browser-partition",
  clearData: "desktop:clear-browser-data",
  setEnabled: "desktop:set-browser-enabled",
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
}
