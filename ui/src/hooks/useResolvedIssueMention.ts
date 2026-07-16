import { issuesApi } from "@/api/issues";
import type { ParsedMentionChip } from "@/lib/mention-chips";
import { queryKeys } from "@/lib/queryKeys";
import type { Issue } from "@rudderhq/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

type IssueMention = Extract<ParsedMentionChip, { kind: "issue" }>;

export function useResolvedIssueMention(mention: IssueMention): IssueMention {
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(mention.issueId),
    queryFn: () => issuesApi.get(mention.issueId),
    enabled: !mention.status,
    retry: false,
  });

  return {
    ...mention,
    ref: mention.ref ?? issueQuery.data?.identifier ?? null,
    status: mention.status ?? issueQuery.data?.status ?? null,
  };
}

export function useResolvedIssueMentions(mentions: IssueMention[]): IssueMention[] {
  const unresolvedIssueIds = useMemo(
    () => Array.from(new Set(
      mentions
        .filter((mention) => !mention.status)
        .map((mention) => mention.issueId),
    )),
    [mentions],
  );
  const combineIssueResults = useCallback(
    (results: Array<{ data?: Issue }>) => results.flatMap((result) => result.data ? [result.data] : []),
    [],
  );
  const resolvedIssues = useQueries({
    queries: unresolvedIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      retry: false,
    })),
    combine: combineIssueResults,
  });

  return useMemo(() => {
    const resolvedById = new Map<string, Issue>();
    for (const issue of resolvedIssues) {
      resolvedById.set(issue.id.toLowerCase(), issue);
      if (issue.identifier) resolvedById.set(issue.identifier.toLowerCase(), issue);
    }
    return mentions.map((mention) => {
      const issue = resolvedById.get(mention.issueId.toLowerCase());
      if (!issue) return mention;
      return {
        ...mention,
        ref: mention.ref ?? issue.identifier ?? null,
        status: mention.status ?? issue.status ?? null,
      };
    });
  }, [mentions, resolvedIssues]);
}
