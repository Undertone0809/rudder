import { Loader2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

export const MANAGED_GROUP_INITIAL_VISIBLE_COUNT = 6;
// A one-row overflow is not enough to justify a disclosure control. Keep
// short groups stable so the auto-loader does not immediately undo Collapse.
export const MANAGED_GROUP_SHORT_LIST_MAX_COUNT = MANAGED_GROUP_INITIAL_VISIBLE_COUNT + 1;
export const MANAGED_GROUP_VISIBLE_INCREMENT = 10;

function MessengerSectionAutoLoader({
  loading,
  onVisible,
  testId,
}: {
  loading: boolean;
  onVisible: () => void;
  testId: string;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || loading || typeof IntersectionObserver === "undefined") return undefined;
    const root = sentinel.closest<HTMLElement>("nav");
    if (!root) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onVisible();
    }, { root, rootMargin: "0px 0px 320px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, onVisible]);

  return (
    <div
      ref={sentinelRef}
      data-testid={testId}
      className="flex min-h-7 items-center px-2 text-[11px] text-muted-foreground"
      aria-live="polite"
    >
      {loading ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Loading
        </span>
      ) : null}
    </div>
  );
}

export function MessengerThreadSectionControls({
  hasHiddenLoadedEntries,
  loading,
  onCollapse,
  onAutoLoad,
  onShowMore,
  sectionLabel,
  showCollapse,
  showMore,
  testId,
}: {
  hasHiddenLoadedEntries: boolean;
  loading: boolean;
  onCollapse: () => void;
  onAutoLoad: () => void;
  onShowMore: () => void;
  sectionLabel?: string | null;
  showCollapse: boolean;
  showMore: boolean;
  testId: string;
}) {
  const pendingFocusRef = useRef<"after-collapse" | "after-show-more" | null>(null);
  const showMoreButtonRef = useRef<HTMLButtonElement | null>(null);
  const collapseButtonRef = useRef<HTMLButtonElement | null>(null);
  const subject = sectionLabel?.trim() || "threads";

  useLayoutEffect(() => {
    const pendingFocus = pendingFocusRef.current;
    if (!pendingFocus) return;
    pendingFocusRef.current = null;
    if (pendingFocus === "after-collapse") {
      showMoreButtonRef.current?.focus();
      return;
    }
    if (hasHiddenLoadedEntries && showMore) {
      showMoreButtonRef.current?.focus();
      return;
    }
    collapseButtonRef.current?.focus();
  }, [hasHiddenLoadedEntries, showCollapse, showMore]);

  if (!showMore && !showCollapse) return null;

  return (
    <div
      data-messenger-scroll-coverage-row
      className="mx-1.5 flex items-center gap-1.5 px-2 py-1"
    >
      {showMore ? (
        hasHiddenLoadedEntries ? (
          <button
            type="button"
            data-testid={`${testId}-show-more`}
            ref={showMoreButtonRef}
            aria-label={`Show more ${subject}`}
            className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
            onClick={() => {
              pendingFocusRef.current = "after-show-more";
              onShowMore();
            }}
          >
            Show more
          </button>
        ) : (
          <MessengerSectionAutoLoader
            testId={`${testId}-auto-loader`}
            loading={loading}
            onVisible={onAutoLoad}
          />
        )
      ) : null}
      {showCollapse ? (
        <button
          type="button"
          data-testid={`${testId}-collapse`}
          ref={collapseButtonRef}
          aria-label={`Collapse ${subject}`}
          className="inline-flex h-7 items-center rounded-[calc(var(--radius-sm)-1px)] px-2 text-[11px] font-medium text-muted-foreground transition-[background-color,color] hover:bg-[color:var(--surface-active)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
          onClick={() => {
            pendingFocusRef.current = "after-collapse";
            onCollapse();
          }}
        >
          Collapse
        </button>
      ) : null}
    </div>
  );
}
