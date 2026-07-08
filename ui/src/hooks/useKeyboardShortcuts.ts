import { hasBlockingEscapeLayer } from "@/lib/detail-escape";
import {
  eventMatchesShortcutAction,
  isEditableShortcutTarget,
} from "@/lib/keyboard-shortcuts";
import type { KeyboardShortcutSettings } from "@rudderhq/shared";
import { useEffect } from "react";

interface ShortcutHandlers {
  onNewChat?: () => void;
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onOpenSettings?: () => void;
  onNavigateBack?: () => boolean;
  shortcutSettings?: KeyboardShortcutSettings | null;
}

export function useKeyboardShortcuts({
  onNewChat,
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
        if (hasBlockingEscapeLayer()) return;
        if (!onNavigateBack()) return;
        e.preventDefault();
        return;
      }

      // Don't fire shortcuts when typing in inputs
      if (isEditableShortcutTarget(e.target)) {
        return;
      }

      if (hasBlockingEscapeLayer()) return;

      if (eventMatchesShortcutAction(e, "chat.create", shortcutSettings)) {
        e.preventDefault();
        onNewChat?.();
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

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onNewChat, onNewIssue, onToggleSidebar, onTogglePanel, onOpenSettings, onNavigateBack, shortcutSettings]);
}
