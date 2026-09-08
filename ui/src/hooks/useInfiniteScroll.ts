import { useEffect, useRef, type RefObject } from "react";

type UseInfiniteScrollOptions = {
  enabled: boolean;
  onLoadMore: () => void | Promise<unknown>;
  rootRef?: RefObject<Element | null>;
  rootMargin?: string;
};

/** Observe a list footer without allowing overlapping page requests. */
export function useInfiniteScroll({
  enabled,
  onLoadMore,
  rootRef,
  rootMargin = "320px 0px",
}: UseInfiniteScrollOptions): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);
  const requestInFlightRef = useRef(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || !sentinel || typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || requestInFlightRef.current) return;

      requestInFlightRef.current = true;
      const requestId = ++requestIdRef.current;
      let result: void | Promise<unknown>;
      try {
        result = onLoadMoreRef.current();
      } catch {
        if (requestIdRef.current === requestId) {
          requestInFlightRef.current = false;
        }
        return;
      }

      void Promise.resolve(result)
        .catch(() => undefined)
        .finally(() => {
          if (requestIdRef.current === requestId) {
            requestInFlightRef.current = false;
          }
        });
    }, {
      root: rootRef?.current ?? null,
      rootMargin,
    });

    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      requestIdRef.current += 1;
      requestInFlightRef.current = false;
    };
  }, [enabled, rootMargin, rootRef]);

  return sentinelRef;
}
