import { cn } from "@/lib/utils";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export type SelectionAnnotationRect = Pick<
  DOMRect,
  "left" | "right" | "top" | "bottom" | "width" | "height"
>;

export type SelectionAnnotationToolbarLabels = {
  addToChat: string;
  askInSideChat: string;
  toolbarLabel: string;
};

const DEFAULT_LABELS: SelectionAnnotationToolbarLabels = {
  addToChat: "Add to chat",
  askInSideChat: "Ask in side chat",
  toolbarLabel: "Response annotation actions",
};

export function placeSelectionAnnotationToolbar(
  anchorRect: SelectionAnnotationRect,
  toolbarSize: { width: number; height: number },
  viewport: {
    width: number;
    height: number;
    padding: number;
    gap: number;
    boundaryRect?: SelectionAnnotationRect | null;
  },
): { left: number; top: number; placement: "top" | "bottom" } {
  const boundary = viewport.boundaryRect;
  const minLeft = Math.max(
    viewport.padding,
    boundary ? boundary.left + viewport.padding : viewport.padding,
  );
  const maxRight = Math.min(
    viewport.width - viewport.padding,
    boundary ? boundary.right - viewport.padding : viewport.width - viewport.padding,
  );
  const minTop = Math.max(
    viewport.padding,
    boundary ? boundary.top + viewport.padding : viewport.padding,
  );
  const maxBottom = Math.min(
    viewport.height - viewport.padding,
    boundary ? boundary.bottom - viewport.padding : viewport.height - viewport.padding,
  );
  const preferredLeft = anchorRect.left + (anchorRect.width - toolbarSize.width) / 2;
  const maxLeft = Math.max(minLeft, maxRight - toolbarSize.width);
  const left = Math.min(Math.max(preferredLeft, minLeft), maxLeft);
  const topPosition = anchorRect.top - viewport.gap - toolbarSize.height;
  const placement = topPosition >= minTop ? "top" : "bottom";
  const preferredTop = placement === "top"
    ? topPosition
    : anchorRect.bottom + viewport.gap;
  const maxTop = Math.max(minTop, maxBottom - toolbarSize.height);
  return {
    left,
    top: Math.min(Math.max(preferredTop, minTop), maxTop),
    placement,
  };
}

export function SelectionAnnotationToolbar({
  open,
  anchorRect,
  getAnchorRect,
  boundaryRect,
  getBoundaryRect,
  onAddToChat,
  onAskInSideChat,
  askInSideChatDisabled = false,
  onDismiss,
  labels = DEFAULT_LABELS,
  returnFocusRef,
  onReturnFocus,
  autoFocus = false,
  className,
}: {
  open: boolean;
  anchorRect: SelectionAnnotationRect;
  getAnchorRect?: () => SelectionAnnotationRect | null;
  boundaryRect?: SelectionAnnotationRect | null;
  getBoundaryRect?: () => SelectionAnnotationRect | null;
  onAddToChat: () => void;
  onAskInSideChat: () => void;
  askInSideChatDisabled?: boolean;
  onDismiss: () => void;
  labels?: SelectionAnnotationToolbarLabels;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onReturnFocus?: () => void;
  autoFocus?: boolean;
  className?: string;
}) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [liveAnchorRect, setLiveAnchorRect] = useState(anchorRect);
  const [liveBoundaryRect, setLiveBoundaryRect] = useState(boundaryRect ?? null);
  const [toolbarSize, setToolbarSize] = useState(() => ({
    width: Math.min(360, Math.max(0, (typeof window === "undefined" ? 1024 : window.innerWidth) - 16)),
    height: 40,
  }));
  const actions = useMemo(() => [
    { label: labels.addToChat, run: onAddToChat, disabled: false },
    { label: labels.askInSideChat, run: onAskInSideChat, disabled: askInSideChatDisabled },
  ], [askInSideChatDisabled, labels, onAddToChat, onAskInSideChat]);
  const placement = placeSelectionAnnotationToolbar(
    liveAnchorRect,
    toolbarSize,
    {
      width: typeof window === "undefined" ? 1024 : window.innerWidth,
      height: typeof window === "undefined" ? 768 : window.innerHeight,
      padding: 8,
      gap: 8,
      boundaryRect: liveBoundaryRect,
    },
  );

  useEffect(() => {
    if (!open || !autoFocus) return;
    toolbarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [autoFocus, open]);

  useEffect(() => {
    setLiveAnchorRect(anchorRect);
  }, [anchorRect]);

  useEffect(() => {
    setLiveBoundaryRect(boundaryRect ?? null);
  }, [boundaryRect]);

  useLayoutEffect(() => {
    if (!open) return;
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const measure = () => {
      const rect = toolbar.getBoundingClientRect();
      const width = rect.width || toolbar.scrollWidth;
      const height = rect.height || toolbar.scrollHeight;
      if (width <= 0 || height <= 0) return;
      setToolbarSize((current) => (
        current.width === width && current.height === height
          ? current
          : { width, height }
      ));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(toolbar);
    return () => observer?.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const updateAnchor = () => {
      const next = getAnchorRect?.();
      if (next) setLiveAnchorRect(next);
      if (getBoundaryRect) setLiveBoundaryRect(getBoundaryRect());
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    document.addEventListener("selectionchange", updateAnchor);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
      document.removeEventListener("selectionchange", updateAnchor);
    };
  }, [getAnchorRect, getBoundaryRect, open]);

  useEffect(() => {
    if (!open) return;
    const handleGlobalKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onDismiss();
      if (onReturnFocus) onReturnFocus();
      else returnFocusRef?.current?.focus();
    };
    document.addEventListener("keydown", handleGlobalKeyDown);
    return () => document.removeEventListener("keydown", handleGlobalKeyDown);
  }, [onDismiss, onReturnFocus, open, returnFocusRef]);

  if (!open || typeof document === "undefined") return null;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const buttons = Array.from(
      toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [],
    );
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDismiss();
      if (onReturnFocus) onReturnFocus();
      else returnFocusRef?.current?.focus();
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
      buttons[currentIndex]?.click();
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
          disabled={action.disabled}
          aria-disabled={action.disabled}
          className="min-h-9 whitespace-nowrap border-r border-[color:var(--border-soft)] px-3 text-sm text-foreground transition-colors last:border-r-0 hover:bg-[color:var(--surface-active)] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent [@media(pointer:coarse)]:min-h-11 motion-reduce:transition-none"
          onClick={action.run}
        >
          {action.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
