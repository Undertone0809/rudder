import { useEffect } from "react";
import type { KeyboardShortcutSettings } from "@rudderhq/shared";
import {
  eventMatchesShortcutAction,
  isEditableShortcutTarget,
} from "@/lib/keyboard-shortcuts";

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onOpenSettings?: () => void;
  onNavigateBack?: () => boolean;
  shortcutSettings?: KeyboardShortcutSettings | null;
}

function hasOpenEscapeLayer(): boolean {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[data-radix-popper-content-wrapper]',
        '[data-slot="popover-content"]',
        '[data-slot="dropdown-menu-content"]',
        '[data-slot="command-dialog"]',
        '[role="menu"]',
        '[role="listbox"]',
      ].join(", "),
    ),
  );
}

export function useKeyboardShortcuts({
  onNewIssue,
  onToggleSidebar,
  onTogglePanel,
  onOpenSettings,
  onNavigateBack,
  shortcutSettings,
}: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;

      // Escape is a navigation command once overlays/menus had a chance to
      // claim it. Do not suppress it just because focus is inside an editor.
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && onNavigateBack) {
        if (hasOpenEscapeLayer()) return;
        if (!onNavigateBack()) return;
        e.preventDefault();
        return;
      }

      // Don't fire shortcuts when typing in inputs
      if (isEditableShortcutTarget(e.target)) {
        return;
      }

      if (eventMatchesShortcutAction(e, "issue.create", shortcutSettings)) {
        e.preventDefault();
        onNewIssue?.();
        return;
      }

      if (eventMatchesShortcutAction(e, "sidebar.toggle", shortcutSettings)) {
        e.preventDefault();
        onToggleSidebar?.();
        return;
      }

      if (eventMatchesShortcutAction(e, "panel.toggle", shortcutSettings)) {
        e.preventDefault();
        onTogglePanel?.();
        return;
      }

      if (eventMatchesShortcutAction(e, "settings.open", shortcutSettings)) {
        e.preventDefault();
        onOpenSettings?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onNewIssue, onToggleSidebar, onTogglePanel, onOpenSettings, onNavigateBack, shortcutSettings]);
}
