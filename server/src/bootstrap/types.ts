import type {
  AuthRequirement,
  DeploymentExposure,
  DeploymentMode,
  LocalRuntimeTrust,
} from "@rudderhq/shared";
import type { Request, RequestHandler } from "express";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import type { LocalAccountExchangePolicy } from "../services/local-account-auth.js";
import type { LocalAccountSessionRevocation } from "../services/local-account-session-revocation.js";
import type { McpDeploymentAllowlists } from "../services/mcp/security-policy.js";
import type { StorageService } from "../storage/types.js";

export type UiMode = "none" | "static" | "vite-dev";

export interface RudderAppOptions {
  uiMode: UiMode;
  serverPort: number;
  /** Canonical external HTTPS origin used for authenticated OAuth callbacks. */
  authPublicBaseUrl?: string | null;
  storageService: StorageService;
  deploymentMode: DeploymentMode;
  /** Independent human-login gate; omitted callers preserve deployment-mode behavior. */
  authRequirement?: AuthRequirement;
  /** Independent host capability trust; omitted callers preserve deployment-mode behavior. */
  localRuntimeTrust?: LocalRuntimeTrust;
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
  /** Host environment source used only through managed MCP allowlist policy. */
  mcpHostEnv?: Record<string, string | undefined>;
  instanceId?: string;
  localEnv?: string | null;
  runtimeOwnerKind?: string | null;
  hostVersion?: string;
  localPluginDir?: string;
  betterAuthHandler?: RequestHandler;
  resolveSession?: (req: Request) => Promise<BetterAuthSessionResult | null>;
  localAccountExchangePolicy?: LocalAccountExchangePolicy;
  localAccountSessionRevocation?: LocalAccountSessionRevocation;
}
