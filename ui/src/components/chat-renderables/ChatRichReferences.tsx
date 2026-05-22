import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, FileText, MessageSquareText } from "lucide-react";
import type { ChatMessage, ChatRichReference, Issue, IssueComment } from "@rudderhq/shared";
import { chatRichReferencesFromStructuredPayload } from "@rudderhq/shared";
import { issuesApi } from "@/api/issues";
import { ApiError } from "@/api/client";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { formatPriorityLabel } from "@/lib/priorities";
import { formatAssigneeUserLabel } from "@/lib/assignees";
import { StatusBadge } from "@/components/StatusBadge";
import { cn, relativeTime } from "@/lib/utils";

type CardReference = ChatRichReference & { display: "card" };

export function ChatRichReferences({ message }: { message: ChatMessage }) {
  const references = useMemo(
    () => chatRichReferencesFromStructuredPayload(message.structuredPayload)
      .filter((reference): reference is CardReference => reference.display === "card"),
    [message.structuredPayload],
  );

  if (references.length === 0) return null;

  return (
    <div className="mt-3 flex max-w-[72ch] flex-col gap-2" data-testid="chat-rich-references">
      {references.map((reference, index) => (
        <ChatRichReferenceCard
          key={`${reference.type}:${reference.issueId ?? reference.identifier ?? "issue"}:${reference.type === "issue_comment" ? reference.commentId : index}`}
          reference={reference}
        />
      ))}
    </div>
  );
}

function ChatRichReferenceCard({ reference }: { reference: CardReference }) {
  if (reference.type === "issue") {
    return <IssueReferenceCard reference={reference} />;
  }
  return <IssueCommentReferenceCard reference={reference} />;
}

function IssueReferenceCard({ reference }: { reference: Extract<CardReference, { type: "issue" }> }) {
  const issueRef = issueReferenceKey(reference);
  const query = useQuery({
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: () => issuesApi.get(issueRef),
    retry: false,
    enabled: Boolean(issueRef),
  });

  if (query.isLoading) {
    return <ReferenceFallbackCard icon="issue" title="Loading issue" detail={issueRef} tone="loading" />;
  }
  if (query.isError) {
    return <ReferenceErrorCard error={query.error} kind="issue" />;
  }
  if (!query.data) {
    return <ReferenceFallbackCard icon="issue" title="Issue unavailable" detail="The issue could not be loaded." tone="muted" />;
  }

  return <IssueCard issue={query.data} />;
}

function IssueCommentReferenceCard({ reference }: { reference: Extract<CardReference, { type: "issue_comment" }> }) {
  const issueRef = issueReferenceKey(reference);
  const issueQuery = useQuery({
    queryKey: queryKeys.issues.detail(issueRef),
    queryFn: () => issuesApi.get(issueRef),
    retry: false,
    enabled: Boolean(issueRef),
  });
  const commentQuery = useQuery({
    queryKey: queryKeys.issues.comment(issueRef, reference.commentId),
    queryFn: () => issuesApi.getComment(issueRef, reference.commentId),
    retry: false,
    enabled: Boolean(issueRef),
  });

  if (issueQuery.isLoading || commentQuery.isLoading) {
    return <ReferenceFallbackCard icon="comment" title="Loading comment" detail={issueRef} tone="loading" />;
  }
  if (issueQuery.isError) {
    return <ReferenceErrorCard error={issueQuery.error} kind="issue" />;
  }
  if (commentQuery.isError) {
    return <ReferenceErrorCard error={commentQuery.error} kind="comment" />;
  }
  if (!issueQuery.data || !commentQuery.data) {
    return <ReferenceFallbackCard icon="comment" title="Comment unavailable" detail="The comment could not be loaded." tone="muted" />;
  }

  return <IssueCommentCard issue={issueQuery.data} comment={commentQuery.data} />;
}

function IssueCard({ issue }: { issue: Issue }) {
  const issueLabel = issue.identifier ?? issue.id.slice(0, 8);
  const assigneeLabel = issue.assigneeAgentId
    ? issue.assigneeAgentId.slice(0, 8)
    : issue.assigneeUserId
      ? (formatAssigneeUserLabel(issue.assigneeUserId, null) ?? issue.assigneeUserId.slice(0, 8))
      : "Unassigned";

  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}`}
      className="group block rounded-lg border border-border bg-card px-3 py-2.5 text-left shadow-[var(--shadow-sm)] transition-colors hover:border-[color:var(--accent-strong)]/40 hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open issue ${issueLabel}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          <FileText className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-[11px] font-medium text-foreground">{issueLabel}</span>
            <StatusBadge status={issue.status} />
            <span>{formatPriorityLabel(issue.priority)}</span>
          </div>
          <div className="mt-1 truncate text-sm font-medium leading-5 text-foreground">
            {issue.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{assigneeLabel}</span>
            <span>Updated {relativeTime(issue.updatedAt)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function IssueCommentCard({ issue, comment }: { issue: Issue; comment: IssueComment }) {
  const issueLabel = issue.identifier ?? issue.id.slice(0, 8);
  const author = comment.authorAgentId
    ? comment.authorAgentId.slice(0, 8)
    : comment.authorUserId
      ? (formatAssigneeUserLabel(comment.authorUserId, null) ?? comment.authorUserId.slice(0, 8))
      : "System";
  const preview = markdownPreview(comment.body);

  return (
    <Link
      to={`/issues/${issue.identifier ?? issue.id}#comment-${comment.id}`}
      className="group block rounded-lg border border-border bg-card px-3 py-2.5 text-left shadow-[var(--shadow-sm)] transition-colors hover:border-[color:var(--accent-strong)]/40 hover:bg-[color:var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`Open comment on issue ${issueLabel}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          <MessageSquareText className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-[11px] font-medium text-foreground">{issueLabel}</span>
            <span>{author}</span>
            <span>{relativeTime(comment.createdAt)}</span>
          </div>
          <div className="mt-1 truncate text-sm font-medium leading-5 text-foreground">
            {issue.title}
          </div>
          <p className="mt-1 max-h-[3.75rem] overflow-hidden text-sm leading-5 text-muted-foreground">
            {preview}
          </p>
        </div>
      </div>
    </Link>
  );
}

function ReferenceErrorCard({ error, kind }: { error: unknown; kind: "issue" | "comment" }) {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return <ReferenceFallbackCard icon={kind} title="Permission denied" detail="You do not have access to this reference." tone="warning" />;
    }
    if (error.status === 404) {
      return <ReferenceFallbackCard icon={kind} title={kind === "issue" ? "Issue not found" : "Comment not found"} detail="The reference may have been deleted or moved." tone="muted" />;
    }
  }
  return <ReferenceFallbackCard icon={kind} title="Reference unavailable" detail="The reference could not be loaded." tone="warning" />;
}

function ReferenceFallbackCard({
  icon,
  title,
  detail,
  tone,
}: {
  icon: "issue" | "comment";
  title: string;
  detail: string;
  tone: "loading" | "muted" | "warning";
}) {
  const Icon = icon === "issue" ? FileText : AlertCircle;

  return (
    <div
      className={cn(
        "rounded-lg border border-dashed px-3 py-2.5 text-sm",
        tone === "warning"
          ? "border-amber-500/35 bg-amber-500/5 text-amber-800 dark:text-amber-200"
          : "border-border bg-card text-muted-foreground",
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-current/15 bg-background/70">
          <Icon className="h-4 w-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="font-medium text-foreground">{title}</div>
          <div className="mt-0.5 break-words text-xs">{detail}</div>
        </div>
      </div>
    </div>
  );
}

function issueReferenceKey(reference: Pick<ChatRichReference, "issueId" | "identifier">) {
  return reference.issueId ?? reference.identifier ?? "";
}

export function markdownPreview(value: string) {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~-]+/g, "")
    .replace(/\s+/g, " ")
    .trim() || "No comment body.";
}
