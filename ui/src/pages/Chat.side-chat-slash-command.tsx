import { createPortal } from "react-dom";
import { CirclePlus } from "lucide-react";
import { useEffect, type CSSProperties, type Dispatch, type RefObject, type SetStateAction } from "react";

export function ChatSideChatSlashCommandMenu({
  visible,
  hasAnchor,
  position,
  setPosition,
  composerSurfaceRef,
  getMenuPosition,
  onActivate,
}: {
  visible: boolean;
  hasAnchor: boolean;
  position: CSSProperties | null;
  setPosition: Dispatch<SetStateAction<CSSProperties | null>>;
  composerSurfaceRef: RefObject<HTMLDivElement | null>;
  getMenuPosition: (anchor: HTMLElement) => CSSProperties;
  onActivate: () => void;
}) {
  useEffect(() => {
    if (!visible) {
      setPosition(null);
      return undefined;
    }
    const updatePosition = () => {
      const anchor = composerSurfaceRef.current;
      if (anchor) setPosition(getMenuPosition(anchor));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [composerSurfaceRef, getMenuPosition, setPosition, visible]);

  if (!visible || !position || typeof document === "undefined") return null;
  return createPortal(
    <div
      data-testid="chat-slash-command-menu"
      role="menu"
      aria-label="Chat commands"
      className="chat-composer-context-menu motion-chat-composer-menu-pop surface-overlay fixed z-50 overflow-hidden rounded-[var(--radius-lg)] border p-1.5 text-foreground"
      style={position}
    >
      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Commands</div>
      <button
        type="button"
        role="menuitem"
        className="chat-composer-menu-row"
        disabled={!hasAnchor}
        data-chat-composer-menu-item
        data-testid="chat-slash-side-chat"
        onClick={onActivate}
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[color:var(--surface-active)] text-[color:var(--accent-base)]">
          <CirclePlus className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-medium text-foreground">Side Chat</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {hasAnchor ? "Ask from the latest assistant answer" : "Wait for an assistant answer first"}
          </span>
        </span>
        <kbd className="shrink-0 rounded-[calc(var(--radius-sm)-2px)] border border-[color:var(--border-soft)] bg-[color:var(--surface-inset)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          Enter
        </kbd>
      </button>
    </div>,
    document.body,
  );
}
