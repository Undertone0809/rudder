export const ISSUE_FIND_MARK_SELECTOR = "mark[data-issue-find-highlight='true']";

const ISSUE_FIND_SKIP_SELECTOR = [
  "[data-issue-find-ui]",
  "input",
  "textarea",
  "select",
  "script",
  "style",
  "noscript",
  "[aria-hidden='true']",
].join(",");

type HighlightIssueFindOptions = {
  skipElement?: HTMLElement | null;
};

const inactiveHighlightBackground = "color-mix(in oklab, #f4c430 62%, transparent)";
const activeHighlightBackground = "color-mix(in oklab, var(--accent-base) 58%, #f4c430)";
const activeHighlightShadow = "0 0 0 1px color-mix(in oklab, var(--accent-strong) 62%, transparent)";

function applyIssueFindMarkStyle(mark: HTMLElement) {
  mark.style.borderRadius = "2px";
  mark.style.background = inactiveHighlightBackground;
  mark.style.color = "inherit";
  mark.style.padding = "0 1px";
}

function nodeFilterValue(root: HTMLElement, key: "FILTER_ACCEPT" | "FILTER_REJECT" | "SHOW_TEXT") {
  return root.ownerDocument.defaultView?.NodeFilter[key] ?? (
    key === "FILTER_ACCEPT" ? 1 : key === "FILTER_REJECT" ? 2 : 4
  );
}

export function isEditableIssueFindTarget(target: EventTarget | null) {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
}

export function isIssueFindShortcut(event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "defaultPrevented">) {
  if (event.defaultPrevented) return false;
  if (event.key.toLowerCase() !== "f") return false;
  if (!event.metaKey && !event.ctrlKey) return false;
  return !event.altKey && !event.shiftKey;
}

export function clearIssueFindHighlights(root: HTMLElement) {
  const marks = Array.from(root.querySelectorAll(ISSUE_FIND_MARK_SELECTOR));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
    parent.normalize();
  }
}

function shouldSearchTextNode(node: Text, skipElement?: HTMLElement | null) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest(ISSUE_FIND_SKIP_SELECTOR)) return false;
  if (skipElement?.contains(parent)) return false;

  const activeElement = parent.ownerDocument.activeElement;
  const editableParent = parent.closest("[contenteditable='true']");
  if (editableParent && activeElement instanceof Node && editableParent.contains(activeElement)) {
    return false;
  }

  return Boolean(node.nodeValue?.trim());
}

export function highlightIssueFindMatches(
  root: HTMLElement,
  rawQuery: string,
  options: HighlightIssueFindOptions = {},
) {
  clearIssueFindHighlights(root);

  const query = rawQuery.trim();
  if (!query) return [];

  const doc = root.ownerDocument;
  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(
    root,
    nodeFilterValue(root, "SHOW_TEXT"),
    {
      acceptNode: (node) => shouldSearchTextNode(node as Text, options.skipElement)
        ? nodeFilterValue(root, "FILTER_ACCEPT")
        : nodeFilterValue(root, "FILTER_REJECT"),
    },
  );

  let next = walker.nextNode();
  while (next) {
    textNodes.push(next as Text);
    next = walker.nextNode();
  }

  const marks: HTMLElement[] = [];
  const lowerQuery = query.toLocaleLowerCase();
  const queryLength = query.length;

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    const lowerText = text.toLocaleLowerCase();
    let fromIndex = 0;
    let matchIndex = lowerText.indexOf(lowerQuery, fromIndex);
    if (matchIndex === -1) continue;

    const fragment = doc.createDocumentFragment();

    while (matchIndex !== -1) {
      if (matchIndex > fromIndex) {
        fragment.append(doc.createTextNode(text.slice(fromIndex, matchIndex)));
      }

      const mark = doc.createElement("mark");
      mark.dataset.issueFindHighlight = "true";
      mark.className = "issue-find-highlight";
      applyIssueFindMarkStyle(mark);
      mark.textContent = text.slice(matchIndex, matchIndex + queryLength);
      fragment.append(mark);
      marks.push(mark);

      fromIndex = matchIndex + queryLength;
      matchIndex = lowerText.indexOf(lowerQuery, fromIndex);
    }

    if (fromIndex < text.length) {
      fragment.append(doc.createTextNode(text.slice(fromIndex)));
    }

    textNode.replaceWith(fragment);
  }

  return marks;
}

export function activateIssueFindMatch(matches: HTMLElement[], activeIndex: number): HTMLElement | null {
  let active: HTMLElement | null = null;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const isActive = index === activeIndex;
    match.dataset.issueFindActive = isActive ? "true" : "false";
    match.classList.toggle("issue-find-highlight--active", isActive);
    match.style.background = isActive ? activeHighlightBackground : inactiveHighlightBackground;
    match.style.boxShadow = isActive ? activeHighlightShadow : "";
    if (isActive) {
      active = match;
    }
  }
  return active;
}
