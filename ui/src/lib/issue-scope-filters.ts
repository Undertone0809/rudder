import type { Issue } from "@rudderhq/shared";

type IssueScope = string;

type IssueScopeFilters = {
  assigneeUserId?: string;
  followedByUserId?: string;
  includeAutomationExecutions?: boolean;
  involvedUserId?: string;
  reviewerUserId?: string;
};

export function getIssueScopeFilters(issueScope: IssueScope, currentUserId: string | null): IssueScopeFilters {
  if (issueScope === "assigned" && currentUserId) {
    return { assigneeUserId: "me", includeAutomationExecutions: true };
  }
  if (issueScope === "reviewing" && currentUserId) {
    return { reviewerUserId: "me", includeAutomationExecutions: true };
  }
  if (issueScope === "pinned" && currentUserId) {
    return { followedByUserId: "me", includeAutomationExecutions: true };
  }
  if (issueScope === "following" && currentUserId) {
    return { involvedUserId: "me", includeAutomationExecutions: true };
  }

  return { includeAutomationExecutions: true };
}

export function isFollowingIssue(issue: Pick<Issue, "createdByUserId" | "assigneeUserId" | "reviewerUserId">, currentUserId: string | null): boolean {
  if (!currentUserId) return false;
  return issue.createdByUserId === currentUserId || issue.assigneeUserId === currentUserId || issue.reviewerUserId === currentUserId;
}
