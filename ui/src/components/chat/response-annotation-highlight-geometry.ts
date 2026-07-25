import {
  CHAT_ANNOTATION_IGNORE_ATTRIBUTE,
  CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE,
} from "@/lib/chat-response-annotation-selection";

function clipAnnotationRectToScrollableAncestors(
  rect: DOMRect,
  startElement: Element | null,
  sourceRoot: HTMLElement,
): DOMRect | null {
  let left = rect.left;
  let right = rect.right;
  let top = rect.top;
  let bottom = rect.bottom;
  let element = startElement;

  while (element && sourceRoot.contains(element)) {
    const style = window.getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    const clipsX = /^(auto|clip|hidden|scroll)$/u.test(style.overflowX);
    const clipsY = /^(auto|clip|hidden|scroll)$/u.test(style.overflowY);
    if (clipsX) {
      left = Math.max(left, bounds.left);
      right = Math.min(right, bounds.right);
    }
    if (clipsY) {
      top = Math.max(top, bounds.top);
      bottom = Math.min(bottom, bounds.bottom);
    }
    if (right <= left || bottom <= top) return null;
    if (element === sourceRoot) break;
    element = element.parentElement;
  }

  return DOMRect.fromRect({
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  });
}

export function collectResponseAnnotationTextRects(
  sourceRoot: HTMLElement,
): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !node.textContent
      || parent?.closest(`[${CHAT_ANNOTATION_IGNORE_ATTRIBUTE}]`)
      || parent?.closest(`[${CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE}]`)
    ) {
      continue;
    }
    const range = document.createRange();
    range.selectNodeContents(node);
    const nodeRects = typeof range.getClientRects === "function"
      ? Array.from(range.getClientRects())
      : [];
    rects.push(...nodeRects
      .map((rect) => clipAnnotationRectToScrollableAncestors(
        rect,
        parent,
        sourceRoot,
      ))
      .filter((rect): rect is DOMRect => Boolean(rect)));
  }
  return rects;
}

export function collectVisibleAnnotationRangeRects(
  sourceRoot: HTMLElement,
  sourceRange: Range,
): DOMRect[] {
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(sourceRoot, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (
      !node.textContent
      || !parent
      || parent.closest(`[${CHAT_ANNOTATION_IGNORE_ATTRIBUTE}]`)
      || parent.closest(`[${CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE}]`)
      || !sourceRange.intersectsNode(node)
    ) {
      continue;
    }
    const nodeRange = document.createRange();
    nodeRange.setStart(
      node,
      node === sourceRange.startContainer ? sourceRange.startOffset : 0,
    );
    nodeRange.setEnd(
      node,
      node === sourceRange.endContainer
        ? sourceRange.endOffset
        : node.textContent.length,
    );
    if (nodeRange.collapsed) continue;
    const nodeRects = typeof nodeRange.getClientRects === "function"
      ? Array.from(nodeRange.getClientRects())
      : [];
    rects.push(...nodeRects
      .map((rect) => clipAnnotationRectToScrollableAncestors(
        rect,
        parent,
        sourceRoot,
      ))
      .filter((rect): rect is DOMRect => Boolean(rect)));
  }
  return rects;
}
