import type { Agent } from "@rudderhq/shared";

export const NO_CHAT_AGENT_ID = "__none__";

const CHAT_LAST_AGENT_STORAGE_KEY = "rudder.chatLastAgentByOrg";

type ChatAgentSelectionCandidate = Pick<Agent, "id" | "status">;

function chatAgentSelectionStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function selectableChatAgents<T extends ChatAgentSelectionCandidate>(
  agents: readonly T[] | null | undefined,
): T[] {
  return (agents ?? []).filter((agent) => agent.status !== "terminated");
}

export function readRememberedChatAgentId(orgId: string): string | undefined {
  try {
    const raw = chatAgentSelectionStorage()?.getItem(CHAT_LAST_AGENT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = (parsed as Record<string, unknown>)[orgId];
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function rememberChatAgentId(orgId: string, agentId: string) {
  if (!agentId || agentId === NO_CHAT_AGENT_ID) return;
  try {
    const storage = chatAgentSelectionStorage();
    if (!storage) return;
    const raw = storage.getItem(CHAT_LAST_AGENT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const next = parsed && typeof parsed === "object" ? parsed as Record<string, string> : {};
    next[orgId] = agentId;
    storage.setItem(CHAT_LAST_AGENT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    return;
  }
}

export function isSelectableChatAgentId(
  agentId: string | null | undefined,
  agents: readonly ChatAgentSelectionCandidate[] | null | undefined,
) {
  return Boolean(agentId && selectableChatAgents(agents).some((agent) => agent.id === agentId));
}

export function resolveDefaultChatAgentId(
  orgId: string | null | undefined,
  agents: readonly ChatAgentSelectionCandidate[] | null | undefined,
) {
  const selectableAgents = selectableChatAgents(agents);
  if (selectableAgents.length === 0) return NO_CHAT_AGENT_ID;

  const rememberedAgentId = orgId ? readRememberedChatAgentId(orgId) : undefined;
  if (rememberedAgentId && selectableAgents.some((agent) => agent.id === rememberedAgentId)) {
    return rememberedAgentId;
  }

  return selectableAgents[0]!.id;
}
