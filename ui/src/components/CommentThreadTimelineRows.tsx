import { useLayoutEffect, type CSSProperties, type ReactNode, type RefObject } from "react";
import {
  commentThreadTimelineItemKey,
  type CommentThreadTimelineRenderItem,
} from "./CommentThread.timeline";
import { VirtualizedActivityTimeline } from "./VirtualizedActivityTimeline";

export function CommentThreadTimelineRows({
  announcement,
  children,
  mountAll,
  onTargetMounted,
  reserveHashScrollEndSpace,
  regionLabel,
  scrollElementRef,
  targetKey,
  timeline,
  timelineRegionId,
}: {
  announcement?: string;
  children: (item: CommentThreadTimelineRenderItem) => ReactNode;
  mountAll?: boolean;
  onTargetMounted?: (key: string) => void;
  reserveHashScrollEndSpace?: boolean;
  regionLabel?: string;
  scrollElementRef?: RefObject<HTMLElement | null>;
  targetKey?: string | null;
  timeline: CommentThreadTimelineRenderItem[];
  timelineRegionId: string;
}) {
  const virtualized = !mountAll && Boolean(scrollElementRef) && timeline.length > 60;
  useLayoutEffect(() => {
    if (virtualized || !targetKey || !onTargetMounted) return;
    if (!timeline.some((item) => commentThreadTimelineItemKey(item) === targetKey)) return;
    onTargetMounted(targetKey);
  }, [onTargetMounted, targetKey, timeline, virtualized]);

  const renderWrapper = (item: CommentThreadTimelineRenderItem) => (
    <div
      data-issue-timeline-key={commentThreadTimelineItemKey(item)}
      tabIndex={item.kind === "disclosure" ? undefined : -1}
    >
      {children(item)}
    </div>
  );
  const timelineItems = virtualized && scrollElementRef ? (
    <VirtualizedActivityTimeline
      items={timeline}
      getItemKey={commentThreadTimelineItemKey}
      estimateSize={(index) => {
        const item = timeline[index];
        if (item?.kind === "disclosure") return 64;
        if (item?.kind === "run") {
          return item.run.status === "queued" || item.run.status === "running" ? 320 : 52;
        }
        if (item?.kind === "activity") return 48;
        return 168;
      }}
      leadingOverscan={32}
      overscan={12}
      preventScrollBlanking
      scrollElementRef={scrollElementRef}
      targetKey={targetKey}
      onTargetMounted={onTargetMounted}
      testId="comment-thread-virtual-timeline"
    >
      {(item) => renderWrapper(item)}
    </VirtualizedActivityTimeline>
  ) : timeline.map((item) => (
    <div key={commentThreadTimelineItemKey(item)}>
      {renderWrapper(item)}
    </div>
  ));

  return (
    <div
      id={timelineRegionId}
      className="space-y-3"
      role={regionLabel ? "region" : undefined}
      aria-label={regionLabel}
    >
      {timelineItems}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</span>
      {reserveHashScrollEndSpace ? (
        <div
          aria-hidden="true"
          className="h-[var(--comment-hash-scroll-end-space)]"
          style={{ "--comment-hash-scroll-end-space": "min(6rem, 12vh)" } as CSSProperties}
          data-testid="comment-hash-scroll-end-space"
        />
      ) : null}
    </div>
  );
}
