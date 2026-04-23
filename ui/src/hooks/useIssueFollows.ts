import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

export const LEGACY_STARRED_ISSUES_KEY = "rudder:starred-issues";

function readLegacyFollowIds() {
  if (typeof window === "undefined") return [] as string[];
  try {
    const raw = window.localStorage.getItem(LEGACY_STARRED_ISSUES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
  } catch {
    return [];
  }
}

function clearLegacyFollowIds() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(LEGACY_STARRED_ISSUES_KEY);
  } catch {
    // Ignore storage failures.
  }
}

export function useIssueFollows(orgId: string | null) {
  const queryClient = useQueryClient();
  const migratedRef = useRef<string | null>(null);
  const migratingRef = useRef<string | null>(null);

  const followsQuery = useQuery({
    queryKey: queryKeys.issues.follows(orgId ?? "__none__"),
    queryFn: () => issuesApi.listFollows(orgId!),
    enabled: !!orgId,
  });

  const followedIssueIds = useMemo(
    () => new Set((followsQuery.data ?? []).map((entry) => entry.issueId)),
    [followsQuery.data],
  );

  useEffect(() => {
    if (!orgId) return;
    if (!followsQuery.isSuccess) return;
    if (migratedRef.current === orgId || migratingRef.current === orgId) return;

    const legacyIds = readLegacyFollowIds();
    if (legacyIds.length === 0) {
      migratedRef.current = orgId;
      return;
    }

    const missingIds = legacyIds.filter((issueId) => !followedIssueIds.has(issueId));
    if (missingIds.length === 0) {
      clearLegacyFollowIds();
      migratedRef.current = orgId;
      return;
    }

    migratingRef.current = orgId;
    void Promise.allSettled(missingIds.map((issueId) => issuesApi.follow(issueId))).then(async (results) => {
      migratingRef.current = null;
      const migrationFailed = results.some((result) => result.status === "rejected");
      if (migrationFailed) return;

      clearLegacyFollowIds();
      migratedRef.current = orgId;
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.follows(orgId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) });
      await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) });
    });
  }, [followedIssueIds, followsQuery.isSuccess, orgId, queryClient]);

  const toggleFollowIssue = useCallback(async (issueId: string) => {
    if (!orgId) return;
    if (followedIssueIds.has(issueId)) {
      await issuesApi.unfollow(issueId);
    } else {
      await issuesApi.follow(issueId);
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.follows(orgId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(orgId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.threads(orgId) });
    await queryClient.invalidateQueries({ queryKey: queryKeys.messenger.issues(orgId) });
  }, [followedIssueIds, orgId, queryClient]);

  return {
    follows: followsQuery.data ?? [],
    followedIssueIds,
    isLoading: followsQuery.isLoading,
    error: followsQuery.error instanceof Error ? followsQuery.error : null,
    toggleFollowIssue,
  };
}
