import type {
  Agent,
  AgentSkillSnapshot,
  OrganizationSkillListItem,
} from "@rudder/shared";
import {
  buildAgentSkillMentionOptions,
  type SkillMentionOption,
} from "./agent-skill-mentions";

export function buildChatSkillOptions(params: {
  agent: Pick<Agent, "id" | "urlKey"> | null | undefined;
  orgUrlKey: string | null | undefined;
  organizationSkills: OrganizationSkillListItem[] | null | undefined;
  skillSnapshot: AgentSkillSnapshot | null | undefined;
}) {
  return buildAgentSkillMentionOptions(params);
}

export function filterChatSkillOptions(
  items: SkillMentionOption[],
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => item.searchText.includes(normalizedQuery));
}
