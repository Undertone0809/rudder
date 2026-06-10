export const ISSUE_FIND_MARK_SELECTOR = "mark[data-issue-find-highlight='true']";
export const ISSUE_FIND_CSS_HIGHLIGHT_NAME = "rudder-issue-find-highlight";
export const ISSUE_FIND_ACTIVE_CSS_HIGHLIGHT_NAME = "rudder-issue-find-highlight-active";

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
  mode?: "mark" | "css";
};

export type IssueFindMatch = HTMLElement | Range;

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

type CssHighlightRegistry = {
  set: (name: string, highlight: unknown) => void;
  delete: (name: string) => void;
};

type CssHighlightConstructor = new (...ranges: Range[]) => unknown;

function getCssHighlightApi(doc: Document) {
  const view = doc.defaultView as (Window & {
    CSS?: { highlights?: CssHighlightRegistry };
    Highlight?: CssHighlightConstructor;
  }) | null;
  if (!view?.CSS?.highlights || !view.Highlight) return null;
  return {
    Highlight: view.Highlight,
    highlights: view.CSS.highlights,
  };
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
  const cssHighlightApi = getCssHighlightApi(root.ownerDocument);
  cssHighlightApi?.highlights.delete(ISSUE_FIND_CSS_HIGHLIGHT_NAME);
  cssHighlightApi?.highlights.delete(ISSUE_FIND_ACTIVE_CSS_HIGHLIGHT_NAME);

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

type ShouldSearchTextNodeOptions = {
  canUseCssHighlights: boolean;
  mode: "mark" | "css";
  skipElement?: HTMLElement | null;
};

function isContentEditableElement(element: HTMLElement) {
  return element.isContentEditable || element.matches("[contenteditable='true']");
}

function shouldSearchTextNode(node: Text, options: ShouldSearchTextNodeOptions) {
  const parent = node.parentElement;
  if (!parent) return false;
  if (parent.closest(ISSUE_FIND_SKIP_SELECTOR)) return false;

  const activeElement = parent.ownerDocument.activeElement;
  const editableParent = parent.closest("[contenteditable='true']");

  if (editableParent && options.mode === "css" && !options.canUseCssHighlights) {
    return false;
  }

  if (options.skipElement?.contains(parent)) {
    const skipIsEditableRoot = isContentEditableElement(options.skipElement);
    if (!skipIsEditableRoot || !options.canUseCssHighlights) return false;
  }

  if (editableParent && activeElement instanceof Node && editableParent.contains(activeElement)) {
    return options.canUseCssHighlights;
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
  const cssHighlightApi = options.mode === "css" ? getCssHighlightApi(doc) : null;
  const canUseCssHighlights = Boolean(cssHighlightApi);
  const textNodes: Text[] = [];
  const walker = doc.createTreeWalker(
    root,
    nodeFilterValue(root, "SHOW_TEXT"),
    {
      acceptNode: (node) => shouldSearchTextNode(node as Text, {
        canUseCssHighlights,
        mode: options.mode ?? "mark",
        skipElement: options.skipElement,
      })
        ? nodeFilterValue(root, "FILTER_ACCEPT")
        : nodeFilterValue(root, "FILTER_REJECT"),
    },
  );

  let next = walker.nextNode();
  while (next) {
    textNodes.push(next as Text);
    next = walker.nextNode();
  }

  const marks: IssueFindMatch[] = [];
  const lowerQuery = query.toLocaleLowerCase();
  const queryLength = query.length;

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    const lowerText = text.toLocaleLowerCase();
    let fromIndex = 0;
    let matchIndex = lowerText.indexOf(lowerQuery, fromIndex);
    if (matchIndex === -1) continue;

    if (cssHighlightApi) {
      while (matchIndex !== -1) {
        const range = doc.createRange();
        range.setStart(textNode, matchIndex);
        range.setEnd(textNode, matchIndex + queryLength);
        marks.push(range);

        fromIndex = matchIndex + queryLength;
        matchIndex = lowerText.indexOf(lowerQuery, fromIndex);
      }
      continue;
    }

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

  if (cssHighlightApi && marks.length > 0) {
    const ranges = marks.filter((match): match is Range => match instanceof Range);
    cssHighlightApi.highlights.set(ISSUE_FIND_CSS_HIGHLIGHT_NAME, new cssHighlightApi.Highlight(...ranges));
  }

  return marks;
}

export function activateIssueFindMatch(matches: IssueFindMatch[], activeIndex: number): IssueFindMatch | null {
  let active: IssueFindMatch | null = null;
  const firstRange = matches.find((match): match is Range => match instanceof Range) ?? null;
  const cssDocument = firstRange?.startContainer.ownerDocument ?? null;
  const cssHighlightApi = cssDocument ? getCssHighlightApi(cssDocument) : null;

  if (cssHighlightApi) {
    const activeRange = matches[activeIndex] instanceof Range ? matches[activeIndex] as Range : null;
    if (activeRange) {
      cssHighlightApi.highlights.set(ISSUE_FIND_ACTIVE_CSS_HIGHLIGHT_NAME, new cssHighlightApi.Highlight(activeRange));
      active = activeRange;
    } else {
      cssHighlightApi.highlights.delete(ISSUE_FIND_ACTIVE_CSS_HIGHLIGHT_NAME);
    }
    return active;
  }

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!(match instanceof HTMLElement)) continue;
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

export function scrollIssueFindMatchIntoView(match: IssueFindMatch | null) {
  if (!match) return;
  if (match instanceof HTMLElement) {
    match.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
    return;
  }

  const parent = match.startContainer.parentNode;
  const element = parent instanceof HTMLElement ? parent : null;
  element?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "smooth" });
}
