import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import type {
  AgentRunTranscriptNavigation,
  AgentRunTranscriptState,
} from "./useAgentRunTranscripts";

export function TranscriptContinuationControls({
  navigation,
  state,
  className,
  isLive = false,
  showAvailabilityDetails = false,
}: {
  navigation?: AgentRunTranscriptNavigation | null;
  state?: AgentRunTranscriptState | null;
  className?: string;
  isLive?: boolean;
  showAvailabilityDetails?: boolean;
}) {
  const availabilityMessage = (() => {
    switch (state?.availability) {
      case "missing": return isLive ? null : "No transcript source is available for this run.";
      case "offline": return "The transcript source is offline.";
      case "expired": return "The transcript source has expired.";
      case "incompatible": return "The transcript source is incompatible with this reader.";
      default: return null;
    }
  })();
  const unavailable = state?.availability
    && state.availability !== "available"
    && state.availability !== "pending";
  const errorText = state?.error
    ? showAvailabilityDetails
      ? `Transcript read failed: ${state.error.message}`
      : `Transcript unavailable: ${state.error.message}`
    : unavailable
      ? showAvailabilityDetails
        ? availabilityMessage
        : `Transcript ${state.availability}.`
      : null;
  const partial = state?.completeness === "partial" || navigation?.hasMore === true;
  const completenessText = showAvailabilityDetails
    ? partial
      ? "Partial transcript"
      : state?.completeness === "terminal_only"
        ? "Only the terminal result is available."
        : state?.completeness === "unknown" && !(isLive && state?.availability === "missing")
          ? "Transcript completeness is unknown."
          : null
    : null;
  const hasNavigation = Boolean(
    navigation && (
      navigation.canPrevious
      || navigation.canNext
      || navigation.pageNumber > 1
      || navigation.historyTruncated
    ),
  );
  if (!errorText && !partial && !completenessText && !hasNavigation && !navigation?.onReset) return null;

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
        {errorText ? <span>{errorText}</span> : null}
        {showAvailabilityDetails && completenessText ? <span>{completenessText}</span> : null}
        {!errorText && !completenessText && (partial || hasNavigation) ? (
          <span>{partial ? "Partial transcript" : "Transcript continuation"}</span>
        ) : null}
        {navigation && (hasNavigation || partial) ? (
          <span className="text-muted-foreground/80">Page {navigation.pageNumber}</span>
        ) : null}
        {navigation?.historyTruncated ? (
          <span className="text-muted-foreground/80">Earlier pages are outside this window.</span>
        ) : null}
      </div>
      {navigation && (navigation.canPrevious || navigation.canNext || navigation.onReset) ? (
        <div className="flex shrink-0 items-center gap-1.5">
          {navigation.onReset ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Refresh transcript"
              title="Read the transcript again from the first page"
              disabled={navigation.resetting}
              onClick={navigation.onReset}
            >
              {navigation.resetting ? <Loader2 className="h-3.5 w-3.5" aria-hidden /> : <RefreshCw className="h-3.5 w-3.5" aria-hidden />}
              Refresh
            </Button>
          ) : null}
          {navigation.canPrevious || navigation.canNext ? (
            <>
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
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
