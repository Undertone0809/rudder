import { cn } from "@/lib/utils";
import {
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

type RectLike = Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;

export type SelectionAnnotationToolbarLabels = {
  addToChat: string;
  moreDetails: string;
  askInSideChat: string;
  toolbarLabel: string;
};

const DEFAULT_LABELS: SelectionAnnotationToolbarLabels = {
  addToChat: "Add to chat",
  moreDetails: "More details",
  askInSideChat: "Ask in side chat",
  toolbarLabel: "Response annotation actions",
};

export function placeSelectionAnnotationToolbar(
  anchorRect: RectLike,
  toolbarSize: { width: number; height: number },
  viewport: { width: number; height: number; padding: number; gap: number },
): { left: number; top: number; placement: "top" | "bottom" } {
  const preferredLeft = anchorRect.left + (anchorRect.width - toolbarSize.width) / 2;
  const maxLeft = Math.max(viewport.padding, viewport.width - viewport.padding - toolbarSize.width);
  const left = Math.min(Math.max(preferredLeft, viewport.padding), maxLeft);
  const topPosition = anchorRect.top - viewport.gap - toolbarSize.height;
  const placement = topPosition >= viewport.padding ? "top" : "bottom";
  const preferredTop = placement === "top"
    ? topPosition
    : anchorRect.bottom + viewport.gap;
  const maxTop = Math.max(viewport.padding, viewport.height - viewport.padding - toolbarSize.height);
  return {
    left,
    top: Math.min(Math.max(preferredTop, viewport.padding), maxTop),
    placement,
  };
}

export function SelectionAnnotationToolbar({
  open,
  anchorRect,
  onAddToChat,
  onMoreDetails,
  onAskInSideChat,
  onDismiss,
  labels = DEFAULT_LABELS,
  returnFocusRef,
  autoFocus = false,
  className,
}: {
  open: boolean;
  anchorRect: RectLike;
  onAddToChat: () => void;
  onMoreDetails: () => void;
  onAskInSideChat: () => void;
  onDismiss: () => void;
  labels?: SelectionAnnotationToolbarLabels;
  returnFocusRef?: RefObject<HTMLElement | null>;
  autoFocus?: boolean;
  className?: string;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actions = useMemo(() => [
    { label: labels.addToChat, run: onAddToChat },
    { label: labels.moreDetails, run: onMoreDetails },
    { label: labels.askInSideChat, run: onAskInSideChat },
  ], [labels, onAddToChat, onAskInSideChat, onMoreDetails]);
  const placement = placeSelectionAnnotationToolbar(
    anchorRect,
    { width: 360, height: 40 },
    {
      width: typeof window === "undefined" ? 1024 : window.innerWidth,
      height: typeof window === "undefined" ? 768 : window.innerHeight,
      padding: 8,
      gap: 8,
    },
  );

  useEffect(() => {
    if (!open || !autoFocus) return;
    toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [autoFocus, open]);

  if (!open || typeof document === "undefined") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      returnFocusRef?.current?.focus();
      return;
    }
    const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      buttons[(currentIndex + 1 + buttons.length) % buttons.length]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      buttons[(currentIndex - 1 + buttons.length) % buttons.length]?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && currentIndex >= 0) {
      event.preventDefault();
      actions[currentIndex]?.run();
    }
  }

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={labels.toolbarLabel}
      aria-orientation="horizontal"
      data-placement={placement.placement}
      className={cn(
        "fixed z-[80] inline-flex overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border-soft)] bg-[color:var(--surface-elevated)] shadow-[var(--shadow-lg)]",
        className,
      )}
      style={{ left: placement.left, top: placement.top }}
      onKeyDown={handleKeyDown}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          className="min-h-9 whitespace-nowrap border-r border-[color:var(--border-soft)] px-3 text-sm text-foreground transition-colors last:border-r-0 hover:bg-[color:var(--surface-active)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 [@media(pointer:coarse)]:min-h-11 motion-reduce:transition-none"
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
