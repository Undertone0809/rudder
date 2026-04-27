import type { Issue } from "@rudderhq/shared";

type IssueScope = string;

type IssueScopeFilters = {
  assigneeUserId?: string;
};

export function getIssueScopeFilters(issueScope: IssueScope, currentUserId: string | null): IssueScopeFilters {
  if (issueScope === "assigned" && currentUserId) {
    return { assigneeUserId: "me" };
  }

  return {};
}

export function isFollowingIssue(issue: Pick<Issue, "createdByUserId" | "assigneeUserId">, currentUserId: string | null): boolean {
  if (!currentUserId) return false;
  return issue.createdByUserId === currentUserId || issue.assigneeUserId === currentUserId;
}
