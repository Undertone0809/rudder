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

export function VirtualizedActivityTimeline<T>({
  children,
  estimateSize,
  getItemKey,
  items,
  itemGap = 20,
  overscan = 3,
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
    useFlushSync: false,
  });
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
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measureMargin);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollElementRef]);

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
      ref={containerRef}
      data-testid={testId}
      style={{
        height: `${virtualizer.getTotalSize()}px`,
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
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
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
