import type { Db } from "@rudderhq/db";
import {
  localRuntimeTrustForDeploymentMode,
  type DeploymentMode,
  type LocalRuntimeTrust,
} from "@rudderhq/shared";

export const BROWSER_BUNDLED_SKILL_SELECTION_KEY = "bundled:rudder/browser";

export const SUPPORTED_BROWSER_RUNTIME_TYPES = [
  "claude_local",
  "codex_local",
  "opencode_local",
  "pi_local",
] as const;

const supportedBrowserRuntimeTypes = new Set<string>(SUPPORTED_BROWSER_RUNTIME_TYPES);
const deploymentModesByDb = new WeakMap<object, DeploymentMode>();
const localRuntimeTrustByDb = new WeakMap<object, LocalRuntimeTrust>();

export type BrowserCapabilityServiceOptions = {
  deploymentMode?: DeploymentMode;
  localRuntimeTrust?: LocalRuntimeTrust;
};

export function configureBrowserCapabilityDeployment(
  db: Db,
  deploymentMode: DeploymentMode,
  localRuntimeTrust?: LocalRuntimeTrust,
) {
  deploymentModesByDb.set(db as object, deploymentMode);
  localRuntimeTrustByDb.set(
    db as object,
    localRuntimeTrust ?? localRuntimeTrustForDeploymentMode(deploymentMode),
  );
}

export function resolveBrowserCapabilityDeployment(
  db: Db,
  override?: DeploymentMode,
): DeploymentMode {
  return override ?? deploymentModesByDb.get(db as object) ?? "authenticated";
}

export function resolveLocalRuntimeTrust(
  db: Db,
  override?: LocalRuntimeTrust,
): LocalRuntimeTrust {
  if (override) return override;
  const configured = localRuntimeTrustByDb.get(db as object);
  if (configured) return configured;
  return localRuntimeTrustForDeploymentMode(resolveBrowserCapabilityDeployment(db));
}

export function isSupportedBrowserRuntimeType(agentRuntimeType: string | null | undefined) {
  return Boolean(agentRuntimeType && supportedBrowserRuntimeTypes.has(agentRuntimeType));
}

export function isBrowserSkillSelectionKey(value: unknown) {
  return value === BROWSER_BUNDLED_SKILL_SELECTION_KEY || value === "rudder/browser";
}

export function resolveBrowserCapability(input: {
  deploymentMode: DeploymentMode;
  localRuntimeTrust?: LocalRuntimeTrust;
  browserEnabled: boolean;
  agentRuntimeType?: string | null;
}) {
  const localRuntimeTrust =
    input.localRuntimeTrust ?? localRuntimeTrustForDeploymentMode(input.deploymentMode);
  const instanceEligible = localRuntimeTrust === "trusted" && input.browserEnabled;
  return {
    instanceEligible,
    runEligible: instanceEligible && isSupportedBrowserRuntimeType(input.agentRuntimeType),
  };
}
