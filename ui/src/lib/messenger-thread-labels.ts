import type { MessengerThreadKind } from "@rudderhq/shared";

export function messengerThreadKindLabel(kind: MessengerThreadKind): string {
  switch (kind) {
    case "chat":
      return "Chat";
    case "issues":
      return "Issues";
    case "approvals":
      return "Requests";
    case "failed-runs":
      return "Failed runs";
    case "budget-alerts":
      return "Budget alerts";
    case "join-requests":
      return "Join requests";
    default:
      return kind;
  }
}
