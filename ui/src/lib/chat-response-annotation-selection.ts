import type {
  ChatInlineAnnotationSurface,
  ChatInlineAnnotationTranscriptKind,
} from "@rudderhq/shared";

export const CHAT_ANNOTATION_SOURCE_ATTRIBUTE = "data-chat-annotation-source";
export const CHAT_ANNOTATION_BLOCK_ATTRIBUTE = "data-chat-annotation-block";
export const CHAT_ANNOTATION_IGNORE_ATTRIBUTE = "data-chat-annotation-ignore";

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

function semanticVisibleText(node: Node): string {
  if (
    node instanceof Element
    && node.hasAttribute(CHAT_ANNOTATION_IGNORE_ATTRIBUTE)
  ) {
    return "";
  }
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";

  const content = Array.from(node.childNodes)
    .map((child) => semanticVisibleText(child))
    .join("");
  if (
    node instanceof HTMLElement
    && SEMANTIC_LINE_BREAK_ELEMENTS.has(node.tagName)
    && content.length > 0
  ) {
    return `${content}\n`;
  }
  return content;
}

function textWithoutIgnoredContent(fragment: DocumentFragment | HTMLElement) {
  const clone = fragment.cloneNode(true) as DocumentFragment | HTMLElement;
  return semanticVisibleText(clone).replace(/^\n+|\n+$/gu, "");
}

function textBeforeBoundary(root: HTMLElement, container: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return textWithoutIgnoredContent(range.cloneContents());
}

function selectedTextFromRange(range: Range) {
  return textWithoutIgnoredContent(range.cloneContents());
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

function renderedTextToSourceSpans(
  renderedText: string,
  source: string,
  sourceBase = 0,
) {
  const spans: SourceCharacterSpan[] = [];
  let sourceCursor = 0;
  for (let index = 0; index < renderedText.length; index += 1) {
    const character = renderedText[index]!;
    let sourceIndex = source.indexOf(character, sourceCursor);
    let sourceEnd = sourceIndex + 1;

    for (let entityIndex = source.indexOf("&", sourceCursor); entityIndex >= 0; entityIndex = source.indexOf("&", entityIndex + 1)) {
      if (sourceIndex >= 0 && entityIndex > sourceIndex) break;
      const entity = decodedEntityAt(source, entityIndex);
      if (!entity || entity.decoded !== character) continue;
      sourceIndex = entityIndex;
      sourceEnd = entityIndex + entity.length;
      break;
    }

    if (sourceIndex < 0) return null;
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
      return closestAttributeElement(node, CHAT_ANNOTATION_IGNORE_ATTRIBUTE)
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
  const renderedText = textWithoutIgnoredContent(candidate.element);
  const spans = renderedTextToSourceSpans(
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
  const renderedBefore = textBeforeBoundary(sourceElement, container, offset);
  if (renderedBefore === null) return null;
  const renderedText = textWithoutIgnoredContent(sourceElement);
  const spans = renderedTextToSourceSpans(
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

  const selectedText = selectedTextFromRange(range);
  if (!selectedText) return null;
  const beforeSelection = textBeforeBoundary(sourceRoot, range.startContainer, range.startOffset);
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
    const renderedText = textWithoutIgnoredContent(sourceRoot);
    const renderedSpans = renderedTextToSourceSpans(renderedText, input.source);
    if (!renderedSpans) return null;
    const renderedStart = beforeSelection.length;
    const renderedEnd = renderedStart + selectedText.length;
    if (renderedStart < 0 || renderedEnd > renderedSpans.length || renderedEnd <= renderedStart) return null;
    start ??= renderedSpans[renderedStart]?.start;
    end ??= renderedSpans[renderedEnd - 1]?.end;
  }
  if (start === undefined || end === undefined || end <= start) return null;
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
