import type { Agent } from "@rudderhq/shared";

export function resolveRequestedPreferredAgentId(
  requestedAgentId: string | null | undefined,
  agents: Array<Pick<Agent, "id" | "status">>,
): string | null {
  const trimmedAgentId = requestedAgentId?.trim() ?? "";
  if (!trimmedAgentId) return null;

  const matchingAgent = agents.find((agent) => agent.id === trimmedAgentId);
  if (!matchingAgent || matchingAgent.status === "terminated") return null;

  return matchingAgent.id;
}
