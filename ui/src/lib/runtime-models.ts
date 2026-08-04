import { models as claudeLocalModels } from "@rudderhq/agent-runtime-claude-local";
import { models as codexLocalModels } from "@rudderhq/agent-runtime-codex-local";
import { models as cursorLocalModels } from "@rudderhq/agent-runtime-cursor-local";
import { models as geminiLocalModels } from "@rudderhq/agent-runtime-gemini-local";
import type { AgentRuntimeEnvironmentTestResult } from "@rudderhq/shared";
import type { AgentRuntimeModel } from "../api/agents";

const FALLBACK_MODELS_BY_RUNTIME: Record<string, readonly AgentRuntimeModel[]> = {
  claude_local: claudeLocalModels,
  codex_local: codexLocalModels,
  cursor: cursorLocalModels,
  gemini_local: geminiLocalModels,
};

export const PROVIDER_MODEL_RUNTIME_TYPES = ["opencode_local", "pi_local"] as const;

function isClaudeDeepSeekModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith("deepseek");
}

export function requiresExplicitProviderModel(agentRuntimeType: string): boolean {
  return PROVIDER_MODEL_RUNTIME_TYPES.includes(
    agentRuntimeType as (typeof PROVIDER_MODEL_RUNTIME_TYPES)[number],
  );
}

export function isProviderModelFormat(model: string): boolean {
  const [provider, modelId] = model.split("/", 2).map((part) => part.trim());
  return Boolean(provider && modelId);
}

export function runtimeModelEmptyLabel(agentRuntimeType: string, required = false): string {
  if (requiresExplicitProviderModel(agentRuntimeType)) return "Select or enter provider/model";
  if (required) return "Select model";
  return "Default";
}

export function runtimeModelSearchPlaceholder(agentRuntimeType: string): string {
  return requiresExplicitProviderModel(agentRuntimeType)
    ? "Search or enter provider/model..."
    : "Search models...";
}

export function runtimeModelEmptyMessage(agentRuntimeType: string, loading = false): string {
  if (loading) return "Loading models...";
  if (agentRuntimeType === "pi_local") {
    return "No models discovered. Run `pi --list-models`, authenticate the provider, or enter provider/model such as deepseek/deepseek-chat and run Test now.";
  }
  if (agentRuntimeType === "opencode_local") {
    return "No models discovered. Run `opencode models --verbose`, authenticate the provider, or enter provider/model and run Test now.";
  }
  return "No models found.";
}

export function explicitProviderModelError(agentRuntimeType: string): string {
  if (agentRuntimeType === "pi_local") {
    return "Pi requires provider/model, for example kimi-coding/kimi-for-coding.";
  }
  if (agentRuntimeType === "opencode_local") {
    return "OpenCode requires provider/model, for example opencode/deepseek-v4-flash-free.";
  }
  return "This runtime requires provider/model.";
}

export function providerFromModelId(model: string): string | null {
  const slash = model.indexOf("/");
  const provider = slash >= 0 ? model.slice(0, slash).trim() : model.trim();
  return provider || null;
}

export function modelNameFromProviderModelId(model: string): string | null {
  const slash = model.indexOf("/");
  const modelId = slash >= 0 ? model.slice(slash + 1).trim() : "";
  return modelId || null;
}

export function runtimeProviderSetupHint(agentRuntimeType: string, model: string): string | null {
  const provider = providerFromModelId(model);
  if (agentRuntimeType === "claude_local" && isClaudeDeepSeekModel(model)) {
    return "For Claude Code + DeepSeek, use a DeepSeek model such as deepseek-v4-pro[1m]. Paste DEEPSEEK_API_KEY below or reference the existing organization secret, then use Test now as the source of truth.";
  }
  if (agentRuntimeType === "pi_local") {
    if (provider === "deepseek") {
      return "For Pi + DeepSeek, use provider/model such as deepseek/deepseek-chat. Paste DEEPSEEK_API_KEY below, or use pi /login if DeepSeek is already configured locally. If Pi routes through OpenRouter, use openrouter/deepseek/deepseek-chat and paste OPENROUTER_API_KEY. Test now is the source of truth.";
    }
    if (provider) {
      return `For Pi, authenticate provider "${provider}" with pi /login, auth.json, or provider env, then use Test now to prove the selected model can answer.`;
    }
    return "Pi models use provider/model format. Use pi --list-models, or enter a custom provider/model and run Test now.";
  }
  if (agentRuntimeType === "opencode_local") {
    if (provider) {
      return `For OpenCode, authenticate provider "${provider}" with opencode auth login or provider env, then use Test now to prove the selected model can answer.`;
    }
    return "OpenCode models use provider/model format. Use opencode models, or enter a custom provider/model and run Test now.";
  }
  return null;
}

export function runtimeProviderCredentialEnvKey(agentRuntimeType: string, model: string): string | null {
  const provider = providerFromModelId(model);
  if (agentRuntimeType === "claude_local" && isClaudeDeepSeekModel(model)) return "DEEPSEEK_API_KEY";
  if (agentRuntimeType === "pi_local") {
    if (provider === "deepseek") return "DEEPSEEK_API_KEY";
    if (provider === "openrouter") return "OPENROUTER_API_KEY";
    if (provider === "kimi-coding" || provider === "kimi") return "KIMI_API_KEY";
  }
  return null;
}

export function runtimeProviderCredentialLabel(agentRuntimeType: string, model: string): string | null {
  const envKey = runtimeProviderCredentialEnvKey(agentRuntimeType, model);
  if (!envKey) return null;
  return `${envKey} for ${model.trim() || "this provider"}`;
}

export function runtimeManualProbeCommand(agentRuntimeType: string, command: string, model: string): string {
  const executable = command.trim();
  if (agentRuntimeType === "cursor") {
    return `${executable} --trust -p --mode ask --output-format json "Respond with hello."`;
  }
  if (agentRuntimeType === "codex_local") {
    return `${executable} exec --dangerously-bypass-approvals-and-sandbox --json "Respond with hello."`;
  }
  if (agentRuntimeType === "gemini_local") {
    return `${executable} -p "Respond with hello." --approval-mode yolo --skip-trust --output-format json`;
  }
  if (agentRuntimeType === "opencode_local") {
    const modelArg = model.trim() ? ` --model ${model.trim()}` : "";
    return `${executable} run --format json${modelArg} "Respond with hello."`;
  }
  if (agentRuntimeType === "pi_local") {
    const provider = providerFromModelId(model) ?? "<provider>";
    const modelId = modelNameFromProviderModelId(model) ?? "<model>";
    return `${executable} -p "Respond with hello." --mode json --provider ${provider} --model ${modelId} --tools read`;
  }
  return `${executable} -p "Respond with hello." --output-format json --no-session-persistence --permission-mode auto --bare --tools ""`;
}

export function runtimeAuthRecoveryHint(agentRuntimeType: string, model: string): string {
  const provider = providerFromModelId(model);
  if (agentRuntimeType === "claude_local" && isClaudeDeepSeekModel(model)) {
    return "If auth fails, set DEEPSEEK_API_KEY in the runtime env or organization secret binding, then retry Claude Code Test now.";
  }
  if (agentRuntimeType === "cursor") return "If auth fails, set CURSOR_API_KEY in env or run cursor-agent login.";
  if (agentRuntimeType === "codex_local") return "If auth fails, run codex login or configure the OpenAI credentials Codex already uses locally.";
  if (agentRuntimeType === "gemini_local") return "If auth fails, set GEMINI_API_KEY in env or run gemini auth.";
  if (agentRuntimeType === "opencode_local") return "If auth fails, run opencode auth login or set the provider API key in env.";
  if (agentRuntimeType === "pi_local" && provider === "deepseek") {
    return "If auth fails, set DEEPSEEK_API_KEY for native Pi DeepSeek or run pi /login. If Pi asks for openrouter, set OPENROUTER_API_KEY or add a native DeepSeek provider/model in ~/.pi/agent/models.json.";
  }
  if (agentRuntimeType === "pi_local" && provider) {
    return `If auth fails, authenticate provider "${provider}" with pi /login, ~/.pi/agent/auth.json, or provider env.`;
  }
  return "If login is required, run claude auth login and retry.";
}

export function blockingRuntimeEnvironmentMessage(
  result: Pick<AgentRuntimeEnvironmentTestResult, "checks" | "status">,
): string | null {
  const blockingCheck = result.checks.find((check) =>
    check.level === "error"
    || /_hello_probe_(auth_required|model_unavailable|timed_out|unexpected_output|failed)$/.test(check.code)
  );
  if (result.status === "fail" || blockingCheck) {
    const detail = blockingCheck?.hint || blockingCheck?.message;
    return detail
      ? `Runtime environment test is not ready: ${detail}`
      : "Runtime environment test is not ready. Fix the runtime setup and run Test now again.";
  }
  return null;
}

export function resolveRuntimeModels(
  agentRuntimeType: string,
  ...modelLists: Array<readonly AgentRuntimeModel[] | null | undefined>
): AgentRuntimeModel[] {
  const candidates = [
    ...modelLists.flatMap((models) => models ?? []),
    ...(FALLBACK_MODELS_BY_RUNTIME[agentRuntimeType] ?? []),
  ];
  const seen = new Set<string>();
  const resolved: AgentRuntimeModel[] = [];

  for (const candidate of candidates) {
    const id = candidate.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const variants = Array.isArray(candidate.variants)
      ? [...new Set(candidate.variants.filter((variant) => typeof variant === "string" && variant.trim().length > 0))]
      : undefined;
    const reasoning = candidate.capabilities?.reasoning;
    resolved.push({
      id,
      label: candidate.label?.trim() || id,
      ...(variants ? { variants } : {}),
      ...(typeof reasoning === "boolean" ? { capabilities: { reasoning } } : {}),
    });
  }

  return resolved;
}
