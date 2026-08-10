import { describe, expect, it, vi } from "vitest";
import { LOCAL_APPS_IPC_CHANNELS, registerLocalAppsIpcHandlers } from "./local-apps-ipc.js";

describe("Desktop Local Apps IPC", () => {
  it("checks the feature gate for launch operations while leaving stop available", async () => {
    const handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
    const ipcMain = { handle: (channel: string, handler: any) => handlers.set(channel, handler) };
    const renderer = { mainFrame: {} };
    const controller = {
      listDefinitions: vi.fn(async () => []),
      pickAndDiscover: vi.fn(),
      createDefinition: vi.fn(),
      updateDefinition: vi.fn(),
      deleteDefinition: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(async () => ({ status: "stopped" })),
      status: vi.fn(),
      logs: vi.fn(),
      attestedTarget: vi.fn(),
    };
    const assertEnabled = vi.fn(async () => {
      throw new Error("Plugins is disabled");
    });
    registerLocalAppsIpcHandlers(ipcMain, {
      getMainRenderer: () => renderer,
      controller,
      assertEnabled,
    });
    const event = { sender: renderer, senderFrame: renderer.mainFrame };

    await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.start)?.(event, { id: "definition-1" }))
      .rejects.toThrow("Plugins is disabled");
    expect(controller.start).not.toHaveBeenCalled();
    await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.stop)?.(event, { id: "definition-1" }))
      .resolves.toEqual({ status: "stopped" });
  });

  it("accepts only the current renderer main frame and exposes narrow opaque-id runtime commands", async () => {
    const handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
    const ipcMain = { handle: vi.fn((channel, handler) => handlers.set(channel, handler)) };
    const mainFrame = {};
    const renderer = { mainFrame };
    const controller = {
      listDefinitions: vi.fn(async () => []),
      pickAndDiscover: vi.fn(async () => ({ canceled: true })),
      createDefinition: vi.fn(), updateDefinition: vi.fn(), approveDefinition: vi.fn(), deleteDefinition: vi.fn(),
      start: vi.fn(async () => ({ status: "running" })), stop: vi.fn(), status: vi.fn(), logs: vi.fn(),
      attestedTarget: vi.fn(),
    };
    registerLocalAppsIpcHandlers(ipcMain, { getMainRenderer: () => renderer, controller });
    const trusted = { sender: renderer, senderFrame: mainFrame };
    const badSender = { sender: {}, senderFrame: mainFrame };
    const badFrame = { sender: renderer, senderFrame: {} };

    await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.list)?.(trusted)).resolves.toEqual([]);
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.start)?.(trusted, { id: "definition-1" });
    expect(controller.start).toHaveBeenCalledWith("definition-1");
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.create)?.(trusted, { definition: { title: "fixture" } });
    expect(controller.createDefinition).toHaveBeenCalledWith({ title: "fixture" });
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.update)?.(trusted, { id: "definition-1", definition: { title: "changed" } });
    expect(controller.updateDefinition).toHaveBeenCalledWith("definition-1", { title: "changed" });
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.stop)?.(trusted, { id: "definition-1" });
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.delete)?.(trusted, { id: "definition-1" });
    expect(controller.stop).toHaveBeenCalledWith("definition-1");
    expect(controller.deleteDefinition).toHaveBeenCalledWith("definition-1");
    await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.start)?.(trusted, { id: "definition-1", command: "rm" }))
      .rejects.toThrow("opaque id");
    for (const event of [badSender, badFrame]) {
      await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.list)?.(event)).rejects.toThrow("main frame");
      await expect(handlers.get(LOCAL_APPS_IPC_CHANNELS.start)?.(event, { id: "definition-1" })).rejects.toThrow("main frame");
    }
  });

  it("uses a native picker for discovery and never starts during list, status, logs, hydration, or discovery", async () => {
    const handlers = new Map<string, (event: any, ...args: unknown[]) => unknown>();
    const ipcMain = { handle: (channel: string, handler: any) => handlers.set(channel, handler) };
    const mainFrame = {};
    const renderer = { mainFrame };
    const controller = {
      listDefinitions: vi.fn(async () => []), pickAndDiscover: vi.fn(async () => ({ canceled: false, draft: {} })),
      createDefinition: vi.fn(), updateDefinition: vi.fn(), approveDefinition: vi.fn(), deleteDefinition: vi.fn(),
      start: vi.fn(), stop: vi.fn(), status: vi.fn(async () => ({ status: "stopped" })),
      logs: vi.fn(async () => []), attestedTarget: vi.fn(async () => null),
    };
    registerLocalAppsIpcHandlers(ipcMain, { getMainRenderer: () => renderer, controller });
    const event = { sender: renderer, senderFrame: mainFrame };
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.discover)?.(event);
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.list)?.(event);
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.status)?.(event, { id: "definition-1" });
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.logs)?.(event, { id: "definition-1" });
    await handlers.get(LOCAL_APPS_IPC_CHANNELS.attestedTarget)?.(event, { id: "definition-1" });
    expect(controller.pickAndDiscover).toHaveBeenCalledTimes(1);
    expect(controller.start).not.toHaveBeenCalled();
  });
});
