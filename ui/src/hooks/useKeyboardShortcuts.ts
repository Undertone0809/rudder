import { useEffect } from "react";

interface ShortcutHandlers {
  onNewIssue?: () => void;
  onToggleSidebar?: () => void;
  onTogglePanel?: () => void;
  onOpenSettings?: () => void;
  onNavigateBack?: () => boolean;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tagName = target.tagName;
  return tagName === "INPUT"
    || tagName === "TEXTAREA"
    || tagName === "SELECT"
    || target.isContentEditable
    || Boolean(target.closest('[contenteditable="true"], [contenteditable="plaintext-only"]'));
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
}: ShortcutHandlers) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing) return;

      // Don't fire shortcuts when typing in inputs
      if (isEditableShortcutTarget(e.target)) {
        return;
      }

      // Escape → previous page. Existing layers get first claim on Escape.
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && onNavigateBack) {
        if (hasOpenEscapeLayer()) return;
        if (!onNavigateBack()) return;
        e.preventDefault();
        return;
      }

      // C → New Issue
      if (e.key === "c" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onNewIssue?.();
      }

      // [ → Toggle Sidebar
      if (e.key === "[" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onToggleSidebar?.();
      }

      // ] → Toggle Panel
      if (e.key === "]" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        onTogglePanel?.();
      }

      // Cmd+, / Ctrl+, → Open Settings
      if (e.key === "," && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        onOpenSettings?.();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onNewIssue, onToggleSidebar, onTogglePanel, onOpenSettings, onNavigateBack]);
}
