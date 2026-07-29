import { useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

const SCROLL_RANGE_CHUNK_ROWS = 4;

export function VirtualizedActivityTimeline<T>({
  children,
  estimateSize,
  getItemKey,
  items,
  itemGap = 20,
  overscan = 3,
  preventScrollBlanking = false,
  onTargetMounted,
  scrollElementRef,
  targetKey,
  testId,
}: {
  children: (item: T, index: number) => ReactNode;
  estimateSize: (index: number) => number;
  getItemKey: (item: T, index: number) => string;
  items: T[];
  itemGap?: number;
  overscan?: number;
  preventScrollBlanking?: boolean;
  onTargetMounted?: (key: string) => void;
  scrollElementRef: RefObject<HTMLElement | null>;
  targetKey?: string | null;
  testId: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const notifiedTargetRef = useRef<string | null>(null);
  const virtualizerRef = useRef<{
    isScrolling: boolean;
    scrollDirection: "backward" | "forward" | null;
  } | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const itemKeys = useMemo(
    () => items.map((item, index) => getItemKey(item, index)),
    [getItemKey, items],
  );
  const getVirtualItemKey = useCallback(
    (index: number) => itemKeys[index] ?? index,
    [itemKeys],
  );
  const directionalRangeExtractor = useCallback((range: Range) => {
    const direction = virtualizerRef.current?.scrollDirection;
    // Fast trackpad reversals can move the viewport back into recently passed
    // rows before the next virtual range commits. Retain half of the forward
    // buffer behind the viewport so those reversal frames remain painted
    // without making every scroll frame maintain a nearly symmetric window.
    const trailingOverscan = Math.max(8, Math.ceil(overscan / 2));
    const before = direction === "backward" ? overscan : trailingOverscan;
    const after = direction === "backward" ? trailingOverscan : overscan;
    const rawStart = Math.max(0, range.startIndex - before);
    const rawEnd = Math.min(range.count - 1, range.endIndex + after);
    const start = Math.floor(rawStart / SCROLL_RANGE_CHUNK_ROWS)
      * SCROLL_RANGE_CHUNK_ROWS;
    const end = Math.min(
      range.count - 1,
      Math.ceil((rawEnd + 1) / SCROLL_RANGE_CHUNK_ROWS)
        * SCROLL_RANGE_CHUNK_ROWS - 1,
    );
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }, [overscan]);
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize,
    getItemKey: getVirtualItemKey,
    getScrollElement: () => scrollElementRef.current,
    ...(preventScrollBlanking
      ? {
        overscan: 0,
        rangeExtractor: directionalRangeExtractor,
      }
      : { overscan }),
    scrollMargin,
    directDomUpdates: preventScrollBlanking,
    directDomUpdatesMode: "transform",
    useFlushSync: false,
  });
  virtualizerRef.current = virtualizer;
  const setContainerRef = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (preventScrollBlanking) virtualizer.containerRef(node);
  }, [preventScrollBlanking, virtualizer]);
  const virtualItems = virtualizer.getVirtualItems();
  const baselineMode = import.meta.env.MODE === "test"
    || (typeof window !== "undefined"
      && new URLSearchParams(window.location.search).get("perfBaseline") === "1");

  useLayoutEffect(() => {
    const container = containerRef.current;
    const scrollElement = scrollElementRef.current;
    if (!container || !scrollElement) return undefined;

    const measureMargin = () => {
      const containerRect = container.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      const next = Math.max(0, containerRect.top - scrollRect.top + scrollElement.scrollTop);
      setScrollMargin((current) => Math.abs(current - next) < 1 ? current : next);
    };
    measureMargin();
    const ancestors: HTMLElement[] = [];
    let ancestor = container.parentElement;
    while (ancestor && ancestor !== scrollElement) {
      ancestors.push(ancestor);
      ancestor = ancestor.parentElement;
    }
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => measureMargin());
    resizeObserver?.observe(container);
    for (const element of ancestors) resizeObserver?.observe(element);

    // Nested timelines share the outer sidebar scroll element. The outer
    // virtualizer writes transform styles while scrolling, so observing every
    // ancestor style mutation with a layout read creates a forced-layout loop.
    // Ignore that hot path and coalesce any meaningful group/layout correction
    // until scrolling has settled.
    let deferredMeasureTimer: ReturnType<typeof setTimeout> | null = null;
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
        if (!virtualizerRef.current?.isScrolling) {
          measureMargin();
          return;
        }
        if (deferredMeasureTimer !== null) {
          clearTimeout(deferredMeasureTimer);
        }
        deferredMeasureTimer = setTimeout(() => {
          deferredMeasureTimer = null;
          measureMargin();
        }, 180);
      });
    for (const element of ancestors) {
      mutationObserver?.observe(element, {
        attributeFilter: ["class", "style"],
        attributes: true,
      });
    }
    return () => {
      if (deferredMeasureTimer !== null) {
        clearTimeout(deferredMeasureTimer);
      }
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
    };
  }, [preventScrollBlanking, scrollElementRef]);

  useLayoutEffect(() => {
    if (!targetKey) return;
    const index = itemKeys.indexOf(targetKey);
    if (index === -1) return;
    virtualizer.scrollToIndex(index, { align: "center" });
  }, [itemKeys, targetKey, virtualizer]);

  useLayoutEffect(() => {
    if (!targetKey || !onTargetMounted) return undefined;
    if (notifiedTargetRef.current === targetKey) return undefined;
    if (!virtualItems.some((item) => itemKeys[item.index] === targetKey)) return undefined;
    notifiedTargetRef.current = targetKey;
    const frame = requestAnimationFrame(() => onTargetMounted(targetKey));
    return () => cancelAnimationFrame(frame);
  }, [itemKeys, onTargetMounted, targetKey, virtualItems]);

  useLayoutEffect(() => {
    if (targetKey === notifiedTargetRef.current) return;
    notifiedTargetRef.current = null;
  }, [targetKey]);

  if (baselineMode) {
    return (
      <div data-testid={`${testId}-baseline`} className="flex w-full flex-col gap-5">
        {items.map((item, index) => (
          <div
            key={itemKeys[index]}
            data-virtualized-activity-key={itemKeys[index]}
          >
            {children(item, index)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={setContainerRef}
      data-testid={testId}
      style={{
        ...(!preventScrollBlanking ? { height: `${virtualizer.getTotalSize()}px` } : {}),
        position: "relative",
        width: "100%",
      }}
    >
      {virtualItems.map((virtualItem) => {
        const item = items[virtualItem.index];
        if (!item) return null;
        return (
          <div
            key={virtualItem.key}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-virtualized-activity-key={itemKeys[virtualItem.index]}
            style={{
              left: 0,
              paddingBottom: `${itemGap}px`,
              position: "absolute",
              top: 0,
              ...(!preventScrollBlanking
                ? { transform: `translateY(${virtualItem.start - scrollMargin}px)` }
                : {}),
              width: "100%",
            }}
          >
            {children(item, virtualItem.index)}
          </div>
        );
      })}
    </div>
  );
}
