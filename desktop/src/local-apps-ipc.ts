export const LOCAL_APPS_IPC_CHANNELS = {
  list: "desktop:local-apps:list",
  discover: "desktop:local-apps:discover",
  create: "desktop:local-apps:create",
  update: "desktop:local-apps:update",
  delete: "desktop:local-apps:delete",
  start: "desktop:local-apps:start",
  stop: "desktop:local-apps:stop",
  status: "desktop:local-apps:status",
  logs: "desktop:local-apps:logs",
  attestedTarget: "desktop:local-apps:attested-target",
} as const;

type IpcEvent = { sender: unknown; senderFrame: unknown };
type Renderer = { mainFrame: unknown };
type IpcMainLike = {
  handle(channel: string, handler: (event: IpcEvent, ...args: unknown[]) => unknown): void;
  removeHandler?(channel: string): void;
};

type LocalAppsController = {
  listDefinitions(): unknown;
  pickAndDiscover(): unknown;
  createDefinition(definition: unknown): unknown;
  updateDefinition(id: string, definition: unknown): unknown;
  deleteDefinition(id: string): unknown;
  start(id: string): unknown;
  stop(id: string): unknown;
  status(id: string): unknown;
  logs(id: string): unknown;
  attestedTarget(id: string): unknown;
};

function assertCurrentMainFrame(event: IpcEvent, getMainRenderer: () => Renderer | null): void {
  const renderer = getMainRenderer();
  if (!renderer || event.sender !== renderer || event.senderFrame !== renderer.mainFrame) {
    throw new Error("Desktop Local Apps IPC is restricted to the current renderer main frame");
  }
}

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const object = value as Record<string, unknown>;
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = [...keys].sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`${label} accepts only its narrow opaque id payload`);
  }
  return object;
}

function opaqueIdPayload(value: unknown): string {
  const object = exactObject(value, ["id"], "Local App command");
  if (typeof object.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(object.id)) {
    throw new Error("Local App command requires a valid opaque id");
  }
  return object.id;
}

function noArguments(args: unknown[], label: string): void {
  if (args.length !== 0) throw new Error(`${label} does not accept renderer arguments`);
}

export function registerLocalAppsIpcHandlers(
  ipcMain: IpcMainLike,
  options: { getMainRenderer: () => Renderer | null; controller: LocalAppsController },
): void {
  const register = (
    channel: string,
    handler: (event: IpcEvent, ...args: unknown[]) => unknown,
  ) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      assertCurrentMainFrame(event, options.getMainRenderer);
      return await handler(event, ...args);
    });
  };

  register(LOCAL_APPS_IPC_CHANNELS.list, (_event, ...args) => {
    noArguments(args, "Local App list");
    return options.controller.listDefinitions();
  });
  register(LOCAL_APPS_IPC_CHANNELS.discover, (_event, ...args) => {
    noArguments(args, "Local App discovery");
    return options.controller.pickAndDiscover();
  });
  register(LOCAL_APPS_IPC_CHANNELS.create, (_event, payload) => {
    const object = exactObject(payload, ["definition"], "Local App create");
    return options.controller.createDefinition(object.definition);
  });
  register(LOCAL_APPS_IPC_CHANNELS.update, (_event, payload) => {
    const object = exactObject(payload, ["id", "definition"], "Local App update");
    const id = opaqueIdPayload({ id: object.id });
    return options.controller.updateDefinition(id, object.definition);
  });
  register(LOCAL_APPS_IPC_CHANNELS.delete, (_event, payload) => options.controller.deleteDefinition(opaqueIdPayload(payload)));
  register(LOCAL_APPS_IPC_CHANNELS.start, (_event, payload) => options.controller.start(opaqueIdPayload(payload)));
  register(LOCAL_APPS_IPC_CHANNELS.stop, (_event, payload) => options.controller.stop(opaqueIdPayload(payload)));
  register(LOCAL_APPS_IPC_CHANNELS.status, (_event, payload) => options.controller.status(opaqueIdPayload(payload)));
  register(LOCAL_APPS_IPC_CHANNELS.logs, (_event, payload) => options.controller.logs(opaqueIdPayload(payload)));
  register(LOCAL_APPS_IPC_CHANNELS.attestedTarget, (_event, payload) => options.controller.attestedTarget(opaqueIdPayload(payload)));
}
