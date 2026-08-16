type PluginSkillComponent = {
  type: string;
  metadata: unknown;
};

export function enabledAgentIdsFromMetadata(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return [];
  const value = (metadata as { enabledAgentIds?: unknown }).enabledAgentIds;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function inheritedPluginSkillAgentIds(components: readonly PluginSkillComponent[]): string[] {
  return [...new Set(components
    .filter((component) => component.type === "skill")
    .flatMap((component) => enabledAgentIdsFromMetadata(component.metadata)))];
}
