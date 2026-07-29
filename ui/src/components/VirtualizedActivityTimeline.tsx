import { useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

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
  const [scrollMargin, setScrollMargin] = useState(0);
  const itemKeys = useMemo(
    () => items.map((item, index) => getItemKey(item, index)),
    [getItemKey, items],
  );
  const getVirtualItemKey = useCallback(
    (index: number) => itemKeys[index] ?? index,
    [itemKeys],
  );
  const virtualizer = useVirtualizer({
    count: items.length,
    estimateSize,
    getItemKey: getVirtualItemKey,
    getScrollElement: () => scrollElementRef.current,
    overscan,
    scrollMargin,
    directDomUpdates: preventScrollBlanking,
    directDomUpdatesMode: "transform",
    useFlushSync: preventScrollBlanking,
  });
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

    const measureMargin = (synchronous = false) => {
      const containerRect = container.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      const next = Math.max(0, containerRect.top - scrollRect.top + scrollElement.scrollTop);
      const update = () => {
        setScrollMargin((current) => Math.abs(current - next) < 1 ? current : next);
      };
      if (synchronous && preventScrollBlanking) flushSync(update);
      else update();
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

    // Nested timelines share the outer sidebar scroll element. Direct DOM
    // positioning can move an ancestor without resizing this container, so a
    // ResizeObserver alone would leave scrollMargin stale after group/layout
    // changes. Ancestor style/class mutations are infrequent and are committed
    // synchronously before the next paint to keep the visible slice aligned.
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => measureMargin(true));
    for (const element of ancestors) {
      mutationObserver?.observe(element, {
        attributeFilter: ["class", "style"],
        attributes: true,
      });
    }
    return () => {
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
