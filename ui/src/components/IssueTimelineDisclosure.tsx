import { Button } from "@/components/ui/button";
import type { InstanceLocale } from "@rudderhq/shared";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createInitialIssueTimelineDisclosure,
  revealIssueTimelineTarget,
  revealNextIssueTimelineBatch,
  selectIssueTimelineDisclosureItems,
  type IssueTimelineDisclosureItem,
  type IssueTimelineDisclosureState,
} from "./issue-timeline-disclosure";

export interface CommentThreadProgressiveDisclosure {
  key: string;
  ready: boolean;
  failOpen: boolean;
  forceExpanded?: boolean;
  mountAll?: boolean;
  onVisibilityChange?: () => void;
}

const FULLY_EXPANDED: IssueTimelineDisclosureState = {
  fullyExpanded: true,
  prefixBoundary: null,
  suffixBoundary: null,
};

function findTimelineScrollContainer(element: HTMLElement) {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(`${style.overflow} ${style.overflowY}`)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

export function IssueTimelineDisclosureDivider({
  hiddenCount,
  locale,
  onRevealMore,
  timelineRegionId,
}: {
  hiddenCount: number;
  locale: InstanceLocale;
  onRevealMore?: (keyboard: boolean, dividerTop: number) => void;
  timelineRegionId: string;
}) {
  const hiddenLabel = locale === "zh-CN"
    ? `已隐藏 ${hiddenCount} 条动态`
    : `${hiddenCount} hidden ${hiddenCount === 1 ? "item" : "items"}`;
  return (
    <div
      className="flex min-h-16 items-center gap-3 py-1"
      data-testid="issue-timeline-disclosure"
    >
      <span aria-hidden="true" className="h-px min-w-4 flex-1 border-t border-dashed border-border" />
      <div className="flex shrink-0 flex-col items-center gap-0.5 text-center">
        <span className="text-xs tabular-nums text-muted-foreground">{hiddenLabel}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          aria-controls={timelineRegionId}
          aria-expanded="false"
          onClick={(event) => onRevealMore?.(
            event.detail === 0,
            event.currentTarget.closest<HTMLElement>("[data-testid='issue-timeline-disclosure']")
              ?.getBoundingClientRect().top ?? event.currentTarget.getBoundingClientRect().top,
          )}
        >
          {locale === "zh-CN" ? "加载更多" : "Load more"}
        </Button>
      </div>
      <span aria-hidden="true" className="h-px min-w-4 flex-1 border-t border-dashed border-border" />
    </div>
  );
}

export function useIssueTimelineDisclosure<T extends IssueTimelineDisclosureItem>({
  config,
  items,
  locale,
}: {
  config?: CommentThreadProgressiveDisclosure;
  items: T[];
  locale: InstanceLocale;
}) {
  const reactId = useId();
  const timelineRegionId = `issue-activity-timeline-${reactId.replace(/:/gu, "")}`;
  const [dimensions, setDimensions] = useState({ height: 0, width: 0 });
  const [session, setSession] = useState<{
    key: string;
    state: IssueTimelineDisclosureState;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const pendingAnchorRef = useRef<{
    dividerTop: number;
    focus: boolean;
    key: string;
  } | null>(null);

  useLayoutEffect(() => {
    if (!config) return undefined;
    const region = document.getElementById(timelineRegionId);
    if (!region) return undefined;

    let frame: number | null = null;
    const measure = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const scrollRoot = findTimelineScrollContainer(region);
        const next = {
          height: scrollRoot?.clientHeight ?? window.innerHeight,
          width: region.clientWidth,
        };
        setDimensions((current) => (
          current.height === next.height && current.width === next.width ? current : next
        ));
        frame = null;
      });
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(region);
    const scrollRoot = findTimelineScrollContainer(region);
    if (scrollRoot) resizeObserver?.observe(scrollRoot);
    window.addEventListener("resize", measure, { passive: true });
    measure();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [config, timelineRegionId]);

  useLayoutEffect(() => {
    if (!config) return;
    if (config.failOpen || config.forceExpanded) {
      setSession((current) => (
        current?.key === config.key && current.state.fullyExpanded
          ? current
          : { key: config.key, state: FULLY_EXPANDED }
      ));
      return;
    }
    if (!config.ready || dimensions.height <= 0 || dimensions.width <= 0) return;
    setSession((current) => {
      if (current?.key === config.key) return current;
      return {
        key: config.key,
        state: createInitialIssueTimelineDisclosure(items, dimensions.height, dimensions.width),
      };
    });
  }, [config, dimensions, items]);

  const effectiveState = useMemo<IssueTimelineDisclosureState>(() => {
    if (!config || config.failOpen || config.forceExpanded || session?.key !== config.key) {
      return FULLY_EXPANDED;
    }
    return session.state;
  }, [config, session]);
  const selection = useMemo(
    () => selectIssueTimelineDisclosureItems(items, effectiveState),
    [effectiveState, items],
  );

  const revealMore = useCallback((keyboard: boolean, dividerTop: number) => {
    if (!config || selection.hidden.length === 0) return;
    pendingAnchorRef.current = {
      dividerTop,
      focus: keyboard,
      key: selection.hidden[0]!.key,
    };
    const nextState = revealNextIssueTimelineBatch(
      items,
      effectiveState,
      dimensions.height,
      dimensions.width,
    );
    const remaining = selectIssueTimelineDisclosureItems(items, nextState).hidden.length;
    setSession({ key: config.key, state: nextState });
    setAnnouncement(remaining === 0
      ? (locale === "zh-CN" ? "已显示全部动态" : "All activity is shown")
      : (locale === "zh-CN" ? `仍有 ${remaining} 条动态被隐藏` : `${remaining} hidden ${remaining === 1 ? "item remains" : "items remain"}`));
  }, [config, dimensions, effectiveState, items, locale, selection.hidden]);

  const revealTarget = useCallback((targetKey: string) => {
    if (!config || effectiveState.fullyExpanded) return;
    const nextState = revealIssueTimelineTarget(items, effectiveState, targetKey);
    if (nextState === effectiveState) return;
    setSession({ key: config.key, state: nextState });
  }, [config, effectiveState, items]);

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (!pending) return;
    const region = document.getElementById(timelineRegionId);
    const target = Array.from(region?.querySelectorAll<HTMLElement>("[data-issue-timeline-key]") ?? [])
      .find((element) => element.dataset.issueTimelineKey === pending.key);
    if (!target) return;
    const scrollRoot = findTimelineScrollContainer(target);
    const delta = target.getBoundingClientRect().top - pending.dividerTop;
    if (scrollRoot) scrollRoot.scrollTop += delta;
    else window.scrollBy({ top: delta, behavior: "auto" });
    if (pending.focus) target.focus({ preventScroll: true });
    pendingAnchorRef.current = null;
  }, [selection, timelineRegionId]);

  const onVisibilityChange = config?.onVisibilityChange;
  useEffect(() => {
    onVisibilityChange?.();
  }, [onVisibilityChange, selection.hidden.length]);

  return {
    announcement,
    mountAll: config?.mountAll,
    revealMore,
    revealTarget,
    selection,
    timelineRegionId,
  };
}

