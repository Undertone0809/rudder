import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

function usesOwnScroll(element: HTMLElement | null) {
  if (!element) return false;
  const overflowY = window.getComputedStyle(element).overflowY;
  return (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay")
    && element.scrollHeight > element.clientHeight + 1;
}

function resolveScrollTarget() {
  const issueDetail = document.querySelector<HTMLElement>('[data-testid="issue-detail-main-scroll"]');
  if (usesOwnScroll(issueDetail)) {
    return { type: "element" as const, element: issueDetail! };
  }

  const mainContent = document.getElementById("main-content");
  if (usesOwnScroll(mainContent)) {
    return { type: "element" as const, element: mainContent! };
  }

  return { type: "window" as const };
}

function distanceFromBottom(target: ReturnType<typeof resolveScrollTarget>) {
  if (target.type === "element") {
    return target.element.scrollHeight - target.element.scrollTop - target.element.clientHeight;
  }

  const scroller = document.scrollingElement ?? document.documentElement;
  return scroller.scrollHeight - window.scrollY - window.innerHeight;
}

/**
 * Floating scroll-to-bottom button that follows the active page scroller.
 * On desktop that is the Issue detail surface (or `#main-content` elsewhere);
 * on mobile it falls back to window/page scroll.
 */
export function ScrollToBottom() {
  const [visible, setVisible] = useState(false);
  const [mobileBottomOffset, setMobileBottomOffset] = useState<number | null>(null);

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromBottom(resolveScrollTarget()) > 300);

      const composer = document.querySelector<HTMLElement>('[aria-label="Comment composer"]');
      const nextMobileBottomOffset = window.innerWidth < 768 && composer
        ? Math.ceil(window.innerHeight - composer.getBoundingClientRect().top + 12)
        : null;
      setMobileBottomOffset((current) => (
        current === nextMobileBottomOffset ? current : nextMobileBottomOffset
      ));
    };

    const mainContent = document.getElementById("main-content");
    const issueDetail = document.querySelector<HTMLElement>('[data-testid="issue-detail-main-scroll"]');
    const composer = document.querySelector<HTMLElement>('[aria-label="Comment composer"]');
    const composerResizeObserver = typeof ResizeObserver === "undefined" || !composer
      ? null
      : new ResizeObserver(check);

    check();
    if (composer && composerResizeObserver) composerResizeObserver.observe(composer);
    issueDetail?.addEventListener("scroll", check, { passive: true });
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);

    return () => {
      composerResizeObserver?.disconnect();
      issueDetail?.removeEventListener("scroll", check);
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  const scroll = useCallback(() => {
    const target = resolveScrollTarget();

    if (target.type === "element") {
      target.element.scrollTo({ top: target.element.scrollHeight, behavior: "smooth" });
      return;
    }

    const scroller = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, []);

  if (!visible) return null;

  return (
    <button
      onClick={scroll}
      className="fixed bottom-[calc(1.5rem+5rem+env(safe-area-inset-bottom))] right-6 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background shadow-md hover:bg-accent transition-colors md:bottom-6"
      aria-label="Scroll to bottom"
      style={mobileBottomOffset === null
        ? undefined
        : { bottom: `calc(${mobileBottomOffset}px + env(safe-area-inset-bottom))` }}
    >
      <ArrowDown className="h-4 w-4" />
    </button>
  );
}
