import {
  MAX_CHAT_INLINE_ANNOTATIONS,
  MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS,
  MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH,
  MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH,
  type ChatInlineAnnotationInput,
} from "@rudderhq/shared";

export type ChatResponseAnnotationDraft = ChatInlineAnnotationInput & {
  ordinal: number;
};

export type ChatResponseAnnotationState = {
  annotations: ChatResponseAnnotationDraft[];
  pendingFilesByAnnotationId: Record<string, File[]>;
};

export type ChatResponseAnnotationAction =
  | {
    type: "reset";
    annotations: ChatInlineAnnotationInput[];
    pendingFilesByAnnotationId?: Record<string, File[]>;
  }
  | { type: "add"; annotation: ChatInlineAnnotationInput; files?: File[] }
  | { type: "edit"; id: string; changes: Pick<ChatInlineAnnotationInput, "comment"> }
  | {
    type: "replaceDraft";
    id: string;
    comment: string | null;
    attachmentIds: string[];
    files: File[];
  }
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

function annotationTextLength(annotation: ChatInlineAnnotationInput) {
  return annotation.selectedText.length + (annotation.comment?.length ?? 0);
}

function validateChatResponseAnnotationState(
  annotations: readonly ChatInlineAnnotationInput[],
  pendingFileCount = 0,
) {
  if (annotations.length > MAX_CHAT_INLINE_ANNOTATIONS) {
    return `A message can include at most ${MAX_CHAT_INLINE_ANNOTATIONS} annotations.`;
  }
  const selectedTextTooLong = annotations.some(
    (annotation) => annotation.selectedText.length > MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH,
  );
  if (selectedTextTooLong) {
    return `Selected text cannot exceed ${MAX_CHAT_INLINE_ANNOTATION_SELECTED_TEXT_LENGTH.toLocaleString()} characters.`;
  }
  const commentTooLong = annotations.some(
    (annotation) => (annotation.comment?.length ?? 0) > MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH,
  );
  if (commentTooLong) {
    return `An annotation comment cannot exceed ${MAX_CHAT_INLINE_ANNOTATION_COMMENT_LENGTH.toLocaleString()} characters.`;
  }
  const totalTextLength = annotations.reduce(
    (total, annotation) => total + annotationTextLength(annotation),
    0,
  );
  if (totalTextLength > MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH) {
    return `Annotation text cannot exceed ${MAX_CHAT_INLINE_ANNOTATION_TOTAL_TEXT_LENGTH.toLocaleString()} characters in total.`;
  }
  const attachmentCount = pendingFileCount + annotations.reduce(
    (total, annotation) => total + (annotation.attachmentIds?.length ?? 0),
    0,
  );
  if (attachmentCount > MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS) {
    return `Annotations can include at most ${MAX_CHAT_INLINE_ANNOTATION_ATTACHMENTS} files.`;
  }
  return null;
}

export function validateChatResponseAnnotationAdd(
  state: ChatResponseAnnotationState,
  annotation: ChatInlineAnnotationInput,
) {
  return validateChatResponseAnnotationState(
    [...state.annotations, annotation],
    Object.values(state.pendingFilesByAnnotationId).reduce(
      (total, files) => total + files.length,
      0,
    ),
  );
}

export function responseAnnotationReducer(
  state: ChatResponseAnnotationState,
  action: ChatResponseAnnotationAction,
): ChatResponseAnnotationState {
  if (action.type === "reset") {
    return {
      ...createChatResponseAnnotationState(action.annotations),
      pendingFilesByAnnotationId: Object.fromEntries(
        Object.entries(action.pendingFilesByAnnotationId ?? {})
          .map(([id, files]) => [id, [...files]])
      ),
    };
  }

  if (action.type === "add") {
    const duplicate = state.annotations.some(
      (annotation) => annotationRangeKey(annotation) === annotationRangeKey(action.annotation),
    );
    if (duplicate) return state;
    if (validateChatResponseAnnotationState(
      [...state.annotations, action.annotation],
      Object.values(state.pendingFilesByAnnotationId).reduce(
        (total, files) => total + files.length,
        action.files?.length ?? 0,
      ),
    )) return state;
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
    const nextAnnotations = state.annotations.map((annotation) => (
      annotation.id === action.id
        ? { ...annotation, ...action.changes }
        : annotation
    ));
    if (validateChatResponseAnnotationState(
      nextAnnotations,
      Object.values(state.pendingFilesByAnnotationId).reduce(
        (total, files) => total + files.length,
        0,
      ),
    )) return state;
    return {
      ...state,
      annotations: nextAnnotations,
    };
  }

  if (action.type === "replaceDraft") {
    if (!state.annotations.some((annotation) => annotation.id === action.id)) return state;
    const nextAnnotations = state.annotations.map((annotation) => (
      annotation.id === action.id
        ? {
            ...annotation,
            comment: action.comment,
            attachmentIds: [...action.attachmentIds],
          }
        : annotation
    ));
    const nextFiles = {
      ...state.pendingFilesByAnnotationId,
      [action.id]: [...action.files],
    };
    if (action.files.length === 0) delete nextFiles[action.id];
    if (validateChatResponseAnnotationState(
      nextAnnotations,
      Object.values(nextFiles).reduce((total, files) => total + files.length, 0),
    )) return state;
    return {
      annotations: nextAnnotations,
      pendingFilesByAnnotationId: nextFiles,
    };
  }

  if (action.type === "addFiles") {
    if (!state.annotations.some((annotation) => annotation.id === action.id) || action.files.length === 0) {
      return state;
    }
    const nextFiles = {
      ...state.pendingFilesByAnnotationId,
      [action.id]: [
        ...(state.pendingFilesByAnnotationId[action.id] ?? []),
        ...action.files,
      ],
    };
    if (validateChatResponseAnnotationState(
      state.annotations,
      Object.values(nextFiles).reduce((total, files) => total + files.length, 0),
    )) return state;
    return {
      ...state,
      pendingFilesByAnnotationId: nextFiles,
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

export function chatResponseAnnotationsForDraft(
  state: ChatResponseAnnotationState,
): ChatInlineAnnotationInput[] {
  return state.annotations.map((annotation) => {
    const { ordinal: _ordinal, ...input } = annotation;
    return withoutRequestFileIndexes(input);
  });
}
