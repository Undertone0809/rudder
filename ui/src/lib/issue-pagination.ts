import type { IssueStatus } from "@rudderhq/shared";

export const ISSUE_BOARD_STATUSES: IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
];

export type IssuePaginationState = {
  hasMore: boolean;
  isLoading: boolean;
  error: Error | null;
  hasLoaded: boolean;
};
