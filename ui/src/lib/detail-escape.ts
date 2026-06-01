export function shouldHandleDetailEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return false;
  if (event.defaultPrevented) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;

  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target) {
    const editable = target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
    if (target.isContentEditable || editable) return false;
  }

  if (typeof document !== "undefined") {
    if (document.querySelector("[role='dialog']")) return false;
    if (document.querySelector("[data-radix-popper-content-wrapper]")) return false;
  }

  return true;
}

export function hasBrowserBackStackEntry() {
  if (typeof window === "undefined") return false;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" && index > 0;
}
