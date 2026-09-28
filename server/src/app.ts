import type { Db } from "@rudderhq/db";
import type express from "express";
import type { Config } from "./config.js";
import { createHttpApp } from "./bootstrap/create-http-app.js";
import type { RudderAppOptions } from "./bootstrap/types.js";
import { logger } from "./middleware/logger.js";
import { RuntimeSupervisor, supervisedStart } from "./runtime/runtime-supervisor.js";
import { configureBrowserCapabilityDeployment } from "./services/browser-capability.js";
import { startOrganizationMutationOutboxPublisher } from "./services/organization-mutation-outbox.js";
export { resolveViteHmrPort } from "./bootstrap/create-http-app.js";

export interface RudderAppHandle {
  app: express.Express;
  close(): Promise<void>;
}

type RudderAppStartupOptions = Pick<
  RudderAppOptions,
  | "authReady"
  | "companyDeletionEnabled"
  | "databaseUrl"
  | "rustFoundationMode"
  | "rustOrganizationBrandingMode"
  | "rustProjectGoalSetMode"
  | "rustFoundationBinaryPath"
  | "rustFoundationActorEnvelopeKey"
>;

export function createRudderAppStartupOptions(
  config: Config,
  databaseUrl: string,
  authReady: boolean,
): RudderAppStartupOptions {
  return {
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    databaseUrl,
    rustFoundationMode: config.rustFoundationMode,
    rustOrganizationBrandingMode: config.rustOrganizationBrandingMode,
    rustProjectGoalSetMode: config.rustProjectGoalSetMode,
    rustFoundationBinaryPath: config.rustFoundationBinaryPath,
    rustFoundationActorEnvelopeKey: config.rustFoundationActorEnvelopeKey,
  };
}

export function ownRudderAppAndOutbox(
  supervisor: RuntimeSupervisor,
  db: Db,
  appHandle: RudderAppHandle,
): void {
  supervisor.own("app", () => appHandle.close());
  const publisher = startOrganizationMutationOutboxPublisher(db);
  supervisor.own("organization-mutation-outbox", () => publisher.close());
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
    const httpApp = await createHttpApp(db, opts);
    supervisor.own("http-app", () => httpApp.close());

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
