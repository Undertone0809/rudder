import type { Agent } from "@rudderhq/shared";
import { resolveOperatorDisplayName } from "./operator-display";

export function resolveBoardActorLabel(
  actorType: string | null | undefined,
  actorId: string | null | undefined,
  currentBoardUserId?: string | null,
  operatorDisplayName?: string | null,
): string {
  if (actorType === "system") return "System";
  if (actorType === "user") {
    return currentBoardUserId && actorId === currentBoardUserId
      ? resolveOperatorDisplayName(operatorDisplayName)
      : "Board";
  }
  return actorId || "Unknown";
}

export function resolveActivityActorName(
  event: { actorType: string; actorId: string },
  agentMap: Map<string, Agent>,
  currentBoardUserId?: string | null,
  operatorDisplayName?: string | null,
): string {
  if (event.actorType === "agent") {
    return agentMap.get(event.actorId)?.name ?? event.actorId ?? "Unknown";
  }
  return resolveBoardActorLabel(event.actorType, event.actorId, currentBoardUserId, operatorDisplayName);
}
