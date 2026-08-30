import type {
  ChatInlineAnnotationSurface,
  ChatInlineAnnotationTranscriptKind,
} from "@rudderhq/shared";
import { createMarkdownSourceBoundaryMap } from "@rudderhq/shared";

export const CHAT_ANNOTATION_SOURCE_ATTRIBUTE = "data-chat-annotation-source";
export const CHAT_ANNOTATION_BLOCK_ATTRIBUTE = "data-chat-annotation-block";
export const CHAT_ANNOTATION_IGNORE_ATTRIBUTE = "data-chat-annotation-ignore";
export const CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE = "data-chat-annotation-text-ignore";

const chatAnnotationSourceTextByRoot = new WeakMap<HTMLElement, string>();

export function registerChatAnnotationSourceText(
  sourceRoot: HTMLElement,
  source: string,
) {
  chatAnnotationSourceTextByRoot.set(sourceRoot, source);
}

export function readChatAnnotationSourceText(sourceRoot: HTMLElement) {
  return chatAnnotationSourceTextByRoot.get(sourceRoot) ?? null;
}

const KEYBOARD_RANGE_KEYS = new Set([
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "End",
  "Home",
]);

export function shouldAutoFocusChatAnnotationToolbar(event: Event) {
  return event instanceof KeyboardEvent
    && event.type === "keyup"
    && event.shiftKey
    && KEYBOARD_RANGE_KEYS.has(event.key);
}

export async function hashChatAnnotationSource(value: string) {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type AnnotationSelectionBase = {
  selectedText: string;
  sourceConversationId: string;
  sourceMessageId: string;
  sourceHash: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
};

export type ChatAnnotationSelectionAnchor =
  | (AnnotationSelectionBase & {
    surface: "assistant_body";
  })
  | (AnnotationSelectionBase & {
    surface: "process_transcript";
    transcriptKind: ChatInlineAnnotationTranscriptKind;
    generationId: string;
    generationSeqStart: number;
    generationSeqEnd: number;
  });

type ChatAnnotationRangeCommonInput = {
  range: Range;
  sourceRoot: HTMLElement;
  source: string;
  sourceHash: string;
  sourceConversationId: string;
  sourceMessageId: string;
  contextLength?: number;
};

export type ResolveChatAnnotationRangeInput =
  | (ChatAnnotationRangeCommonInput & {
    surface: Extract<ChatInlineAnnotationSurface, "assistant_body">;
  })
  | (ChatAnnotationRangeCommonInput & {
    surface: Extract<ChatInlineAnnotationSurface, "process_transcript">;
    transcriptKind: ChatInlineAnnotationTranscriptKind;
    generationId: string;
    generationSeqStart: number;
    generationSeqEnd: number;
  });

function closestAttributeElement(node: Node, attribute: string): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>(`[${attribute}]`) ?? null;
}

const SEMANTIC_LINE_BREAK_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DIV",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "LI",
  "MAIN",
  "NAV",
  "P",
  "PRE",
  "SECTION",
  "TR",
]);

const STRUCTURAL_MARKDOWN_ELEMENTS = new Set([
  ...SEMANTIC_LINE_BREAK_ELEMENTS,
  "OL",
  "TABLE",
  "TBODY",
  "THEAD",
  "UL",
]);

function isInterBlockFormattingWhitespace(node: Node, text: string) {
  if (!/^\s+$/u.test(text)) return false;
  const previous = node.previousSibling;
  const next = node.nextSibling;
  return (
    previous instanceof HTMLElement
    && STRUCTURAL_MARKDOWN_ELEMENTS.has(previous.tagName)
  ) || (
    next instanceof HTMLElement
    && STRUCTURAL_MARKDOWN_ELEMENTS.has(next.tagName)
  );
}

export type ChatAnnotationSemanticTextSpan = {
  node: Text;
  start: number;
  end: number;
};

function semanticVisibleText(
  node: Node,
  spans?: ChatAnnotationSemanticTextSpan[],
  cursor = { value: 0 },
): string {
  if (
    node instanceof Element
    && (
      node.hasAttribute(CHAT_ANNOTATION_IGNORE_ATTRIBUTE)
      || node.hasAttribute(CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE)
    )
  ) {
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // react-markdown may leave indentation text nodes between block elements.
    // They are not part of Markdown's rendered text and must not enter the
    // signed annotation selection sent to the server.
    if (isInterBlockFormattingWhitespace(node, text)) return "";
    if (text && spans) {
      spans.push({
        node: node as Text,
        start: cursor.value,
        end: cursor.value + text.length,
      });
    }
    cursor.value += text.length;
    return text;
  }
  if (node instanceof HTMLBRElement) {
    cursor.value += 1;
    return "\n";
  }

  const content = Array.from(node.childNodes)
    .map((child) => semanticVisibleText(child, spans, cursor))
    .join("");
  if (
    node instanceof HTMLElement
    && SEMANTIC_LINE_BREAK_ELEMENTS.has(node.tagName)
    && content.length > 0
  ) {
    cursor.value += 1;
    return `${content}\n`;
  }
  return content;
}

export function chatAnnotationSemanticText(fragment: DocumentFragment | HTMLElement) {
  const clone = fragment.cloneNode(true) as DocumentFragment | HTMLElement;
  return semanticVisibleText(clone).replace(/^\n+|\n+$/gu, "");
}

export function chatAnnotationSemanticTextWithTrailingBreaks(
  fragment: DocumentFragment | HTMLElement,
) {
  const clone = fragment.cloneNode(true) as DocumentFragment | HTMLElement;
  return semanticVisibleText(clone).replace(/^\n+/gu, "");
}

export function chatAnnotationSemanticTextSpans(root: HTMLElement) {
  const spans: ChatAnnotationSemanticTextSpan[] = [];
  const rawText = semanticVisibleText(root, spans);
  const leadingBreaks = rawText.match(/^\n+/u)?.[0].length ?? 0;
  const semanticLength = rawText.replace(/^\n+|\n+$/gu, "").length;
  return spans
    .map((span) => ({
      ...span,
      start: span.start - leadingBreaks,
      end: span.end - leadingBreaks,
    }))
    .filter((span) => span.end > 0 && span.start < semanticLength)
    .map((span) => ({
      ...span,
      start: Math.max(0, span.start),
      end: Math.min(semanticLength, span.end),
    }));
}

export function chatAnnotationSemanticOffsetForBoundary(
  root: HTMLElement,
  container: Node,
  offset: number,
) {
  const spans = chatAnnotationSemanticTextSpans(root);
  if (container.nodeType === Node.TEXT_NODE) {
    const span = spans.find((candidate) => candidate.node === container);
    return span
      ? Math.max(span.start, Math.min(span.end, span.start + offset))
      : null;
  }
  if (!(container instanceof Element || container instanceof DocumentFragment)) {
    return null;
  }
  const child = container.childNodes[offset] ?? null;
  if (child) {
    const next = spans.find((span) => child === span.node || child.contains(span.node));
    if (next) return next.start;
  }
  const previous = offset > 0 ? container.childNodes[offset - 1] ?? null : null;
  if (previous) {
    const prior = [...spans].reverse()
      .find((span) => previous === span.node || previous.contains(span.node));
    if (prior) return prior.end;
  }
  if (container === root && offset === 0) return 0;
  if (container === root && offset === root.childNodes.length) {
    return chatAnnotationSemanticText(root).length;
  }
  return null;
}

export function chatAnnotationSemanticTextBeforeBoundary(
  root: HTMLElement,
  container: Node,
  offset: number,
) {
  const semanticOffset = chatAnnotationSemanticOffsetForBoundary(root, container, offset);
  if (semanticOffset !== null) {
    return chatAnnotationSemanticText(root).slice(0, semanticOffset);
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return chatAnnotationSemanticText(range.cloneContents());
}

export function chatAnnotationSemanticSelectedText(range: Range) {
  return chatAnnotationSemanticText(range.cloneContents());
}

type SourceCharacterSpan = { start: number; end: number };
type DomBoundary = { container: Node; offset: number };

function decodedEntityAt(source: string, index: number) {
  if (source[index] !== "&") return null;
  const candidate = source.slice(index).match(/^&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/u)?.[0];
  if (!candidate || typeof document === "undefined") return null;
  const textarea = document.createElement("textarea");
  textarea.innerHTML = candidate;
  const decoded = textarea.value;
  return decoded.length === 1 ? { decoded, length: candidate.length } : null;
}

function markdownVisibleSourceMask(source: string) {
  const visible = Array<boolean>(source.length).fill(true);
  const hide = (start: number, end: number) => {
    for (let index = start; index < end; index += 1) visible[index] = false;
  };
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\[[^\]\n]*\]/gu)) {
    const value = match[0];
    const start = match.index;
    const labelEnd = value.indexOf("]");
    if (value.startsWith("!")) hide(start, start + value.length);
    else {
      hide(start, start + 1);
      if (labelEnd >= 0) hide(start + labelEnd, start + value.length);
    }
  }
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\((?:\\.|[^)\n])*\)/gu)) {
    const value = match[0];
    const start = match.index;
    const labelEnd = value.indexOf("]");
    if (labelEnd >= 0) hide(start + labelEnd, start + value.length);
    hide(start, start + (value.startsWith("!") ? 2 : 1));
  }
  for (const match of source.matchAll(/!\[[^\]\n]*\](?![\[(])/gu)) {
    hide(match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(/^[\t ]*\[[^\]\n]+\]:[^\n]*$/gmu)) {
    hide(match.index, match.index + match[0].length);
  }
  for (const match of source.matchAll(/<\/?[a-zA-Z][^>\n]*>/gu)) {
    hide(match.index, match.index + match[0].length);
  }
  return visible;
}

export function chatAnnotationRenderedTextToSourceSpans(
  renderedText: string,
  source: string,
  sourceBase = 0,
) {
  const spans: SourceCharacterSpan[] = [];
  const boundaryMap = createMarkdownSourceBoundaryMap(source, renderedText);
  const visibleSource = markdownVisibleSourceMask(source);
  let sourceCursor = 0;
  for (let index = 0; index < renderedText.length; index += 1) {
    const character = renderedText[index]!;
    const preferredSourceIndex = Math.max(
      sourceCursor,
      boundaryMap.renderedBoundaryToRaw[index + 1]! - 1,
    );
    let sourceIndex = -1;
    let sourceEnd = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    const consider = (candidateStart: number, candidateEnd: number) => {
      const distance = Math.abs(candidateStart - preferredSourceIndex);
      if (
        distance < bestDistance
        || (
          distance === bestDistance
          && (
            candidateStart > sourceIndex
            || (candidateStart === sourceIndex && candidateEnd > sourceEnd)
          )
        )
      ) {
        sourceIndex = candidateStart;
        sourceEnd = candidateEnd;
        bestDistance = distance;
      }
    };

    for (
      let literalIndex = source.indexOf(character, sourceCursor);
      literalIndex >= 0;
      literalIndex = source.indexOf(character, literalIndex + 1)
    ) {
      if (visibleSource[literalIndex]) {
        consider(literalIndex, literalIndex + 1);
        if (literalIndex >= preferredSourceIndex) break;
      }
    }
    for (
      let entityIndex = source.indexOf("&", sourceCursor);
      entityIndex >= 0;
      entityIndex = source.indexOf("&", entityIndex + 1)
    ) {
      const entity = decodedEntityAt(source, entityIndex);
      if (visibleSource[entityIndex] && entity?.decoded === character) {
        consider(entityIndex, entityIndex + entity.length);
        if (entityIndex >= preferredSourceIndex) break;
      }
    }

    if (sourceIndex < 0) {
      return Array.from({ length: renderedText.length }, (_, renderedIndex) => ({
        start: sourceBase + boundaryMap.renderedBoundaryToRaw[renderedIndex]!,
        end: sourceBase + boundaryMap.renderedBoundaryToRaw[renderedIndex + 1]!,
      }));
    }
    spans.push({
      start: sourceBase + sourceIndex,
      end: sourceBase + sourceEnd,
    });
    sourceCursor = sourceEnd;
  }
  return spans;
}

function closestMarkdownSourceElement(node: Node, sourceRoot: HTMLElement) {
  const element = node instanceof HTMLElement ? node : node.parentElement;
  const sourceElement = element?.closest<HTMLElement>(
    "[data-markdown-source-start][data-markdown-source-end]",
  ) ?? null;
  return sourceElement && sourceRoot.contains(sourceElement) ? sourceElement : null;
}

function sourceBoundsForElement(element: HTMLElement, sourceLength: number) {
  const start = Number(element.dataset.markdownSourceStart);
  const end = Number(element.dataset.markdownSourceEnd);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > sourceLength) {
    return null;
  }
  return { start, end };
}

function visibleTextBoundaryAtOffset(
  root: HTMLElement,
  visibleOffset: number,
  edge: "start" | "end",
): DomBoundary | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return (
        closestAttributeElement(node, CHAT_ANNOTATION_IGNORE_ATTRIBUTE)
        || closestAttributeElement(node, CHAT_ANNOTATION_TEXT_IGNORE_ATTRIBUTE)
      )
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let remaining = visibleOffset;
  let lastText: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    lastText = text;
    const length = text.data.length;
    if (remaining < length || (remaining === length && edge === "end")) {
      return { container: text, offset: remaining };
    }
    remaining -= length;
  }
  if (remaining === 0 && lastText) {
    return { container: lastText, offset: lastText.data.length };
  }
  return null;
}

function sourceElementForOffset(
  sourceRoot: HTMLElement,
  sourceLength: number,
  offset: number,
  edge: "start" | "end",
) {
  const candidates = Array.from(
    sourceRoot.querySelectorAll<HTMLElement>(
      "[data-markdown-source-start][data-markdown-source-end]",
    ),
  ).map((element) => ({
    element,
    bounds: sourceBoundsForElement(element, sourceLength),
  })).filter((candidate): candidate is {
    element: HTMLElement;
    bounds: { start: number; end: number };
  } => Boolean(candidate.bounds))
    .filter(({ bounds }) => (
      edge === "start"
        ? bounds.start <= offset && offset < bounds.end
        : bounds.start < offset && offset <= bounds.end
    ))
    .sort((left, right) => (
      (left.bounds.end - left.bounds.start) - (right.bounds.end - right.bounds.start)
    ));
  return candidates[0] ?? null;
}

function domBoundaryForSourceOffset(
  sourceRoot: HTMLElement,
  source: string,
  sourceOffset: number,
  edge: "start" | "end",
) {
  const candidate = sourceElementForOffset(
    sourceRoot,
    source.length,
    sourceOffset,
    edge,
  );
  if (!candidate) return null;
  const renderedText = chatAnnotationSemanticText(candidate.element);
  const spans = chatAnnotationRenderedTextToSourceSpans(
    renderedText,
    source.slice(candidate.bounds.start, candidate.bounds.end),
    candidate.bounds.start,
  );
  if (!spans) return null;
  const renderedOffset = edge === "start"
    ? spans.findIndex((span) => span.end > sourceOffset)
    : spans.findLastIndex((span) => span.start < sourceOffset) + 1;
  if (renderedOffset < 0) return null;
  return visibleTextBoundaryAtOffset(candidate.element, renderedOffset, edge);
}

export function restoreChatAnnotationRange(input: {
  sourceRoot: HTMLElement;
  source: string;
  start: number;
  end: number;
}) {
  if (input.start < 0 || input.end <= input.start || input.end > input.source.length) {
    return null;
  }
  const start = domBoundaryForSourceOffset(
    input.sourceRoot,
    input.source,
    input.start,
    "start",
  );
  const end = domBoundaryForSourceOffset(
    input.sourceRoot,
    input.source,
    input.end,
    "end",
  );
  if (!start || !end) return null;
  const range = document.createRange();
  try {
    range.setStart(start.container, start.offset);
    range.setEnd(end.container, end.offset);
  } catch {
    return null;
  }
  return range.collapsed ? null : range;
}

export function findChatAnnotationSourceRoot(
  anchor: ChatAnnotationSelectionAnchor,
  searchRoot: ParentNode = document,
) {
  const candidates = Array.from(
    searchRoot.querySelectorAll<HTMLElement>(`[${CHAT_ANNOTATION_SOURCE_ATTRIBUTE}]`),
  );
  return candidates.find((candidate) => {
    if (
      !candidate.isConnected
      || candidate.dataset.messageId !== anchor.sourceMessageId
      || candidate.dataset.annotationSurface !== anchor.surface
    ) {
      return false;
    }
    if (anchor.surface === "assistant_body") return true;
    return candidate.dataset.transcriptKind === anchor.transcriptKind
      && candidate.dataset.generationId === anchor.generationId
      && Number(candidate.dataset.generationSeqStart) === anchor.generationSeqStart
      && Number(candidate.dataset.generationSeqEnd) === anchor.generationSeqEnd;
  }) ?? null;
}

export function restoreLiveChatAnnotationRange(input: {
  anchor: ChatAnnotationSelectionAnchor;
  source: string;
  searchRoot?: ParentNode;
}) {
  const sourceRoot = findChatAnnotationSourceRoot(
    input.anchor,
    input.searchRoot,
  );
  if (!sourceRoot) return null;
  const range = restoreChatAnnotationRange({
    sourceRoot,
    source: input.source,
    start: input.anchor.start,
    end: input.anchor.end,
  });
  return range ? { range, sourceRoot } : null;
}

function sourceOffsetForBoundary(
  sourceRoot: HTMLElement,
  source: string,
  container: Node,
  offset: number,
  edge: "start" | "end",
) {
  const sourceElement = closestMarkdownSourceElement(container, sourceRoot);
  if (!sourceElement) return null;
  const bounds = sourceBoundsForElement(sourceElement, source.length);
  if (!bounds) return null;
  const renderedBefore = chatAnnotationSemanticTextBeforeBoundary(sourceElement, container, offset);
  if (renderedBefore === null) return null;
  const renderedText = chatAnnotationSemanticText(sourceElement);
  const spans = chatAnnotationRenderedTextToSourceSpans(
    renderedText,
    source.slice(bounds.start, bounds.end),
    bounds.start,
  );
  if (!spans) return null;
  if (edge === "start") {
    return renderedBefore.length === spans.length
      ? bounds.end
      : spans[renderedBefore.length]?.start ?? null;
  }
  return renderedBefore.length === 0
    ? bounds.start
    : spans[renderedBefore.length - 1]?.end ?? null;
}

export function resolveChatAnnotationRange(
  input: ResolveChatAnnotationRangeInput,
): ChatAnnotationSelectionAnchor | null {
  const { range, sourceRoot } = input;
  if (range.collapsed || !sourceRoot.contains(range.startContainer) || !sourceRoot.contains(range.endContainer)) {
    return null;
  }

  const expectedSource = sourceRoot.getAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE);
  const startSource = closestAttributeElement(range.startContainer, CHAT_ANNOTATION_SOURCE_ATTRIBUTE);
  const endSource = closestAttributeElement(range.endContainer, CHAT_ANNOTATION_SOURCE_ATTRIBUTE);
  if (!expectedSource || startSource !== sourceRoot || endSource !== sourceRoot) return null;
  const intersectsIgnoredContent = Array.from(
    sourceRoot.querySelectorAll(`[${CHAT_ANNOTATION_IGNORE_ATTRIBUTE}]`),
  ).some((node) => {
    try {
      return range.intersectsNode(node);
    } catch {
      return false;
    }
  });
  if (intersectsIgnoredContent) return null;

  if (input.surface === "process_transcript") {
    const startBlock = closestAttributeElement(range.startContainer, CHAT_ANNOTATION_BLOCK_ATTRIBUTE);
    const endBlock = closestAttributeElement(range.endContainer, CHAT_ANNOTATION_BLOCK_ATTRIBUTE);
    if (!startBlock || startBlock !== endBlock) return null;
  }

  const selectedText = chatAnnotationSemanticSelectedText(range);
  if (!selectedText) return null;
  const beforeSelection = chatAnnotationSemanticTextBeforeBoundary(
    sourceRoot,
    range.startContainer,
    range.startOffset,
  );
  if (beforeSelection === null) return null;
  const elementStart = sourceOffsetForBoundary(
    sourceRoot,
    input.source,
    range.startContainer,
    range.startOffset,
    "start",
  );
  const elementEnd = sourceOffsetForBoundary(
    sourceRoot,
    input.source,
    range.endContainer,
    range.endOffset,
    "end",
  );
  let start = elementStart ?? undefined;
  let end = elementEnd ?? undefined;
  if (start === undefined || end === undefined) {
    const renderedText = chatAnnotationSemanticText(sourceRoot);
    const renderedSpans = chatAnnotationRenderedTextToSourceSpans(renderedText, input.source);
    if (!renderedSpans) return null;
    const renderedStart = beforeSelection.length;
    const renderedEnd = renderedStart + selectedText.length;
    if (renderedStart < 0 || renderedEnd > renderedSpans.length || renderedEnd <= renderedStart) return null;
    start ??= renderedSpans[renderedStart]?.start;
    end ??= renderedSpans[renderedEnd - 1]?.end;
  }
  if (start === undefined || end === undefined || end <= start) return null;
  // Soft Markdown line breaks render as inter-word spacing inside one paragraph.
  // A DOM boundary at the first character after that spacing can map back to the
  // preceding raw newline. Keep the canonical range aligned to what the user
  // actually selected so server-side rendered-text validation sees the same
  // leading character.
  while (
    start < end
    && /\p{White_Space}/u.test(input.source[start] ?? "")
    && !selectedText.startsWith(input.source[start] ?? "")
  ) {
    start += 1;
  }
  // A DOM range ending at the next block starts after the visual block break,
  // while the semantic selection text intentionally omits that trailing break.
  while (
    end > start
    && /\p{White_Space}/u.test(input.source[end - 1] ?? "")
    && !selectedText.endsWith(input.source[end - 1] ?? "")
  ) {
    end -= 1;
  }
  const contextLength = Math.min(160, Math.max(0, input.contextLength ?? 160));
  const common = {
    selectedText,
    sourceConversationId: input.sourceConversationId,
    sourceMessageId: input.sourceMessageId,
    sourceHash: input.sourceHash,
    start,
    end,
    prefix: input.source.slice(Math.max(0, start - contextLength), start),
    suffix: input.source.slice(end, end + contextLength),
  };

  if (input.surface === "process_transcript") {
    return {
      ...common,
      surface: input.surface,
      transcriptKind: input.transcriptKind,
      generationId: input.generationId,
      generationSeqStart: input.generationSeqStart,
      generationSeqEnd: input.generationSeqEnd,
    };
  }

  return { ...common, surface: input.surface };
}
