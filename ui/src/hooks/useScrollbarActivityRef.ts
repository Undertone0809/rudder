import { useCallback, useRef, type RefCallback } from "react";

/** Hide delay after last scroll event before fading the scrollbar again (ms). */
const SCROLLBAR_HIDE_MS = 700;

function readStoredScrollTop(storageKey?: string): number | null {
  if (!storageKey || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredScrollTop(storageKey: string | undefined, scrollTop: number) {
  if (!storageKey || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey, String(scrollTop));
  } catch {
    // Ignore storage failures in restricted environments.
  }
}

/**
 * Ref callback for scrollable elements using `.scrollbar-auto-hide`.
 * Adds `is-scrolling` while the user is scrolling so CSS can show the thumb
 * only during scroll (not on idle hover).
 */
export function useScrollbarActivityRef(storageKey?: string): RefCallback<HTMLElement> {
  const cleanupRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback((el: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!el) return;

    const storedScrollTop = readStoredScrollTop(storageKey);
    if (storedScrollTop !== null) {
      requestAnimationFrame(() => {
        el.scrollTop = storedScrollTop;
      });
    }

    const onScroll = () => {
      el.classList.add("is-scrolling");
      writeStoredScrollTop(storageKey, el.scrollTop);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        el.classList.remove("is-scrolling");
        timerRef.current = null;
      }, SCROLLBAR_HIDE_MS);
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    cleanupRef.current = () => {
      el.removeEventListener("scroll", onScroll);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      el.classList.remove("is-scrolling");
    };
  }, [storageKey]);
}
