import type { Db } from "@rudderhq/db";
import type express from "express";
import { createHttpApp } from "./bootstrap/create-http-app.js";
import { createPluginHostRuntime } from "./bootstrap/plugin-host-runtime.js";
import type { RudderAppOptions } from "./bootstrap/types.js";
import { logger } from "./middleware/logger.js";
import { RuntimeSupervisor, supervisedStart } from "./runtime/runtime-supervisor.js";
import { configureBrowserCapabilityDeployment } from "./services/browser-capability.js";
export { resolveViteHmrPort } from "./bootstrap/create-http-app.js";

export interface RudderAppHandle {
  app: express.Express;
  close(): Promise<void>;
}

export async function createRudderApp(
  db: Db,
  opts: RudderAppOptions,
) {
  configureBrowserCapabilityDeployment(db, opts.deploymentMode, opts.localRuntimeTrust);
  const supervisor = new RuntimeSupervisor({
    onDisposeError: ({ name, error }) => {
      logger.warn({ err: error, resource: name }, "Failed to close Rudder app resource");
    },
  });

  return supervisedStart(supervisor, async () => {
    const pluginRuntime = createPluginHostRuntime(db, opts);
    supervisor.own("plugin-host-runtime", () => pluginRuntime.close());

    const httpApp = await createHttpApp(db, opts, pluginRuntime);
    supervisor.own("http-app", () => httpApp.close());

    await pluginRuntime.start();

    return {
      app: httpApp.app,
      close: () => supervisor.dispose(),
    } satisfies RudderAppHandle;
  });
}

export async function createApp(
  db: Db,
  opts: Parameters<typeof createRudderApp>[1],
) {
  const handle = await createRudderApp(db, opts);
  return handle.app;
}
