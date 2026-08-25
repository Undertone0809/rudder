import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "./ui/button";

type IssueRefreshNoticeProps = {
  error: Error;
  hasData: boolean;
  resourceLabel: "issues" | "issue";
  onRetry: () => void;
  retrying?: boolean;
};

export function IssueRefreshNotice({
  error,
  hasData,
  resourceLabel,
  onRetry,
  retrying = false,
}: IssueRefreshNoticeProps) {
  return (
    <div
      data-testid="issue-refresh-notice"
      role="alert"
      className="flex items-start justify-between gap-3 rounded-[calc(var(--radius-sm)+1px)] border border-destructive/35 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p className="min-w-0">
          <span className="font-medium">
            {hasData ? `Could not refresh ${resourceLabel}.` : `Could not load ${resourceLabel}.`}
          </span>{" "}
          {hasData ? `Showing the last loaded ${resourceLabel}.` : "Try again to load the latest state."}
          {error.message ? <span className="sr-only"> {error.message}</span> : null}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 border-destructive/35 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw className={retrying ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} aria-hidden="true" />
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}
