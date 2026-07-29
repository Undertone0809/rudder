import type {
  Agent,
  AgentSkillSnapshot,
  OrganizationSkillListItem,
} from "@rudderhq/shared";
import {
  buildAgentSkillMentionOptions,
  buildOrganizationSkillMentionOptions,
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

export function buildChatSkillReferenceOptions(params: {
  agent: Pick<Agent, "id" | "urlKey"> | null | undefined;
  orgUrlKey: string | null | undefined;
  organizationSkills: OrganizationSkillListItem[] | null | undefined;
  skillSnapshot: AgentSkillSnapshot | null | undefined;
}) {
  const optionsByTarget = new Map<string, SkillMentionOption>();
  for (const option of buildOrganizationSkillMentionOptions({
    orgUrlKey: params.orgUrlKey,
    organizationSkills: params.organizationSkills,
  })) {
    optionsByTarget.set(option.skillMarkdownTarget, option);
  }
  for (const option of buildAgentSkillMentionOptions(params)) {
    optionsByTarget.set(option.skillMarkdownTarget, option);
  }
  return [...optionsByTarget.values()];
}

export function filterChatSkillOptions(
  items: SkillMentionOption[],
  query: string,
) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;
  return items.filter((item) => item.searchText.includes(normalizedQuery));
}
