import { parseSkillReference } from "./skill-reference";

function getSkillReferenceLabelFromElement(node: Node | null | undefined): string | null {
  if (!(node instanceof HTMLElement)) return null;

  const linkCandidate = node instanceof HTMLAnchorElement
    ? node
    : node.closest("a");
  const parsed = linkCandidate
    ? parseSkillReference(linkCandidate.getAttribute("href") ?? "", linkCandidate.textContent ?? "")
    : null;
  if (parsed) return parsed.label;

  if (node.dataset.skillToken === "true") {
    const label = node.textContent?.trim() ?? "";
    return label.length > 0 ? label : null;
  }

  return null;
}

function isSkillReferenceElement(node: Node | null | undefined): node is HTMLElement {
  return getSkillReferenceLabelFromElement(node) !== null;
}

function findSkillReferenceElementInDomSubtree(
  node: Node | null | undefined,
  direction: "backward" | "forward",
): HTMLElement | null {
  if (!node) return null;
  if (isSkillReferenceElement(node)) {
    return node;
  }

  const childNodes = Array.from(node.childNodes);
  const candidates = direction === "backward" ? childNodes.reverse() : childNodes;
  for (const child of candidates) {
    const match = findSkillReferenceElementInDomSubtree(child, direction);
    if (match) return match;
  }

  return null;
}

function findNearestNodeAcrossBoundaries(
  node: Node | null | undefined,
  direction: "backward" | "forward",
): Node | null {
  let current = node;
  while (current) {
    const sibling = direction === "backward" ? current.previousSibling : current.nextSibling;
    if (sibling) return sibling;
    current = current.parentNode;
  }
  return null;
}

export function findAdjacentSkillTokenElement(
  selection: Selection | null,
  direction: "backward" | "forward",
): HTMLElement | null {
  if (!selection || !selection.isCollapsed) return null;

  const anchorNode = selection.anchorNode;
  if (!anchorNode) return null;

  if (isSkillReferenceElement(anchorNode)) {
    return anchorNode;
  }

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const childIndex = direction === "backward" ? selection.anchorOffset - 1 : selection.anchorOffset;
    if (childIndex >= 0 && childIndex < anchorNode.childNodes.length) {
      const directMatch = findSkillReferenceElementInDomSubtree(anchorNode.childNodes[childIndex] ?? null, direction);
      if (directMatch) return directMatch;
    }

    return findSkillReferenceElementInDomSubtree(
      findNearestNodeAcrossBoundaries(anchorNode, direction),
      direction,
    );
  }

  if (anchorNode.nodeType === Node.TEXT_NODE) {
    const textContent = anchorNode.textContent ?? "";
    const isWhitespaceSentinel = textContent.length > 0 && textContent.trim().length === 0;

    if (direction === "backward" && selection.anchorOffset === 0) {
      const directMatch = findSkillReferenceElementInDomSubtree(anchorNode.previousSibling, direction);
      if (directMatch) return directMatch;
      return findSkillReferenceElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
    if (
      direction === "backward"
      && isWhitespaceSentinel
      && selection.anchorOffset === textContent.length
    ) {
      const directMatch = findSkillReferenceElementInDomSubtree(anchorNode.previousSibling, direction);
      if (directMatch) return directMatch;
      return findSkillReferenceElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
    if (
      direction === "forward"
      && selection.anchorOffset === textContent.length
    ) {
      const directMatch = findSkillReferenceElementInDomSubtree(anchorNode.nextSibling, direction);
      if (directMatch) return directMatch;
      return findSkillReferenceElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
  }

  return null;
}
