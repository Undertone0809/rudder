import { requestsApi } from "@/api/requests";
import { invalidateMessengerThreadSummaryQueries } from "@/lib/messenger-query-cache";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import type { AssistanceRequest } from "@rudderhq/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, MessageSquare, XCircle } from "lucide-react";
import { useState } from "react";
import { useToast } from "../context/ToastContext";
import { MarkdownBody } from "./MarkdownBody";
import { SpecialMessageCard, type SpecialMessageCardVariant } from "./SpecialMessageCard";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

type AssistanceResolution = "answered" | "action_completed" | "cannot_help";

const RESOLUTION_LABELS: Record<AssistanceResolution, string> = {
  answered: "Answered",
  action_completed: "Action completed",
  cannot_help: "Cannot help",
};

const SUPERSEDED_REASON_LABELS: Record<string, string> = {
  blocker_changed: "The blocking condition changed.",
  material_progress: "The issue made material progress.",
  reassigned: "The issue was reassigned.",
};

export function assistanceRequestStatusLabel(request: AssistanceRequest): string {
  if (request.status === "resolved" && request.resolution) {
    return RESOLUTION_LABELS[request.resolution];
  }
  return request.status.charAt(0).toUpperCase() + request.status.slice(1);
}

function requestTimestamp(value: Date | string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function requestDraftKey(requestId: string): string {
  return `rudder:assistance-request-draft:${requestId}`;
}

function loadRequestDraft(requestId: string): string {
  try {
    return localStorage.getItem(requestDraftKey(requestId)) ?? "";
  } catch {
    return "";
  }
}

function saveRequestDraft(requestId: string, value: string): void {
  try {
    if (value) localStorage.setItem(requestDraftKey(requestId), value);
    else localStorage.removeItem(requestDraftKey(requestId));
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }
}

export function AssistanceRequestPanel({
  request,
  orgId,
  issueStatus,
  showTitle = true,
  showRequestsLink = true,
  source,
  className,
}: {
  request: AssistanceRequest;
  orgId: string;
  issueStatus?: string | null;
  showTitle?: boolean;
  showRequestsLink?: boolean;
  source?: { label: string; href: string } | null;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [responseState, setResponseState] = useState(() => ({
    requestId: request.id,
    value: loadRequestDraft(request.id),
  }));
  const response = responseState.requestId === request.id
    ? responseState.value
    : loadRequestDraft(request.id);
  const isOpen = request.status === "open";
  const attempt = Number(request.metadata.attempt ?? 1);
  const pendingLabel = issueStatus
    ? `${issueStatus === "blocked" ? "Blocked" : "In progress"} · Waiting on you`
    : "Waiting on you";

  const invalidateRequestSurfaces = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["requests", orgId] }),
      queryClient.invalidateQueries({ queryKey: queryKeys.requests.detail(request.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(request.issueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.messenger.approvals(orgId) }),
      invalidateMessengerThreadSummaryQueries(queryClient, orgId),
    ]);
  };

  const resolveMutation = useMutation({
    mutationFn: (resolution: AssistanceResolution) => requestsApi.resolveAssistance(
      request.id,
      resolution,
      response.trim() || (resolution === "cannot_help"
        ? "I cannot help with this request."
        : "The requested action is complete."),
    ),
    onSuccess: async () => {
      setResponseState({ requestId: request.id, value: "" });
      saveRequestDraft(request.id, "");
      await invalidateRequestSurfaces();
    },
    onError: (error) => {
      pushToast({
        title: "Failed to resolve request",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const cancelMutation = useMutation({
    mutationFn: () => requestsApi.cancelAssistance(request.id, response.trim() || undefined),
    onSuccess: async () => {
      setResponseState({ requestId: request.id, value: "" });
      saveRequestDraft(request.id, "");
      await invalidateRequestSurfaces();
    },
    onError: (error) => {
      pushToast({
        title: "Failed to cancel request",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
  });
  const isPending = resolveMutation.isPending || cancelMutation.isPending;
  const resolvedAt = requestTimestamp(request.resolvedAt);
  const supersededReason = typeof request.metadata.supersededReason === "string"
    ? (SUPERSEDED_REASON_LABELS[request.metadata.supersededReason]
      ?? "A newer request replaced this one.")
    : null;
  const terminalResponse = request.response
    || supersededReason
    || (request.status === "cancelled" ? "This request was cancelled." : "No response provided.");
  const variant: SpecialMessageCardVariant = isOpen
    ? "info"
    : request.status === "resolved"
      ? "success"
      : "error";
  const StatusIcon = isOpen ? MessageSquare : request.status === "resolved" ? CheckCircle2 : XCircle;

  return (
    <SpecialMessageCard
      variant={variant}
      title={showTitle ? request.title : "Assistance request"}
      headerMeta={(
        <>
          <StatusIcon className="h-4 w-4" />
          <span>{isOpen ? pendingLabel : assistanceRequestStatusLabel(request)}</span>
          <span className="opacity-70">Attempt {attempt}/3</span>
          {!isOpen && resolvedAt ? <span className="opacity-70">{resolvedAt}</span> : null}
        </>
      )}
      description={<MarkdownBody>{request.prompt}</MarkdownBody>}
      actions={isOpen ? (
        <div className="space-y-3">
          <Textarea
            aria-label="Answer or describe what changed"
            value={response}
            onChange={(event) => {
              setResponseState({ requestId: request.id, value: event.target.value });
              saveRequestDraft(request.id, event.target.value);
            }}
            placeholder="Answer or describe what changed"
            className="min-h-20 resize-y"
            disabled={isPending}
          />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => resolveMutation.mutate("answered")} disabled={!response.trim() || isPending}>
              Send answer
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolveMutation.mutate("action_completed")} disabled={isPending}>
              Mark action complete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => resolveMutation.mutate("cannot_help")} disabled={isPending}>
              Cannot help
            </Button>
            <Button size="sm" variant="ghost" onClick={() => cancelMutation.mutate()} disabled={isPending}>
              Cancel request
            </Button>
          </div>
        </div>
      ) : null}
      className={className}
      testId={`assistance-request-panel-${request.id}`}
      ariaLabel="Assistance request"
    >
      {!isOpen ? (
        <div className="space-y-1 border-t border-border/70 pt-3">
          <p className="text-xs font-medium uppercase text-muted-foreground">
            {request.status === "superseded" ? "Superseded because" : "Response"}
          </p>
          <p className="break-words whitespace-pre-wrap text-sm text-foreground">
            {terminalResponse}
          </p>
        </div>
      ) : null}
      {(source || showRequestsLink) ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/70 pt-3 text-xs">
          {source ? (
            <Link to={source.href} className="inline-flex items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground hover:underline">
              Source: {source.label}
              <ExternalLink className="h-3 w-3" />
            </Link>
          ) : null}
          {showRequestsLink ? (
            <Link to="/messenger/approvals" className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground hover:underline">
              Open in Requests
              <ExternalLink className="h-3 w-3" />
            </Link>
          ) : null}
        </div>
      ) : null}
    </SpecialMessageCard>
  );
}
