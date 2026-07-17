import { Copy, ExternalLink, Link2, X } from "lucide-react";
import { createPortal } from "react-dom";

export type WorkspaceTabContextMenuState = {
  filePath: string;
  left: number;
  top: number;
};

export function WorkspaceTabContextMenu({
  menu,
  ideLabel,
  canOpenInIde,
  canCloseOtherTabs,
  canCloseTabsToRight,
  onClose,
  onCopyLink,
  onCopyAbsolutePath,
  onOpenInIde,
  onCloseTab,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
}: {
  menu: WorkspaceTabContextMenuState | null;
  ideLabel: string;
  canOpenInIde: boolean;
  canCloseOtherTabs: boolean;
  canCloseTabsToRight: boolean;
  onClose: () => void;
  onCopyLink: (filePath: string) => void;
  onCopyAbsolutePath: (filePath: string) => void;
  onOpenInIde: (filePath: string) => void;
  onCloseTab: (filePath: string) => void;
  onCloseOtherTabs: (filePath: string) => void;
  onCloseTabsToRight: (filePath: string) => void;
  onCloseAllTabs: () => void;
}) {
  if (!menu || typeof document === "undefined") return null;
  const runForFile = (action: (filePath: string) => void) => {
    action(menu.filePath);
    onClose();
  };
  const itemClass = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground";

  return createPortal(
    <div
      role="menu"
      data-testid="org-workspaces-tab-context-menu"
      className="motion-chat-composer-menu-pop surface-overlay fixed z-50 w-[220px] overflow-hidden rounded-md border border-border p-1 text-sm text-foreground shadow-lg"
      style={{ left: menu.left, top: menu.top }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button type="button" role="menuitem" data-chat-composer-menu-item className={itemClass} onClick={() => runForFile(onCopyLink)}>
        <Link2 className="h-4 w-4 text-muted-foreground" />
        Copy link
      </button>
      <button type="button" role="menuitem" data-chat-composer-menu-item className={itemClass} onClick={() => runForFile(onCopyAbsolutePath)}>
        <Copy className="h-4 w-4 text-muted-foreground" />
        Copy absolute path
      </button>
      <button type="button" role="menuitem" data-chat-composer-menu-item className={`${itemClass} disabled:pointer-events-none disabled:opacity-50`} disabled={!canOpenInIde} onClick={() => runForFile(onOpenInIde)}>
        <ExternalLink className="h-4 w-4 text-muted-foreground" />
        Open in {ideLabel}
      </button>
      <div className="-mx-1 my-1 h-px bg-border" />
      <button type="button" role="menuitem" data-chat-composer-menu-item className={itemClass} onClick={() => runForFile(onCloseTab)}>
        <X className="h-4 w-4 text-muted-foreground" />
        Close
      </button>
      <button type="button" role="menuitem" data-chat-composer-menu-item className={`${itemClass} disabled:pointer-events-none disabled:opacity-50`} disabled={!canCloseOtherTabs} onClick={() => runForFile(onCloseOtherTabs)}>
        Close others
      </button>
      <button type="button" role="menuitem" data-chat-composer-menu-item className={`${itemClass} disabled:pointer-events-none disabled:opacity-50`} disabled={!canCloseTabsToRight} onClick={() => runForFile(onCloseTabsToRight)}>
        Close tabs to the right
      </button>
      <button type="button" role="menuitem" data-chat-composer-menu-item className={itemClass} onClick={() => {
        onCloseAllTabs();
        onClose();
      }}>
        Close all
      </button>
    </div>,
    document.body,
  );
}
