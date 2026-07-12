import type { Db } from "@rudderhq/db";
import type { DeploymentMode } from "@rudderhq/shared";

export const BROWSER_BUNDLED_SKILL_SELECTION_KEY = "bundled:rudder/browser";

export const SUPPORTED_BROWSER_RUNTIME_TYPES = [
  "claude_local",
  "codex_local",
  "opencode_local",
  "pi_local",
] as const;

const supportedBrowserRuntimeTypes = new Set<string>(SUPPORTED_BROWSER_RUNTIME_TYPES);
const deploymentModesByDb = new WeakMap<object, DeploymentMode>();

export type BrowserCapabilityServiceOptions = {
  deploymentMode?: DeploymentMode;
};

export function configureBrowserCapabilityDeployment(db: Db, deploymentMode: DeploymentMode) {
  deploymentModesByDb.set(db as object, deploymentMode);
}

export function resolveBrowserCapabilityDeployment(
  db: Db,
  override?: DeploymentMode,
): DeploymentMode {
  return override ?? deploymentModesByDb.get(db as object) ?? "authenticated";
}

export function isSupportedBrowserRuntimeType(agentRuntimeType: string | null | undefined) {
  return Boolean(agentRuntimeType && supportedBrowserRuntimeTypes.has(agentRuntimeType));
}

export function isBrowserSkillSelectionKey(value: unknown) {
  return value === BROWSER_BUNDLED_SKILL_SELECTION_KEY || value === "rudder/browser";
}

export function resolveBrowserCapability(input: {
  deploymentMode: DeploymentMode;
  browserEnabled: boolean;
  agentRuntimeType?: string | null;
}) {
  const instanceEligible = input.deploymentMode === "local_trusted" && input.browserEnabled;
  return {
    instanceEligible,
    runEligible: instanceEligible && isSupportedBrowserRuntimeType(input.agentRuntimeType),
  };
}
