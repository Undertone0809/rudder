import type { AgentRuntimeLoadedSkillMeta } from "../agent-runtimes/index.js";

export function summarizeRuntimeSkillsForTrace(entries: AgentRuntimeLoadedSkillMeta[]) {
  return {
    loadedSkillCount: entries.length,
    loadedSkillKeys: entries.map((entry) => entry.key),
    loadedSkills: entries.map((entry) => ({
      key: entry.key,
      runtimeName: entry.runtimeName ?? null,
      name: entry.name ?? null,
      description: entry.description ?? null,
    })),
  };
}
