import { applyOrganizationPrefix, extractOrganizationPrefixFromPath } from "@/lib/organization-routes";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import type { Agent, ChatConversation, ChatMessage } from "@rudderhq/shared";
import { RotateCcw } from "lucide-react";
import { resolveChatMessageAgentRunTarget } from "./Chat.parts";

export function ChatFailedMessageActions({
  message,
  conversation,
  agents,
  canRetry,
  onRetry,
}: {
  message: ChatMessage;
  conversation: ChatConversation;
  agents: Agent[] | undefined;
  canRetry: boolean;
  onRetry: ((message: ChatMessage) => void) | undefined;
}) {
  const runTarget = resolveChatMessageAgentRunTarget(message, conversation);
  const runAgent = runTarget
    ? agents?.find((agent) => agent.id === runTarget.agentId)
    : null;
  const runAgentRef = runAgent ? agentRouteRef(runAgent) : runTarget?.agentId;
  const organizationPrefix = typeof window === "undefined"
    ? null
    : extractOrganizationPrefixFromPath(window.location.pathname);
  const runHref = runTarget
    ? applyOrganizationPrefix(
        `/agents/${runAgentRef}/runs/${runTarget.runId}`,
        organizationPrefix,
      )
    : null;

  if (!runHref && !canRetry) return null;

  return (
    <div className="flex basis-full shrink-0 flex-wrap items-center justify-end gap-2 pl-7 sm:basis-auto sm:pl-0">
      {runHref ? (
        <Link
          to={runHref}
          className="inline-flex h-7 items-center rounded-md border border-border bg-background/70 px-2 text-xs font-medium text-foreground transition-colors hover:bg-background"
        >
          Open run
        </Link>
      ) : null}
      {canRetry ? (
        <button
          type="button"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-destructive/30 bg-background/70 px-2 text-xs font-medium text-destructive transition-colors hover:bg-background"
          onClick={() => onRetry?.(message)}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          Retry
        </button>
      ) : null}
    </div>
  );
}
