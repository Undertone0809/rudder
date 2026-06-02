function isPlainUnhandledEscape(event: KeyboardEvent) {
  return event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
}

function hasBlockingEscapeLayer(extraSelectors: string[] = []) {
  if (typeof document === "undefined") return false;
  return Boolean(
    document.querySelector(
      [
        "[role='dialog']",
        "[role='menu']",
        "[role='listbox']",
        "[data-radix-popper-content-wrapper]",
        ...extraSelectors,
      ].join(", "),
    ),
  );
}

export function shouldHandleDetailEscape(event: KeyboardEvent) {
  if (!isPlainUnhandledEscape(event)) return false;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target) {
    const editable = target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
    if (target.isContentEditable || editable) return false;
  }

  if (hasBlockingEscapeLayer()) return false;

  return true;
}

export function shouldHandleIssueDetailEscape(event: KeyboardEvent) {
  if (!isPlainUnhandledEscape(event)) return false;

  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target) {
    const editable = target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='plaintext-only']");
    if (target.isContentEditable || editable) {
      const emptyEscapeBackSurface = target.closest("[data-issue-detail-escape-back='empty']");
      const isContentEditableTarget = target.isContentEditable
        || Boolean(target.closest("[contenteditable='true'], [contenteditable='plaintext-only']"));
      if (!emptyEscapeBackSurface || !isContentEditableTarget) return false;
    }
  }

  if (hasBlockingEscapeLayer(["[data-issue-find-ui]"])) return false;

  return true;
}

export function shouldHandleDocumentFocusEscape(event: KeyboardEvent) {
  if (!isPlainUnhandledEscape(event)) return false;
  if (hasBlockingEscapeLayer()) return false;
  return true;
}

export function hasBrowserBackStackEntry() {
  if (typeof window === "undefined") return false;
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" && index > 0;
}
