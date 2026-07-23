import type { ChatInlineAnnotationInput } from "@rudderhq/shared";

export type ChatResponseAnnotationDraft = ChatInlineAnnotationInput & {
  ordinal: number;
};

export type ChatResponseAnnotationState = {
  annotations: ChatResponseAnnotationDraft[];
  pendingFilesByAnnotationId: Record<string, File[]>;
};

export type ChatResponseAnnotationAction =
  | { type: "add"; annotation: ChatInlineAnnotationInput; files?: File[] }
  | { type: "edit"; id: string; changes: Pick<ChatInlineAnnotationInput, "comment"> }
  | { type: "delete"; id: string }
  | { type: "clear" }
  | { type: "addFiles"; id: string; files: File[] }
  | { type: "removeFile"; id: string; fileIndex: number };

function withoutRequestFileIndexes(
  annotation: ChatInlineAnnotationInput,
): ChatInlineAnnotationInput {
  const { attachmentFileIndexes: _attachmentFileIndexes, ...persistable } = annotation;
  return persistable;
}

function withOrdinals(
  annotations: readonly ChatInlineAnnotationInput[],
): ChatResponseAnnotationDraft[] {
  return annotations.map((annotation, index) => ({
    ...withoutRequestFileIndexes(annotation),
    ordinal: index + 1,
  }));
}

function annotationRangeKey(annotation: ChatInlineAnnotationInput) {
  const generationKey = annotation.surface === "process_transcript"
    ? `${annotation.generationId}:${annotation.generationSeqStart}:${annotation.generationSeqEnd}`
    : "";
  return [
    annotation.sourceConversationId,
    annotation.sourceMessageId,
    annotation.surface,
    generationKey,
    annotation.sourceHash,
    annotation.start,
    annotation.end,
  ].join(":");
}

export function createChatResponseAnnotationState(
  annotations: readonly ChatInlineAnnotationInput[] = [],
): ChatResponseAnnotationState {
  return {
    annotations: withOrdinals(annotations),
    pendingFilesByAnnotationId: {},
  };
}

export function responseAnnotationReducer(
  state: ChatResponseAnnotationState,
  action: ChatResponseAnnotationAction,
): ChatResponseAnnotationState {
  if (action.type === "add") {
    const duplicate = state.annotations.some(
      (annotation) => annotationRangeKey(annotation) === annotationRangeKey(action.annotation),
    );
    if (duplicate) return state;
    const annotation = {
      ...withoutRequestFileIndexes(action.annotation),
      ordinal: state.annotations.length + 1,
    };
    return {
      annotations: [...state.annotations, annotation],
      pendingFilesByAnnotationId: action.files?.length
        ? { ...state.pendingFilesByAnnotationId, [annotation.id]: [...action.files] }
        : state.pendingFilesByAnnotationId,
    };
  }

  if (action.type === "edit") {
    return {
      ...state,
      annotations: state.annotations.map((annotation) => (
        annotation.id === action.id
          ? { ...annotation, ...action.changes }
          : annotation
      )),
    };
  }

  if (action.type === "addFiles") {
    if (!state.annotations.some((annotation) => annotation.id === action.id) || action.files.length === 0) {
      return state;
    }
    return {
      ...state,
      pendingFilesByAnnotationId: {
        ...state.pendingFilesByAnnotationId,
        [action.id]: [
          ...(state.pendingFilesByAnnotationId[action.id] ?? []),
          ...action.files,
        ],
      },
    };
  }

  if (action.type === "removeFile") {
    const current = state.pendingFilesByAnnotationId[action.id] ?? [];
    if (action.fileIndex < 0 || action.fileIndex >= current.length) return state;
    const remaining = current.filter((_, index) => index !== action.fileIndex);
    const nextFiles = { ...state.pendingFilesByAnnotationId };
    if (remaining.length > 0) {
      nextFiles[action.id] = remaining;
    } else {
      delete nextFiles[action.id];
    }
    return { ...state, pendingFilesByAnnotationId: nextFiles };
  }

  if (action.type === "delete") {
    if (!state.annotations.some((annotation) => annotation.id === action.id)) return state;
    const nextFiles = { ...state.pendingFilesByAnnotationId };
    delete nextFiles[action.id];
    return {
      annotations: withOrdinals(state.annotations.filter((annotation) => annotation.id !== action.id)),
      pendingFilesByAnnotationId: nextFiles,
    };
  }

  return createChatResponseAnnotationState();
}

export function canSubmitChatResponseAnnotations(
  body: string,
  state: ChatResponseAnnotationState,
) {
  return body.trim().length > 0 || state.annotations.length > 0;
}

export function serializeChatResponseAnnotations(
  state: ChatResponseAnnotationState,
  options: { fileIndexOffset?: number } = {},
): {
  inlineAnnotations: ChatInlineAnnotationInput[];
  files: File[];
} {
  const files: File[] = [];
  const fileIndexOffset = options.fileIndexOffset ?? 0;
  const inlineAnnotations = state.annotations.map((annotation) => {
    const { ordinal: _ordinal, ...input } = annotation;
    const ownedFiles = state.pendingFilesByAnnotationId[annotation.id] ?? [];
    const attachmentFileIndexes = ownedFiles.map(
      (_, index) => fileIndexOffset + files.length + index,
    );
    files.push(...ownedFiles);
    return attachmentFileIndexes.length > 0
      ? { ...input, attachmentFileIndexes }
      : input;
  });

  return { inlineAnnotations, files };
}
