import type { AgentRuntimeType, DeploymentMode } from "@rudderhq/shared";

export const COMPUTER_USE_SUPPORTED_RUNTIME_TYPES = ["codex_local"] as const satisfies readonly AgentRuntimeType[];

export function resolveComputerUseCapability(input: {
  deploymentMode: DeploymentMode;
  enabled: boolean;
  desktopReady: boolean;
  agentRuntimeType?: string | null;
}) {
  const instanceEligible = input.deploymentMode === "local_trusted" && input.enabled && input.desktopReady;
  const runtimeSupported = COMPUTER_USE_SUPPORTED_RUNTIME_TYPES.includes(
    input.agentRuntimeType as (typeof COMPUTER_USE_SUPPORTED_RUNTIME_TYPES)[number],
  );
  return {
    instanceEligible,
    runtimeSupported,
    runEligible: instanceEligible && runtimeSupported,
  };
}
