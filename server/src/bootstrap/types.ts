import type { Request, RequestHandler } from "express";
import type { DeploymentExposure, DeploymentMode } from "@rudder/shared";
import type { StorageService } from "../storage/types.js";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";

export type UiMode = "none" | "static" | "vite-dev";

export interface RudderAppOptions {
  uiMode: UiMode;
  serverPort: number;
  storageService: StorageService;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  allowedHostnames: string[];
  bindHost: string;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  instanceId?: string;
  localEnv?: string | null;
  runtimeOwnerKind?: string | null;
  hostVersion?: string;
  localPluginDir?: string;
  betterAuthHandler?: RequestHandler;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}
