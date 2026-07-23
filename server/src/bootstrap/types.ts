import type { DeploymentExposure, DeploymentMode } from "@rudderhq/shared";
import type { Request, RequestHandler } from "express";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import type { McpDeploymentAllowlists } from "../services/mcp/security-policy.js";
import type { StorageService } from "../storage/types.js";

export type UiMode = "none" | "static" | "vite-dev";

export interface RudderAppOptions {
  uiMode: UiMode;
  serverPort: number;
  storageService: StorageService;
  deploymentMode: DeploymentMode;
  deploymentExposure: DeploymentExposure;
  allowedHostnames: string[];
  bindHost: string;
  workspacePreviewOrigin?: string;
  authReady: boolean;
  companyDeletionEnabled: boolean;
  /**
   * Instance-administrator MCP exceptions. Embedded callers may omit this
   * while managed MCP routes are not mounted; production bootstrap always
   * supplies an explicit (deny-all by default) value.
   */
  mcpDeploymentAllowlists?: McpDeploymentAllowlists;
  instanceId?: string;
  localEnv?: string | null;
  runtimeOwnerKind?: string | null;
  hostVersion?: string;
  localPluginDir?: string;
  betterAuthHandler?: RequestHandler;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
}
