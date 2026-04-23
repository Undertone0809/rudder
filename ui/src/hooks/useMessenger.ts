import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  MessengerApprovalThreadItem,
  MessengerEvent,
  MessengerIssueThreadItem,
  MessengerSystemThreadKind,
  MessengerThreadDetail,
  MessengerThreadKind,
  MessengerThreadSummary,
} from "@rudder/shared";
import { authApi } from "@/api/auth";
import { messengerApi } from "@/api/messenger";
import { useOrganization } from "@/context/OrganizationContext";
import { queryKeys } from "@/lib/queryKeys";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { useLocation } from "@/lib/router";

export type MessengerRouteState =
  | { kind: "root" }
  | { kind: "chat"; conversationId?: string }
  | { kind: "issues" }
  | { kind: "approvals" }
  | { kind: "system"; threadKind: MessengerSystemThreadKind };

export interface MessengerModel {
  currentUserId: string | null;
  selectedOrganizationId: string | null;
  threadSummaries: MessengerThreadSummary[];
  issueThreadDetail: MessengerThreadDetail<MessengerIssueThreadItem> | null;
  approvalThreadDetail: MessengerThreadDetail<MessengerApprovalThreadItem> | null;
  systemThreadDetail: MessengerThreadDetail<MessengerEvent> | null;
  isLoading: boolean;
  error: Error | null;
}

function titleCaseThreadKind(kind: MessengerThreadKind): string {
  switch (kind) {
    case "chat":
      return "Chat";
    case "issues":
      return "Issues";
    case "approvals":
      return "Approvals";
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

export function resolveMessengerRoute(pathname: string): MessengerRouteState {
  if (!/^\/messenger(?:\/|$)/.test(pathname)) return { kind: "root" };
  if (/^\/messenger\/chat\/[^/]+(?:\/|$)/.test(pathname)) {
    const match = pathname.match(/^\/messenger\/chat\/([^/]+)(?:\/|$)/);
    return { kind: "chat", conversationId: match?.[1] };
  }
  if (/^\/messenger\/chat(?:\/|$)/.test(pathname)) return { kind: "chat" };
  if (/^\/messenger\/issues(?:\/|$)/.test(pathname)) return { kind: "issues" };
  if (/^\/messenger\/approvals(?:\/|$)/.test(pathname)) return { kind: "approvals" };
  const systemMatch = pathname.match(/^\/messenger\/system\/([^/]+)(?:\/|$)/);
  if (systemMatch) {
    const threadKind = systemMatch[1];
    if (
      threadKind === "failed-runs" ||
      threadKind === "budget-alerts" ||
      threadKind === "join-requests"
    ) {
      return { kind: "system", threadKind };
    }
  }
  return { kind: "root" };
}

export function messengerThreadKindLabel(kind: MessengerThreadKind): string {
  return titleCaseThreadKind(kind);
}

export function useMessengerModel() {
  const location = useLocation();
  const { selectedOrganizationId } = useOrganization();
  const route = resolveMessengerRoute(toOrganizationRelativePath(location.pathname));

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const threadsQuery = useQuery({
    queryKey: queryKeys.messenger.threads(selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.listThreads(selectedOrganizationId!),
    enabled: !!selectedOrganizationId,
  });

  const issuesThreadQuery = useQuery({
    queryKey: queryKeys.messenger.issues(selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.getIssuesThread(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && route.kind === "issues",
  });

  const approvalsThreadQuery = useQuery({
    queryKey: queryKeys.messenger.approvals(selectedOrganizationId ?? "__none__"),
    queryFn: () => messengerApi.getApprovalsThread(selectedOrganizationId!),
    enabled: !!selectedOrganizationId && route.kind === "approvals",
  });

  const activeSystemThreadKind = route.kind === "system" ? route.threadKind : "__none__";
  const systemThreadQuery = useQuery({
    queryKey: queryKeys.messenger.system(selectedOrganizationId ?? "__none__", activeSystemThreadKind),
    queryFn: () => messengerApi.getSystemThread(selectedOrganizationId!, activeSystemThreadKind as MessengerSystemThreadKind),
    enabled: !!selectedOrganizationId && route.kind === "system",
  });

  const error = useMemo(() => {
    if (threadsQuery.error instanceof Error) return threadsQuery.error;
    if (issuesThreadQuery.error instanceof Error) return issuesThreadQuery.error;
    if (approvalsThreadQuery.error instanceof Error) return approvalsThreadQuery.error;
    if (systemThreadQuery.error instanceof Error) return systemThreadQuery.error;
    return null;
  }, [approvalsThreadQuery.error, issuesThreadQuery.error, systemThreadQuery.error, threadsQuery.error]);

  return {
    currentUserId,
    selectedOrganizationId,
    threadSummaries: threadsQuery.data ?? [],
    issueThreadDetail: issuesThreadQuery.data?.detail ?? null,
    approvalThreadDetail: approvalsThreadQuery.data?.detail ?? null,
    systemThreadDetail: systemThreadQuery.data?.detail ?? null,
    isLoading:
      threadsQuery.isLoading ||
      issuesThreadQuery.isLoading ||
      approvalsThreadQuery.isLoading ||
      systemThreadQuery.isLoading,
    error,
  } satisfies MessengerModel;
}
