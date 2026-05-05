import { parseMentionChipHref, stripMentionChipLabelPrefix } from "./mention-chips";
import { parseSkillReference } from "./skill-reference";

export type AtomicInlineTokenKind = "mention" | "skill";

export interface AtomicInlineTokenElement {
  element: HTMLElement;
  href: string;
  kind: AtomicInlineTokenKind;
  label: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMarkdown(markdown: string) {
  return markdown.replace(/\r\n/g, "\n");
}

function cleanReferenceDeletionWhitespace(markdown: string) {
  return markdown
    .replace(/[ \t\u00A0]+\n/g, "\n")
    .replace(/\n[ \t\u00A0]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s\u00A0]+|[\s\u00A0]+$/g, "");
}

function getElementFromNode(node: Node | null | undefined): HTMLElement | null {
  if (node instanceof HTMLElement) return node;
  return node?.parentElement ?? null;
}

function readSkillToken(element: HTMLElement): AtomicInlineTokenElement | null {
  const linkCandidate = element instanceof HTMLAnchorElement
    ? element
    : element.closest("a");
  const linkHref = linkCandidate?.getAttribute("href") ?? "";
  const href = element.dataset.skillHref ?? linkHref;
  const label = element.textContent?.trim() ?? "";
  const parsed = parseSkillReference(href, label);
  if (!parsed) return null;

  return {
    element,
    href: parsed.href,
    kind: "skill",
    label: parsed.label,
  };
}

function readMentionToken(element: HTMLElement): AtomicInlineTokenElement | null {
  const linkCandidate = element instanceof HTMLAnchorElement
    ? element
    : element.closest("a");
  const href = element.dataset.mentionHref ?? linkCandidate?.getAttribute("href") ?? "";
  if (!parseMentionChipHref(href)) return null;

  const label = stripMentionChipLabelPrefix(element.textContent?.trim() ?? "");
  if (!label) return null;

  return {
    element,
    href,
    kind: "mention",
    label,
  };
}

export function readAtomicInlineTokenElement(
  node: Node | null | undefined,
): AtomicInlineTokenElement | null {
  const element = getElementFromNode(node);
  if (!element) return null;

  const candidate = element.closest("[data-skill-token='true'], [data-mention-kind], a");
  if (!(candidate instanceof HTMLElement)) return null;

  return readSkillToken(candidate) ?? readMentionToken(candidate);
}

function findAtomicInlineTokenElementInDomSubtree(
  node: Node | null | undefined,
  direction: "backward" | "forward",
): AtomicInlineTokenElement | null {
  const direct = readAtomicInlineTokenElement(node);
  if (direct) return direct;
  if (!node) return null;

  const childNodes = Array.from(node.childNodes);
  const candidates = direction === "backward" ? childNodes.reverse() : childNodes;
  for (const child of candidates) {
    const match = findAtomicInlineTokenElementInDomSubtree(child, direction);
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

export function findAdjacentAtomicInlineTokenElement(
  selection: Selection | null,
  direction: "backward" | "forward",
): AtomicInlineTokenElement | null {
  if (!selection || !selection.isCollapsed) return null;

  const anchorNode = selection.anchorNode;
  if (!anchorNode) return null;

  const direct = readAtomicInlineTokenElement(anchorNode);
  if (direct) return direct;

  if (anchorNode.nodeType === Node.ELEMENT_NODE) {
    const childIndex = direction === "backward" ? selection.anchorOffset - 1 : selection.anchorOffset;
    if (childIndex >= 0 && childIndex < anchorNode.childNodes.length) {
      const directMatch = findAtomicInlineTokenElementInDomSubtree(anchorNode.childNodes[childIndex] ?? null, direction);
      if (directMatch) return directMatch;
    }

    return findAtomicInlineTokenElementInDomSubtree(
      findNearestNodeAcrossBoundaries(anchorNode, direction),
      direction,
    );
  }

  if (anchorNode.nodeType === Node.TEXT_NODE) {
    const textContent = anchorNode.textContent ?? "";
    const isWhitespaceSentinel = textContent.length > 0 && textContent.trim().length === 0;

    if (direction === "backward" && selection.anchorOffset === 0) {
      const directMatch = findAtomicInlineTokenElementInDomSubtree(anchorNode.previousSibling, direction);
      if (directMatch) return directMatch;
      return findAtomicInlineTokenElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
    if (
      direction === "backward"
      && isWhitespaceSentinel
      && selection.anchorOffset === textContent.length
    ) {
      const directMatch = findAtomicInlineTokenElementInDomSubtree(anchorNode.previousSibling, direction);
      if (directMatch) return directMatch;
      return findAtomicInlineTokenElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
    if (
      direction === "forward"
      && selection.anchorOffset === textContent.length
    ) {
      const directMatch = findAtomicInlineTokenElementInDomSubtree(anchorNode.nextSibling, direction);
      if (directMatch) return directMatch;
      return findAtomicInlineTokenElementInDomSubtree(
        findNearestNodeAcrossBoundaries(anchorNode, direction),
        direction,
      );
    }
  }

  return null;
}

export function removeAtomicInlineTokenFromMarkdown(
  markdown: string,
  token: Pick<AtomicInlineTokenElement, "href" | "kind" | "label">,
) {
  const normalizedMarkdown = normalizeMarkdown(markdown);
  const tokenLabel = token.label.trim();
  const skillLabelPattern = tokenLabel.includes("/")
    ? escapeRegExp(tokenLabel)
    : String.raw`(?:[a-z0-9._-]+\/)*${escapeRegExp(tokenLabel)}`;
  const labelPattern = token.kind === "skill"
    ? String.raw`(?:\$)?${skillLabelPattern}`
    : String.raw`(?:@)?${escapeRegExp(tokenLabel)}`;
  const referencePattern = new RegExp(
    String.raw`\[${labelPattern}\]\(${escapeRegExp(token.href)}\)[ \t\u00A0]?`,
    "u",
  );
  const nextMarkdown = normalizedMarkdown.replace(referencePattern, "");
  if (nextMarkdown === normalizedMarkdown) return markdown;

  return cleanReferenceDeletionWhitespace(nextMarkdown);
}
