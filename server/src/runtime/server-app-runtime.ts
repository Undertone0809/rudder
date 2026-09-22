import type { Db } from "@rudderhq/db";
import { createRudderApp } from "../app.js";
import type { createAuthRuntime } from "../bootstrap/auth-runtime.js";
import type { Config } from "../config.js";
import type { LocalRuntimeOwnerKind } from "../local-runtime.js";
import { createStorageServiceFromConfig } from "../storage/index.js";

type AuthRuntime = Awaited<ReturnType<typeof createAuthRuntime>>;
type StorageService = ReturnType<typeof createStorageServiceFromConfig>;

export async function createRudderAppForServerRuntime(input: {
  db: Db;
  config: Config;
  listenPort: number;
  storageService: StorageService;
  authRuntime: AuthRuntime;
  localAccountAuth: boolean;
  activeDatabaseConnectionString: string;
  instanceId: string;
  localEnv: string | null;
  runtimeOwnerKind: LocalRuntimeOwnerKind | null;
  registerNetworkWaitingRunHandler: (handler: (run: any) => Promise<boolean>) => void;
}) {
  const {
    authRuntime,
    config,
    localAccountAuth,
  } = input;
  return createRudderApp(input.db, {
    uiMode: config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none",
    serverPort: input.listenPort,
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    storageService: input.storageService,
    deploymentMode: config.deploymentMode,
    authRequirement: localAccountAuth ? "required" : undefined,
    localRuntimeTrust: localAccountAuth ? "trusted" : undefined,
    deploymentExposure: config.deploymentExposure,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    workspacePreviewOrigin: config.workspacePreviewOrigin,
    authReady: authRuntime.authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    databaseUrl: input.activeDatabaseConnectionString,
    rustFoundationMode: config.rustFoundationMode,
    rustOrganizationBrandingMode: config.rustOrganizationBrandingMode,
    rustProjectGoalSetMode: config.rustProjectGoalSetMode,
    rustFoundationBinaryPath: config.rustFoundationBinaryPath,
    rustFoundationActorEnvelopeKey: config.rustFoundationActorEnvelopeKey,
    mcpDeploymentAllowlists: config.mcpDeploymentAllowlists,
    instanceId: input.instanceId,
    localEnv: input.localEnv,
    runtimeOwnerKind: input.runtimeOwnerKind,
    betterAuthHandler: authRuntime.betterAuthHandler,
    resolveSession: authRuntime.resolveSession,
    localAccountExchangePolicy: authRuntime.localAccountExchangePolicy,
    localAccountSessionRevocation: authRuntime.localAccountSessionRevocation,
    registerNetworkWaitingRunHandler: input.registerNetworkWaitingRunHandler,
  });
}
