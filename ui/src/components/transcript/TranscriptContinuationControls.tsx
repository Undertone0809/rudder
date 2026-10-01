import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type {
  AgentRunTranscriptNavigation,
  AgentRunTranscriptState,
} from "./useAgentRunTranscripts";

export function TranscriptContinuationControls({
  navigation,
  state,
  className,
  emptyStateOwnedByTranscript = false,
}: {
  navigation?: AgentRunTranscriptNavigation | null;
  state?: AgentRunTranscriptState | null;
  className?: string;
  emptyStateOwnedByTranscript?: boolean;
}) {
  const errorText = emptyStateOwnedByTranscript ? null : state?.error
    ? `Transcript unavailable: ${state.error.message}`
    : state?.availability && state.availability !== "available" && state.availability !== "pending"
      ? `Transcript ${state.availability}.`
      : null;
  const partial = state?.completeness === "partial" || navigation?.hasMore === true;
  const hasNavigation = Boolean(
    navigation && (
      navigation.canPrevious
      || navigation.canNext
      || navigation.pageNumber > 1
      || navigation.historyTruncated
    ),
  );
  if (!errorText && !partial && !hasNavigation) return null;

  const isLoading = Boolean(state?.loading);
  return (
    <div
      data-testid="transcript-continuation"
      className={cn(
        "flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2 text-xs",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground",
          errorText && "text-destructive",
        )}
        role={errorText ? "alert" : "status"}
        aria-live="polite"
      >
        {isLoading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden /> : null}
        <span>{errorText ?? (partial ? "Partial transcript" : "Transcript continuation")}</span>
        {navigation && (hasNavigation || partial) ? (
          <span className="text-muted-foreground/80">Page {navigation.pageNumber}</span>
        ) : null}
        {navigation?.historyTruncated ? (
          <span className="text-muted-foreground/80">Earlier pages are outside this window.</span>
        ) : null}
      </div>
      {navigation && (navigation.canPrevious || navigation.canNext) ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Previous transcript page"
            disabled={isLoading || !navigation.canPrevious}
            onClick={navigation.onPrevious}
          >
            <ChevronLeft aria-hidden />
            Previous
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-label="Next transcript page"
            disabled={isLoading || !navigation.canNext}
            onClick={navigation.onNext}
          >
            Next
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
