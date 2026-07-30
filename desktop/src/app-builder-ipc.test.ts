import { describe, expect, it, vi } from "vitest";

import {
  APP_BUILDER_IPC_CHANNELS,
  type AppBuilderController,
  registerAppBuilderIpcHandlers,
} from "./app-builder-ipc.js";

describe("App Builder IPC", () => {
  it("rejects every App Builder command when the Sites feature gate is closed", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, handler);
      },
    };
    const renderer = { mainFrame: {} };
    const controller = { inspect: vi.fn() } as unknown as AppBuilderController;
    registerAppBuilderIpcHandlers(ipcMain, {
      getMainRenderer: () => renderer,
      controller,
      assertEnabled: vi.fn(async () => {
        throw new Error("Sites is disabled");
      }),
    });

    await expect(handlers.get(APP_BUILDER_IPC_CHANNELS.inspect)!(
      { sender: renderer, senderFrame: renderer.mainFrame },
      { projectId: "project-1", appDirectory: "apps/crm" },
    )).rejects.toThrow("Sites is disabled");
    expect(controller.inspect).not.toHaveBeenCalled();
  });

  it("registers narrow main-frame-only handlers", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    };
    const renderer = { mainFrame: {} };
    const controller = {
      inspect: vi.fn(async () => ({ manifest: { appId: "cold-email-crm" } })),
    } as unknown as AppBuilderController;
    registerAppBuilderIpcHandlers(ipcMain, {
      getMainRenderer: () => renderer,
      controller,
    });

    expect([...handlers.keys()]).toEqual(Object.values(APP_BUILDER_IPC_CHANNELS));
    const inspect = handlers.get(APP_BUILDER_IPC_CHANNELS.inspect)!;
    await expect(inspect(
      { sender: renderer, senderFrame: renderer.mainFrame },
      { projectId: "project-1", appDirectory: "apps/crm" },
    )).resolves.toEqual({ manifest: { appId: "cold-email-crm" } });
    expect(controller.inspect).toHaveBeenCalledWith("project-1", "apps/crm");

    await expect(inspect(
      { sender: {}, senderFrame: renderer.mainFrame },
      { projectId: "project-1", appDirectory: "apps/crm" },
    )).rejects.toThrow("current renderer main frame");
    await expect(inspect(
      { sender: renderer, senderFrame: renderer.mainFrame },
      { projectId: "project-1", appDirectory: "apps/crm", command: "arbitrary" },
    )).rejects.toThrow("unsupported");
  });

  it("rejects malformed preview bindings before invoking the controller", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
        handlers.set(channel, handler);
      },
    };
    const renderer = { mainFrame: {} };
    const controller = {
      startPreview: vi.fn(),
    } as unknown as AppBuilderController;
    registerAppBuilderIpcHandlers(ipcMain, {
      getMainRenderer: () => renderer,
      controller,
    });

    await expect(handlers.get(APP_BUILDER_IPC_CHANNELS.startPreview)!(
      { sender: renderer, senderFrame: renderer.mainFrame },
      {
        projectId: "project-1",
        appDirectory: ".",
        binding: {
          desktopInstallationId: "desktop",
          definitionId: "../other",
          appPublicId: "public",
          localBindingId: "binding",
        },
      },
    )).rejects.toThrow("binding");
    expect(controller.startPreview).not.toHaveBeenCalled();
  });
});
