import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { messengerApi } from "../api/messenger";
import { dashboardApi } from "../api/dashboard";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { chatsApi } from "../api/chats";
import { queryKeys } from "../lib/queryKeys";
import {
  computeInboxBadgeData,
  getInboxNotificationContent,
  getRecentTouchedIssues,
  loadDismissedInboxItems,
  saveDismissedInboxItems,
  getUnreadTouchedIssues,
} from "../lib/inbox";

const INBOX_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked,done";

export function useDismissedInboxItems() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "rudder:inbox:dismissed") return;
      setDismissed(loadDismissedInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxItems(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxBadge(orgId: string | null | undefined) {
  const { dismissed } = useDismissedInboxItems();
  const { data: messengerThreads = [] } = useQuery({
    queryKey: queryKeys.messenger.threads(orgId ?? "__none__"),
    queryFn: () => messengerApi.listThreads(orgId!),
    enabled: !!orgId,
  });

  const { data: approvals = [] } = useQuery({
    queryKey: queryKeys.approvals.list(orgId!),
    queryFn: () => approvalsApi.list(orgId!),
    enabled: !!orgId,
  });

  const { data: joinRequests = [] } = useQuery({
    queryKey: queryKeys.access.joinRequests(orgId!),
    queryFn: async () => {
      try {
        return await accessApi.listJoinRequests(orgId!, "pending_approval");
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          return [];
        }
        throw err;
      }
    },
    enabled: !!orgId,
    retry: false,
  });

  const { data: dashboard } = useQuery({
    queryKey: queryKeys.dashboard(orgId!),
    queryFn: () => dashboardApi.summary(orgId!),
    enabled: !!orgId,
  });

  const { data: touchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(orgId!),
    queryFn: () =>
      issuesApi.list(orgId!, {
        touchedByUserId: "me",
        status: INBOX_ISSUE_STATUSES,
      }),
    enabled: !!orgId,
  });

  const unreadIssues = useMemo(
    () => getUnreadTouchedIssues(getRecentTouchedIssues(touchedIssues)),
    [touchedIssues],
  );

  const { data: heartbeatRuns = [] } = useQuery({
    queryKey: queryKeys.heartbeats(orgId!),
    queryFn: () => heartbeatsApi.list(orgId!),
    enabled: !!orgId,
  });

  const { data: chats = [] } = useQuery({
    queryKey: queryKeys.chats.list(orgId ?? "__none__", "active"),
    queryFn: () => chatsApi.list(orgId!, "active"),
    enabled: !!orgId,
  });

  const attentionChats = useMemo(
    () => chats.filter((conversation) => conversation.needsAttention),
    [chats],
  );

  const legacyBadge = useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns,
        unreadIssues,
        attentionChats,
        dismissed,
      }),
    [approvals, joinRequests, dashboard, heartbeatRuns, unreadIssues, attentionChats, dismissed],
  );

  return useMemo(() => {
    if (messengerThreads.length === 0) {
      return {
        ...legacyBadge,
        notificationContent: getInboxNotificationContent({
          unreadCount: legacyBadge.inbox,
          messengerThreads,
        }),
      };
    }

    const threadsByKind = new Map(messengerThreads.map((thread) => [thread.kind, thread]));
    const unreadCount = messengerThreads.reduce((sum, thread) => sum + Math.max(0, thread.unreadCount ?? 0), 0);
    const aggregateAgentErrorAlert =
      (dashboard?.agents.error ?? 0) > 0 &&
      legacyBadge.failedRuns === 0 &&
      !dismissed.has("alert:agent-errors")
        ? 1
        : 0;
    const alertCount = (threadsByKind.get("budget-alerts")?.unreadCount ?? 0) + aggregateAgentErrorAlert;

    const inbox = unreadCount + aggregateAgentErrorAlert;

    return {
      ...legacyBadge,
      inbox,
      approvals: threadsByKind.get("approvals")?.unreadCount ?? 0,
      failedRuns: threadsByKind.get("failed-runs")?.unreadCount ?? 0,
      joinRequests: threadsByKind.get("join-requests")?.unreadCount ?? 0,
      unreadTouchedIssues: threadsByKind.get("issues")?.unreadCount ?? 0,
      chatAttention: messengerThreads
        .filter((thread) => thread.kind === "chat" && thread.needsAttention)
        .reduce((sum, thread) => sum + Math.max(1, thread.unreadCount ?? 0), 0),
      alerts: alertCount,
      notificationContent: getInboxNotificationContent({
        unreadCount: inbox,
        messengerThreads,
      }),
    };
  }, [dashboard?.agents.error, dismissed, legacyBadge, messengerThreads]);
}
