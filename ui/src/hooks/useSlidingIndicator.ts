import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

interface IndicatorState {
  left: number;
  width: number;
  ready: boolean;
}

export function useSlidingIndicator<TElement extends HTMLElement>(
  activeKey: string | undefined,
  keys: readonly string[],
) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, TElement>());
  const [indicator, setIndicator] = useState<IndicatorState>({ left: 0, width: 0, ready: false });
  const keysSignature = keys.join("\u001f");

  const setItemRef = useCallback((key: string) => (node: TElement | null) => {
    if (node) {
      itemRefs.current.set(key, node);
    } else {
      itemRefs.current.delete(key);
    }
  }, []);

  useIsomorphicLayoutEffect(() => {
    const container = containerRef.current;
    const activeItem = activeKey ? itemRefs.current.get(activeKey) : undefined;

    if (!container || !activeItem) {
      setIndicator((current) => (current.ready ? { ...current, ready: false } : current));
      return undefined;
    }

    let animationFrame = 0;
    const measure = () => {
      const nextContainer = containerRef.current;
      const nextActiveItem = activeKey ? itemRefs.current.get(activeKey) : undefined;
      if (!nextContainer || !nextActiveItem) return;

      const containerRect = nextContainer.getBoundingClientRect();
      const itemRect = nextActiveItem.getBoundingClientRect();
      setIndicator({
        left: itemRect.left - containerRect.left,
        width: itemRect.width,
        ready: true,
      });
    };
    const scheduleMeasure = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(measure);
    };

    measure();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(container);
    resizeObserver?.observe(activeItem);
    window.addEventListener("resize", scheduleMeasure);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [activeKey, keysSignature]);

  const indicatorStyle = useMemo<CSSProperties>(() => ({
    transform: `translateX(${indicator.left}px)`,
    width: indicator.width,
  }), [indicator.left, indicator.width]);

  return {
    containerRef,
    indicatorReady: indicator.ready,
    indicatorStyle,
    setItemRef,
  };
}
