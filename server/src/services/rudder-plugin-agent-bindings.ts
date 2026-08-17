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

export function organizationSkillSelectionKey(key: string): string {
  return key.startsWith("org:") ? key : `org:${key}`;
}

export function organizationSkillSelectionKeys(skills: readonly { key: string }[]): string[] {
  return skills.map((skill) => organizationSkillSelectionKey(skill.key));
}

export function selectedAgentIdsForSkill(
  selected: readonly { skillKey: string; agentId: string }[],
  skillKey: string,
): string[] {
  const selectionKey = organizationSkillSelectionKey(skillKey);
  return selected.filter((row) => row.skillKey === selectionKey).map((row) => row.agentId);
}
