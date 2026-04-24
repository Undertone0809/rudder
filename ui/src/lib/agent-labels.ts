import { AGENT_ROLE_LABELS, type Agent } from "@rudderhq/shared";

const COMPACT_AGENT_TITLE_MAX_LENGTH = 18;

function normalizeAgentLabelPart(value: string | null | undefined) {
  return value?.trim().toLocaleLowerCase() ?? "";
}

export function agentSupportingLabel(agent: Pick<Agent, "role" | "title">) {
  const roleLabel = AGENT_ROLE_LABELS[agent.role] ?? agent.role;
  return agent.title?.trim() || roleLabel;
}

export function agentCompactLabel(agent: Pick<Agent, "role" | "title">) {
  const compactTitle = agent.title?.trim();
  if (compactTitle && compactTitle.length <= COMPACT_AGENT_TITLE_MAX_LENGTH) {
    return compactTitle;
  }
  return AGENT_ROLE_LABELS[agent.role] ?? agent.role;
}

export function formatSidebarAgentLabel(agent: Pick<Agent, "name" | "role" | "title">) {
  const titleLabel = agentSupportingLabel(agent);
  return `${agent.name} (${titleLabel})`;
}

export function formatChatAgentLabel(agent: Pick<Agent, "name" | "role" | "title">) {
  const titleLabel = agentSupportingLabel(agent);
  if (normalizeAgentLabelPart(agent.name) === normalizeAgentLabelPart(titleLabel)) {
    return agent.name;
  }
  return `${agent.name} (${titleLabel})`;
}
