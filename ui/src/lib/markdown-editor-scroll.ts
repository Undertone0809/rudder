import type { EditorView } from "@codemirror/view";

function nearestDocumentScrollContainer(element: HTMLElement) {
  const ancestors: HTMLElement[] = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    ancestors.push(current);
  }
  const owningScroller = ancestors.find(
    (ancestor) => ancestor.dataset.markdownScrollContainer === "true",
  );
  if (owningScroller) return owningScroller;
  return ancestors.find((ancestor) => {
    const overflowY = window.getComputedStyle(ancestor).overflowY;
    return /^(?:auto|scroll)$/u.test(overflowY)
      && ancestor.scrollHeight > ancestor.clientHeight + 1;
  }) ?? null;
}

export function alignMarkdownSourceLine(
  view: EditorView,
  lineNumber: number,
) {
  const target = view.dom.querySelector<HTMLElement>(
    `.cm-line[data-source-line-start="${lineNumber}"]`,
  );
  if (!target) return;
  const scrollContainer = nearestDocumentScrollContainer(target);
  if (scrollContainer) {
    if (
      scrollContainer.dataset.markdownScrollContainer === "true"
      && scrollContainer.clientHeight > 0
    ) {
      // Source-line navigation should be able to place even the final heading
      // at the top of its document viewport. The padding is visual scroll
      // space only and never enters the Markdown document.
      view.contentDOM.style.paddingBottom = `${scrollContainer.clientHeight}px`;
    }
    const targetRect = target.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    scrollContainer.scrollTop += targetRect.top - containerRect.top;
  }
  target.scrollIntoView?.({
    block: "start",
    inline: "nearest",
  });
}
