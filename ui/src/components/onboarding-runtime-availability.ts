import type { AgentRuntimeAvailability } from "@rudderhq/shared";
import type { AdapterType } from "./OnboardingWizard.parts";

export type OnboardingRuntimeInstallHint = {
  agentRuntimeType: OnboardingLocalRuntimeType;
  label: string;
  installUrl: string;
  installLabel: string;
};

export const ONBOARDING_LOCAL_RUNTIME_TYPES = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
] as const satisfies readonly AdapterType[];

export type OnboardingLocalRuntimeType = (typeof ONBOARDING_LOCAL_RUNTIME_TYPES)[number];

export const ONBOARDING_RUNTIME_SELECTION_ORDER: OnboardingLocalRuntimeType[] = [
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
];

export const ONBOARDING_RUNTIME_INSTALL_HINTS: OnboardingRuntimeInstallHint[] = [
  {
    agentRuntimeType: "claude_local",
    label: "Claude Code",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code/setup",
    installLabel: "Install Claude Code",
  },
  {
    agentRuntimeType: "codex_local",
    label: "Codex",
    installUrl: "https://developers.openai.com/codex/",
    installLabel: "Install Codex",
  },
  {
    agentRuntimeType: "gemini_local",
    label: "Gemini CLI",
    installUrl: "https://github.com/google-gemini/gemini-cli",
    installLabel: "Install Gemini CLI",
  },
  {
    agentRuntimeType: "opencode_local",
    label: "OpenCode",
    installUrl: "https://opencode.ai/docs/",
    installLabel: "Install OpenCode",
  },
  {
    agentRuntimeType: "pi_local",
    label: "Pi",
    installUrl: "https://www.mintlify.com/badlogic/pi-mono/installation",
    installLabel: "Install Pi",
  },
  {
    agentRuntimeType: "cursor",
    label: "Cursor",
    installUrl: "https://cursor.com/download",
    installLabel: "Install Cursor",
  },
];

export function isOnboardingLocalRuntime(type: AdapterType): type is OnboardingLocalRuntimeType {
  return (ONBOARDING_LOCAL_RUNTIME_TYPES as readonly string[]).includes(type);
}

export function buildRuntimeAvailabilityMap(
  runtimes: AgentRuntimeAvailability[] | undefined,
): Map<string, AgentRuntimeAvailability> {
  return new Map((runtimes ?? []).map((runtime) => [runtime.agentRuntimeType, runtime]));
}

export function isRuntimeSelectable(
  type: AdapterType,
  availability: Map<string, AgentRuntimeAvailability>,
): boolean {
  if (!isOnboardingLocalRuntime(type)) return true;
  return availability.get(type)?.available === true;
}

export function pickFirstAvailableRuntime(
  availability: Map<string, AgentRuntimeAvailability>,
): OnboardingLocalRuntimeType | null {
  return (
    ONBOARDING_RUNTIME_SELECTION_ORDER.find((type) => availability.get(type)?.available === true) ??
    null
  );
}

export function listMissingRuntimes(
  availability: Map<string, AgentRuntimeAvailability>,
): AgentRuntimeAvailability[] {
  return ONBOARDING_RUNTIME_SELECTION_ORDER.flatMap((type) => {
    const runtime = availability.get(type);
    return runtime && !runtime.available ? [runtime] : [];
  });
}
