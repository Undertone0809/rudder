import type { Issue } from "@rudderhq/shared";

export const issueStatusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
export const issuePriorityOrder = ["critical", "high", "medium", "low"];

export type IssueSortField = "manual" | "status" | "priority" | "title" | "created" | "updated";
export type IssueSortDir = "asc" | "desc";

export type IssueSortState = {
  sortField: IssueSortField;
  sortDir: IssueSortDir;
};

export const issueSortOptions: Array<{ value: IssueSortField; label: string }> = [
  { value: "manual", label: "Manual" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "created", label: "Created" },
  { value: "updated", label: "Updated" },
];

function orderedIndex(order: string[], value: string): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  return new Date(value).getTime();
}

function compareIssueField(a: Issue, b: Issue, field: IssueSortField): number {
  switch (field) {
    case "manual":
      return (a.boardOrder ?? 0) - (b.boardOrder ?? 0);
    case "status":
      return orderedIndex(issueStatusOrder, a.status) - orderedIndex(issueStatusOrder, b.status);
    case "priority":
      return orderedIndex(issuePriorityOrder, a.priority) - orderedIndex(issuePriorityOrder, b.priority);
    case "title":
      return a.title.localeCompare(b.title);
    case "created":
      return timestamp(a.createdAt) - timestamp(b.createdAt);
    case "updated":
      return timestamp(a.updatedAt) - timestamp(b.updatedAt);
  }
}

export function sortIssues(issues: Issue[], state: IssueSortState): Issue[] {
  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...issues].sort((a, b) => {
    const primary = compareIssueField(a, b, state.sortField);
    if (primary !== 0) return dir * primary;

    const updated = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (updated !== 0) return updated;

    const created = timestamp(b.createdAt) - timestamp(a.createdAt);
    if (created !== 0) return created;

    return (a.identifier ?? a.id).localeCompare(b.identifier ?? b.id);
  });
}
