function isPlainUnhandledEscape(event: KeyboardEvent) {
  return event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey;
}

function isHiddenEscapeLayer(element: Element) {
  let current: Element | null = element;
  while (current && current instanceof HTMLElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(current);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    current = current.parentElement;
  }

  const statefulElements = [
    element,
    ...Array.from(element.querySelectorAll("[data-state]")),
  ];
  const hasOpenState = statefulElements.some((candidate) => candidate.getAttribute("data-state") === "open");
  const hasClosedState = statefulElements.some((candidate) => candidate.getAttribute("data-state") === "closed");
  return hasClosedState && !hasOpenState;
}

export function hasBlockingEscapeLayer(extraSelectors: string[] = []) {
  if (typeof document === "undefined") return false;
  const candidates = Array.from(document.querySelectorAll(
    [
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='menu']",
      "[role='listbox']",
      "[data-radix-popper-content-wrapper]",
      "[data-slot='popover-content']",
      "[data-slot='dropdown-menu-content']",
      "[data-slot='command-dialog']",
      ...extraSelectors,
    ].join(", "),
  ));
  return candidates.some((candidate) => !isHiddenEscapeLayer(candidate));
}

export function shouldHandleDetailEscape(event: KeyboardEvent) {
  if (!isPlainUnhandledEscape(event)) return false;

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
