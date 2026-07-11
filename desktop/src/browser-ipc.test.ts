import { describe, expect, it, vi } from "vitest";
import { BROWSER_IPC_CHANNELS, registerBrowserIpcHandlers } from "./browser-ipc.js";

describe("Rudder Browser IPC", () => {
  it("wires Browser channels to the profile controller for the current main renderer", async () => {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel, handler) => {
        handlers.set(channel, handler);
      }),
    };
    const mainRenderer = { id: "main-renderer" };
    const controller = {
      getPartition: vi.fn(() => "persist:rudder-browser-v1-safe"),
      clearBrowserData: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined),
    };
    const importer = {
      listBrowserImportSources: vi.fn(async () => [{ id: "opaque-source" }]),
      importBrowserData: vi.fn(async () => ({ status: "succeeded", importedCount: 1, skippedCount: 0, failedCount: 0 })),
    };
    registerBrowserIpcHandlers(ipcMain, {
      getMainRenderer: () => mainRenderer,
      controller,
      importer,
    });

    await expect(handlers.get(BROWSER_IPC_CHANNELS.getPartition)?.({ sender: mainRenderer })).resolves.toBe(
      "persist:rudder-browser-v1-safe",
    );
    await handlers.get(BROWSER_IPC_CHANNELS.clearData)?.({ sender: mainRenderer });
    await handlers.get(BROWSER_IPC_CHANNELS.setEnabled)?.({ sender: mainRenderer }, false);
    await expect(handlers.get(BROWSER_IPC_CHANNELS.listImportSources)?.({ sender: mainRenderer })).resolves.toEqual([
      { id: "opaque-source" },
    ]);
    await expect(handlers.get(BROWSER_IPC_CHANNELS.importData)?.(
      { sender: mainRenderer },
      { sourceId: "opaque-source", importCookies: true },
    )).resolves.toEqual({ status: "succeeded", importedCount: 1, skippedCount: 0, failedCount: 0 });

    expect(controller.clearBrowserData).toHaveBeenCalledTimes(1);
    expect(controller.setEnabled).toHaveBeenCalledWith(false);
    expect(importer.importBrowserData).toHaveBeenCalledWith({ sourceId: "opaque-source", importCookies: true });
  });

  it("rejects every Browser handler from non-main renderer senders", async () => {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    };
    const mainRenderer = { id: "main-renderer" };
    const guestRenderer = { id: "browser-guest" };
    const controller = {
      getPartition: vi.fn(() => "persist:rudder-browser-v1-safe"),
      clearBrowserData: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined),
    };
    const importer = {
      listBrowserImportSources: vi.fn(async () => []),
      importBrowserData: vi.fn(async () => ({ status: "succeeded", importedCount: 0, skippedCount: 0, failedCount: 0 })),
    };
    registerBrowserIpcHandlers(ipcMain, {
      getMainRenderer: () => mainRenderer,
      controller,
      importer,
    });

    await expect(handlers.get(BROWSER_IPC_CHANNELS.getPartition)?.({ sender: guestRenderer })).rejects.toThrow(
      "current Rudder renderer",
    );
    await expect(handlers.get(BROWSER_IPC_CHANNELS.clearData)?.({ sender: guestRenderer })).rejects.toThrow(
      "current Rudder renderer",
    );
    await expect(handlers.get(BROWSER_IPC_CHANNELS.setEnabled)?.({ sender: guestRenderer }, false)).rejects.toThrow(
      "current Rudder renderer",
    );
    await expect(handlers.get(BROWSER_IPC_CHANNELS.listImportSources)?.({ sender: guestRenderer })).rejects.toThrow(
      "current Rudder renderer",
    );
    await expect(handlers.get(BROWSER_IPC_CHANNELS.importData)?.(
      { sender: guestRenderer },
      { sourceId: "opaque-source", importCookies: true },
    )).rejects.toThrow("current Rudder renderer");
    expect(controller.getPartition).not.toHaveBeenCalled();
    expect(controller.clearBrowserData).not.toHaveBeenCalled();
    expect(controller.setEnabled).not.toHaveBeenCalled();
    expect(importer.listBrowserImportSources).not.toHaveBeenCalled();
    expect(importer.importBrowserData).not.toHaveBeenCalled();
  });

  it("rejects non-boolean enable values", async () => {
    const handlers = new Map<string, (event: { sender: unknown }, ...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: { sender: unknown }, ...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      },
    };
    const mainRenderer = { id: "main-renderer" };
    const controller = {
      getPartition: vi.fn(() => "persist:rudder-browser-v1-safe"),
      clearBrowserData: vi.fn(async () => undefined),
      setEnabled: vi.fn(async () => undefined),
    };
    const importer = {
      listBrowserImportSources: vi.fn(async () => []),
      importBrowserData: vi.fn(async () => ({ status: "succeeded", importedCount: 0, skippedCount: 0, failedCount: 0 })),
    };
    registerBrowserIpcHandlers(ipcMain, {
      getMainRenderer: () => mainRenderer,
      controller,
      importer,
    });

    await expect(handlers.get(BROWSER_IPC_CHANNELS.setEnabled)?.({ sender: mainRenderer }, "false")).rejects.toThrow(
      "boolean",
    );
    expect(controller.setEnabled).not.toHaveBeenCalled();
  });
});
