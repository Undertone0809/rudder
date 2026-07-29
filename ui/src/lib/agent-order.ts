import type { Agent } from "@rudderhq/shared";

export const AGENT_ORDER_UPDATED_EVENT = "rudder:agent-order-updated";
const AGENT_ORDER_STORAGE_PREFIX = "rudder.agentOrder";
const ANONYMOUS_USER_ID = "anonymous";

type AgentOrderUpdatedDetail = {
  storageKey: string;
  orderedIds: string[];
};

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function resolveUserId(userId: string | null | undefined): string {
  if (!userId) return ANONYMOUS_USER_ID;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : ANONYMOUS_USER_ID;
}

export function getAgentOrderStorageKey(orgId: string, userId: string | null | undefined): string {
  return `${AGENT_ORDER_STORAGE_PREFIX}:${orgId}:${resolveUserId(userId)}`;
}

export function readAgentOrder(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    return normalizeIdList(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeAgentOrder(storageKey: string, orderedIds: string[]) {
  const normalized = normalizeIdList(orderedIds);
  try {
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch {
    // Ignore storage write failures in restricted browser contexts.
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AgentOrderUpdatedDetail>(AGENT_ORDER_UPDATED_EVENT, {
        detail: { storageKey, orderedIds: normalized },
      }),
    );
  }
}

export function sortAgentsByDefaultSidebarOrder(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => left.name.localeCompare(right.name));
}

export function sortAgentsByStoredOrder(agents: Agent[], orderedIds: string[]): Agent[] {
  if (agents.length === 0) return [];

  const defaultSorted = sortAgentsByDefaultSidebarOrder(agents);
  if (orderedIds.length === 0) return defaultSorted;

  const byId = new Map(defaultSorted.map((agent) => [agent.id, agent]));
  const sorted: Agent[] = [];

  for (const id of orderedIds) {
    const agent = byId.get(id);
    if (!agent) continue;
    sorted.push(agent);
    byId.delete(id);
  }

  for (const agent of defaultSorted) {
    if (byId.has(agent.id)) {
      sorted.push(agent);
      byId.delete(agent.id);
    }
  }

  return sorted;
}
