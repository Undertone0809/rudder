import type { Db } from "@rudder/db";
import type express from "express";
import { createHttpApp } from "./bootstrap/create-http-app.js";
import { createPluginHostRuntime } from "./bootstrap/plugin-host-runtime.js";
import type { RudderAppOptions } from "./bootstrap/types.js";
export { resolveViteHmrPort } from "./bootstrap/create-http-app.js";

export interface RudderAppHandle {
  app: express.Express;
  close(): Promise<void>;
}

export async function createRudderApp(
  db: Db,
  opts: RudderAppOptions,
) {
  const pluginRuntime = createPluginHostRuntime(db, opts);
  const app = await createHttpApp(db, opts, pluginRuntime);
  await pluginRuntime.start();

  return {
    app,
    async close(): Promise<void> {
      await pluginRuntime.close();
    },
  };
}

export async function createApp(
  db: Db,
  opts: Parameters<typeof createRudderApp>[1],
) {
  const handle = await createRudderApp(db, opts);
  return handle.app;
}
