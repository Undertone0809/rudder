import type {
  ChatInlineAnnotationSurface,
  ChatInlineAnnotationTranscriptKind,
} from "@rudderhq/shared";

export const CHAT_ANNOTATION_SOURCE_ATTRIBUTE = "data-chat-annotation-source";
export const CHAT_ANNOTATION_BLOCK_ATTRIBUTE = "data-chat-annotation-block";
export const CHAT_ANNOTATION_IGNORE_ATTRIBUTE = "data-chat-annotation-ignore";

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

function textWithoutIgnoredContent(fragment: DocumentFragment | HTMLElement) {
  const clone = fragment.cloneNode(true) as DocumentFragment | HTMLElement;
  if ("querySelectorAll" in clone) {
    clone.querySelectorAll(`[${CHAT_ANNOTATION_IGNORE_ATTRIBUTE}]`).forEach((node) => node.remove());
  }
  return clone.textContent ?? "";
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

function renderedTextToSourceOffsets(renderedText: string, source: string) {
  const offsets: number[] = [];
  let sourceCursor = 0;
  for (let index = 0; index < renderedText.length; index += 1) {
    const character = renderedText[index]!;
    const sourceIndex = source.indexOf(character, sourceCursor);
    if (sourceIndex < 0) return null;
    offsets.push(sourceIndex);
    sourceCursor = sourceIndex + 1;
  }
  return offsets;
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

  if (input.surface === "process_transcript") {
    const startBlock = closestAttributeElement(range.startContainer, CHAT_ANNOTATION_BLOCK_ATTRIBUTE);
    const endBlock = closestAttributeElement(range.endContainer, CHAT_ANNOTATION_BLOCK_ATTRIBUTE);
    if (!startBlock || startBlock !== endBlock) return null;
  }

  const selectedText = selectedTextFromRange(range);
  if (!selectedText) return null;
  const beforeSelection = textBeforeBoundary(sourceRoot, range.startContainer, range.startOffset);
  if (beforeSelection === null) return null;
  const renderedText = textWithoutIgnoredContent(sourceRoot);
  const renderedOffsets = renderedTextToSourceOffsets(renderedText, input.source);
  if (!renderedOffsets) return null;

  const renderedStart = beforeSelection.length;
  const renderedEnd = renderedStart + selectedText.length;
  if (renderedStart < 0 || renderedEnd > renderedOffsets.length || renderedEnd <= renderedStart) return null;
  const start = renderedOffsets[renderedStart];
  const finalCharacterOffset = renderedOffsets[renderedEnd - 1];
  if (start === undefined || finalCharacterOffset === undefined) return null;
  const end = finalCharacterOffset + 1;
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
