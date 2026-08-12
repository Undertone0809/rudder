import { authApi } from "@/api/auth";
import { messengerApi } from "@/api/messenger";
import { useOrganization } from "@/context/OrganizationContext";
import { toOrganizationRelativePath } from "@/lib/organization-routes";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation } from "@/lib/router";
import type {
  MessengerIssueThreadItem,
  MessengerRequestThreadItem,
  MessengerSystemThreadItem,
  MessengerSystemThreadKind,
  MessengerThreadDetail,
  MessengerThreadSummary,
} from "@rudderhq/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
export { messengerThreadKindLabel } from "@/lib/messenger-thread-labels";

export type MessengerRouteState =
  | { kind: "root" }
  | { kind: "workbench" }
  | { kind: "chat"; conversationId?: string }
  | { kind: "issues" }
  | { kind: "issue"; issueId: string }
  | { kind: "saved_view"; savedViewId: string }
  | { kind: "approvals" }
  | { kind: "system"; threadKind: MessengerSystemThreadKind };

export interface MessengerModel {
  currentUserId: string | null;
  selectedOrganizationId: string | null;
  threadSummaries: MessengerThreadSummary[];
  hasMoreThreadSummaries: boolean;
  isFetchingMoreThreadSummaries: boolean;
  loadMoreThreadSummaries: () => Promise<unknown>;
  issueThreadDetail: MessengerThreadDetail<MessengerIssueThreadItem> | null;
  approvalThreadDetail: MessengerThreadDetail<MessengerRequestThreadItem> | null;
  systemThreadDetail: MessengerThreadDetail<MessengerSystemThreadItem> | null;
  isLoading: boolean;
  error: Error | null;
}

type MessengerQueryLoadState = {
  data: unknown;
  error: unknown;
  isLoading: boolean;
};

export function resolveMessengerLoadState(
  route: MessengerRouteState,
  queries: {
    threads: MessengerQueryLoadState;
    issues: MessengerQueryLoadState;
    approvals: MessengerQueryLoadState;
    system: MessengerQueryLoadState;
  },
): Pick<MessengerModel, "isLoading" | "error"> {
  const activeQuery = route.kind === "root"
    ? queries.threads
    : route.kind === "issues"
      ? queries.issues
      : route.kind === "approvals"
        ? queries.approvals
        : route.kind === "system"
          ? queries.system
          : null;

  if (!activeQuery) return { isLoading: false, error: null };
  return {
    isLoading: activeQuery.isLoading && activeQuery.data === undefined,
    error: activeQuery.data === undefined && activeQuery.error instanceof Error
      ? activeQuery.error
      : null,
  };
}

const MESSENGER_THREAD_PAGE_SIZE = 40;

export function resolveMessengerRoute(pathname: string): MessengerRouteState {
  if (!/^\/messenger(?:\/|$)/.test(pathname)) return { kind: "root" };
  if (/^\/messenger\/workbench(?:\/|$)/.test(pathname)) return { kind: "workbench" };
  if (/^\/messenger\/chat\/[^/]+(?:\/|$)/.test(pathname)) {
    const match = pathname.match(/^\/messenger\/chat\/([^/]+)(?:\/|$)/);
    return { kind: "chat", conversationId: match?.[1] };
  }
  if (/^\/messenger\/chat(?:\/|$)/.test(pathname)) return { kind: "chat" };
  if (/^\/messenger\/saved\/[^/]+(?:\/|$)/.test(pathname)) {
    const match = pathname.match(/^\/messenger\/saved\/([^/]+)(?:\/|$)/);
    return { kind: "saved_view", savedViewId: match?.[1] ?? "" };
  }
  if (/^\/messenger\/issues\/[^/]+(?:\/|$)/.test(pathname)) {
    const match = pathname.match(/^\/messenger\/issues\/([^/]+)(?:\/|$)/);
    return { kind: "issue", issueId: match?.[1] ?? "" };
  }
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

export function useMessengerModel(options: { splitIssues?: boolean } = {}) {
  const location = useLocation();
  const { selectedOrganizationId } = useOrganization();
  const route = resolveMessengerRoute(toOrganizationRelativePath(location.pathname));

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  const threadsQuery = useInfiniteQuery({
    queryKey: queryKeys.messenger.threadPages(selectedOrganizationId ?? "__none__", Boolean(options.splitIssues)),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => messengerApi.listThreadPage(selectedOrganizationId!, {
      cursor: pageParam,
      limit: MESSENGER_THREAD_PAGE_SIZE,
      splitIssues: options.splitIssues,
    }),
    getNextPageParam: (lastPage) => lastPage.pageInfo.hasMore ? lastPage.pageInfo.nextCursor : undefined,
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

  const loadState = resolveMessengerLoadState(route, {
    threads: threadsQuery,
    issues: issuesThreadQuery,
    approvals: approvalsThreadQuery,
    system: systemThreadQuery,
  });
  const threadSummaries = useMemo(
    () => threadsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [threadsQuery.data?.pages],
  );

  return {
    currentUserId,
    selectedOrganizationId,
    threadSummaries,
    hasMoreThreadSummaries: Boolean(threadsQuery.hasNextPage),
    isFetchingMoreThreadSummaries: threadsQuery.isFetchingNextPage,
    loadMoreThreadSummaries: () => threadsQuery.fetchNextPage(),
    issueThreadDetail: issuesThreadQuery.data?.detail ?? null,
    approvalThreadDetail: approvalsThreadQuery.data?.detail ?? null,
    systemThreadDetail: systemThreadQuery.data?.detail ?? null,
    ...loadState,
  } satisfies MessengerModel;
}
