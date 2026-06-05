import type { Agent } from "@rudderhq/shared";

export function sidebarAgentStatusTag(agent: Pick<Agent, "status">) {
  return agent.status === "paused" ? "paused" : null;
}
