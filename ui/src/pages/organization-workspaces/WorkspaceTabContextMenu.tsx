import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Copy, ExternalLink, Link2, X } from "lucide-react";

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
  if (!menu) return null;
  const runForFile = (action: (filePath: string) => void) => {
    action(menu.filePath);
  };
  const restoreTabFocus = () => {
    if (typeof document === "undefined") return;
    const tabContainer = Array.from(document.querySelectorAll<HTMLElement>("[data-testid^='org-workspaces-editor-tab-']"))
      .find((element) => element.getAttribute("data-testid") === `org-workspaces-editor-tab-${menu.filePath}`);
    tabContainer?.querySelector<HTMLElement>("[role='tab']")?.focus();
  };

  return (
    <DropdownMenu open onOpenChange={(open) => {
      if (!open) {
        onClose();
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(restoreTabFocus);
        } else {
          restoreTabFocus();
        }
      }
    }}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="org-workspaces-tab-context-menu-trigger"
          className="fixed z-50 size-px opacity-0"
          style={{ left: menu.left, top: menu.top }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        data-testid="org-workspaces-tab-context-menu"
        side="bottom"
        align="start"
        sideOffset={0}
        className="motion-chat-composer-menu-pop surface-overlay w-[220px] whitespace-nowrap border-border text-sm text-foreground"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger
            className="h-9 rounded-[6px] px-2 text-sm"
            data-chat-composer-menu-item
            data-testid="org-workspaces-tab-copy-submenu"
          >
            <Copy className="h-4 w-4 text-muted-foreground" />
            Copy
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            sideOffset={6}
            className="w-60 whitespace-nowrap p-1"
            data-testid="org-workspaces-tab-copy-submenu-content"
          >
            <DropdownMenuItem onSelect={() => runForFile(onCopyLink)}>
              <Link2 className="h-4 w-4 text-muted-foreground" />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => runForFile(onCopyAbsolutePath)}>
              <Copy className="h-4 w-4 text-muted-foreground" />
              Copy absolute path
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem disabled={!canOpenInIde} onSelect={() => runForFile(onOpenInIde)}>
          <ExternalLink className="h-4 w-4 text-muted-foreground" />
          Open in {ideLabel}
        </DropdownMenuItem>
        <div className="-mx-1 my-1 h-px bg-border" />
        <DropdownMenuItem onSelect={() => runForFile(onCloseTab)}>
          <X className="h-4 w-4 text-muted-foreground" />
          Close
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canCloseOtherTabs} onSelect={() => runForFile(onCloseOtherTabs)}>
          Close others
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canCloseTabsToRight} onSelect={() => runForFile(onCloseTabsToRight)}>
          Close tabs to the right
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onCloseAllTabs()}>
          Close all
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
