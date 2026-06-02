import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { ApiError } from "../api/client";
import { approvalsApi } from "../api/approvals";
import { messengerApi } from "../api/messenger";
import { dashboardApi } from "../api/dashboard";
import { HEARTBEAT_RUN_LIST_DEFAULT_LIMIT, heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { sidebarBadgesApi } from "../api/sidebarBadges";
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
const INBOX_BADGE_THREAD_PREVIEW_LIMIT = 10;

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
  const { data: messengerThreadPreview } = useQuery({
    queryKey: queryKeys.messenger.threadPreview(orgId ?? "__none__"),
    queryFn: () => messengerApi.listThreadPage(orgId!, { limit: INBOX_BADGE_THREAD_PREVIEW_LIMIT }),
    enabled: !!orgId,
  });
  const messengerThreads = messengerThreadPreview?.items ?? [];

  const { data: serverBadges } = useQuery({
    queryKey: queryKeys.sidebarBadges(orgId ?? "__none__"),
    queryFn: () => sidebarBadgesApi.get(orgId!),
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
    queryKey: queryKeys.heartbeats(orgId!, undefined, HEARTBEAT_RUN_LIST_DEFAULT_LIMIT),
    queryFn: () => heartbeatsApi.list(orgId!, undefined, HEARTBEAT_RUN_LIST_DEFAULT_LIMIT),
    enabled: !!orgId,
  });

  const legacyBadge = useMemo(
    () =>
      computeInboxBadgeData({
        approvals,
        joinRequests,
        dashboard,
        heartbeatRuns,
        unreadIssues,
        attentionChats: [],
        dismissed,
      }),
    [approvals, joinRequests, dashboard, heartbeatRuns, unreadIssues, dismissed],
  );

  return useMemo(() => {
    const badgeCounts = serverBadges ?? legacyBadge;

    return {
      ...badgeCounts,
      notificationContent: getInboxNotificationContent({
        unreadCount: badgeCounts.inbox,
        messengerThreads,
      }),
    };
  }, [legacyBadge, messengerThreads, serverBadges]);
}
