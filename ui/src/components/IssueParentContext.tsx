import { Link } from "@/lib/router";
import { issueUrl } from "@/lib/utils";
import type { Issue } from "@rudderhq/shared";
import { ListTree } from "lucide-react";
import { StatusIcon } from "./StatusIcon";

type IssueParentContextIssue = NonNullable<NonNullable<Issue["ancestors"]>[number]>;

type IssueParentContextProps = {
  parentIssue: IssueParentContextIssue | null | undefined;
};

function issueRef(issue: Pick<IssueParentContextIssue, "id" | "identifier">) {
  return issue.identifier ?? issue.id.slice(0, 8);
}

export function IssueParentContext({ parentIssue }: IssueParentContextProps) {
  if (!parentIssue) return null;

  const parentRef = issueRef(parentIssue);

  return (
    <div
      aria-label="Parent issue context"
      className="flex min-w-0 items-center gap-2 text-sm leading-5 text-muted-foreground"
    >
      <span className="shrink-0">Sub-issue of</span>
      <Link
        to={issueUrl(parentIssue)}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-foreground transition-colors hover:bg-accent/50"
      >
        <StatusIcon status={parentIssue.status} className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-28 shrink truncate font-mono text-xs text-muted-foreground">{parentRef}</span>
        <span className="min-w-0 truncate">{parentIssue.title}</span>
      </Link>
      <ListTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
    </div>
  );
}
