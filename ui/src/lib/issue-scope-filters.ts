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
