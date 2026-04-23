import { models as claudeLocalModels } from "@rudder/agent-runtime-claude-local";
import { models as codexLocalModels } from "@rudder/agent-runtime-codex-local";
import { models as cursorLocalModels } from "@rudder/agent-runtime-cursor-local";
import { models as geminiLocalModels } from "@rudder/agent-runtime-gemini-local";
import type { AgentRuntimeModel } from "../api/agents";

const FALLBACK_MODELS_BY_RUNTIME: Record<string, readonly AgentRuntimeModel[]> = {
  claude_local: claudeLocalModels,
  codex_local: codexLocalModels,
  cursor: cursorLocalModels,
  gemini_local: geminiLocalModels,
};

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
    resolved.push({
      id,
      label: candidate.label.trim() || id,
    });
  }

  return resolved;
}
