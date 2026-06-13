import type { SidebarBadges } from "@rudderhq/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { messengerApi } from "../api/messenger";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import {
  getInboxNotificationContent,
  loadDismissedInboxItems,
  saveDismissedInboxItems,
} from "../lib/inbox";
import { queryKeys } from "../lib/queryKeys";

const INBOX_BADGE_THREAD_PREVIEW_LIMIT = 10;
const EMPTY_SIDEBAR_BADGES: SidebarBadges = {
  inbox: 0,
  approvals: 0,
  failedRuns: 0,
  joinRequests: 0,
  unreadTouchedIssues: 0,
  chatAttention: 0,
  alerts: 0,
};

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
  const { data: messengerThreadPreview } = useQuery({
    queryKey: queryKeys.messenger.threadPreview(orgId ?? "__none__"),
    queryFn: () => messengerApi.listThreadPage(orgId!, { limit: INBOX_BADGE_THREAD_PREVIEW_LIMIT }),
    enabled: !!orgId,
  });
  const messengerThreads = messengerThreadPreview?.items ?? [];

  const serverBadgesQuery = useQuery({
    queryKey: queryKeys.sidebarBadges(orgId ?? "__none__"),
    queryFn: () => sidebarBadgesApi.get(orgId!),
    enabled: !!orgId,
  });

  return useMemo(() => {
    const badgeCounts = serverBadgesQuery.data ?? EMPTY_SIDEBAR_BADGES;

    return {
      ...badgeCounts,
      isReady: !orgId || serverBadgesQuery.isSuccess,
      notificationContent: getInboxNotificationContent({
        unreadCount: badgeCounts.inbox,
        badgeCounts,
        messengerThreads,
      }),
    };
  }, [messengerThreads, orgId, serverBadgesQuery.data, serverBadgesQuery.isSuccess]);
}
