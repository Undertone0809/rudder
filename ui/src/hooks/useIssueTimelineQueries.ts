import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activityApi } from "../api/activity";
import { agentRunsApi } from "../api/agent-runs";
import { issuesApi } from "../api/issues";
import { ISSUE_REFRESH_QUERY_OPTIONS } from "../lib/issue-refresh";
import { queryKeys } from "../lib/queryKeys";
import {
  resolveIssueTimelineInitialSettlement,
  type IssueTimelineInitialSettlement,
} from "./issue-timeline-readiness";

export function linkedIssueRunsRefetchInterval(hasLiveRuns: boolean) {
  return hasLiveRuns ? 5000 : false;
}

export function useIssueTimelineQueries(issueId: string | undefined, issueFindOpen: boolean) {
  const queryClient = useQueryClient();
  const [visibilityRevision, setVisibilityRevision] = useState(0);
  const disclosureKey = issueId ?? "issue";
  const [initialSettlement, setInitialSettlement] = useState<IssueTimelineInitialSettlement>({
    key: disclosureKey,
    status: "pending",
  });
  const commentsQuery = useQuery({
    queryKey: queryKeys.issues.comments(issueId!),
    queryFn: () => issuesApi.listComments(issueId!),
    enabled: !!issueId,
    ...ISSUE_REFRESH_QUERY_OPTIONS,
  });
  const activityQuery = useQuery({
    queryKey: queryKeys.issues.activity(issueId!),
    queryFn: () => activityApi.forIssue(issueId!),
    enabled: !!issueId,
    ...ISSUE_REFRESH_QUERY_OPTIONS,
  });
  const liveRunsQuery = useQuery({
    queryKey: queryKeys.issues.liveRuns(issueId!),
    queryFn: () => agentRunsApi.liveRunsForIssue(issueId!),
    enabled: !!issueId,
    ...ISSUE_REFRESH_QUERY_OPTIONS,
    refetchInterval: 3000,
  });
  const activeRunQuery = useQuery({
    queryKey: queryKeys.issues.activeRun(issueId!),
    queryFn: () => agentRunsApi.activeRunForIssue(issueId!),
    enabled: !!issueId,
    ...ISSUE_REFRESH_QUERY_OPTIONS,
    refetchInterval: 3000,
  });
  const hasLiveRuns = (liveRunsQuery.data ?? []).length > 0 || !!activeRunQuery.data;
  const linkedRunsQuery = useQuery({
    queryKey: queryKeys.issues.runs(issueId!),
    queryFn: () => activityApi.runsForIssue(issueId!),
    enabled: !!issueId,
    ...ISSUE_REFRESH_QUERY_OPTIONS,
    refetchInterval: linkedIssueRunsRefetchInterval(hasLiveRuns),
  });
  const hadLiveRunsRef = useRef(false);
  useEffect(() => {
    if (hadLiveRunsRef.current && !hasLiveRuns && issueId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    }
    hadLiveRunsRef.current = hasLiveRuns;
  }, [hasLiveRuns, issueId, queryClient]);

  const queries = [commentsQuery, activityQuery, linkedRunsQuery, liveRunsQuery, activeRunQuery];
  const allSuccessful = queries.every((query) => query.isSuccess);
  const hasError = queries.some((query) => query.isError);
  const retrying = queries.some((query) => query.isError && query.isFetching);
  const currentInitialStatus = initialSettlement.key === disclosureKey
    ? initialSettlement.status
    : "pending";
  const effectiveInitialStatus = currentInitialStatus === "pending"
    ? hasError ? "failed" : allSuccessful ? "ready" : "pending"
    : currentInitialStatus;
  useEffect(() => {
    setInitialSettlement((current) => resolveIssueTimelineInitialSettlement(
      current,
      disclosureKey,
      { allSuccessful, hasError },
    ));
  }, [allSuccessful, disclosureKey, hasError]);
  const retryFailed = useCallback(async () => {
    const failed = [commentsQuery, activityQuery, linkedRunsQuery, liveRunsQuery, activeRunQuery]
      .filter((query) => query.isError);
    await Promise.all(failed.map((query) => query.refetch()));
  }, [activeRunQuery, activityQuery, commentsQuery, linkedRunsQuery, liveRunsQuery]);
  const onVisibilityChange = useCallback(() => {
    setVisibilityRevision((revision) => revision + 1);
  }, []);
  const progressiveDisclosure = useMemo(() => ({
    key: disclosureKey,
    ready: effectiveInitialStatus === "ready",
    failOpen: effectiveInitialStatus === "failed",
    forceExpanded: issueFindOpen,
    mountAll: issueFindOpen,
    onVisibilityChange,
  }), [disclosureKey, effectiveInitialStatus, issueFindOpen, onVisibilityChange]);

  return {
    activeRun: activeRunQuery.data,
    activity: activityQuery.data,
    comments: commentsQuery.data,
    hasError,
    hasLiveRuns,
    linkedRuns: linkedRunsQuery.data,
    liveRuns: liveRunsQuery.data,
    progressiveDisclosure,
    retryFailed,
    retrying,
    visibilityRevision,
  };
}
