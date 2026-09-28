import {
  DraftResponseAnnotationsPopover,
  ResponseAnnotationEditor,
} from "@/components/chat/ResponseAnnotations";
import {
  createChatResponseAnnotationState,
  responseAnnotationReducer,
  validateChatResponseAnnotationReplacement,
} from "@/lib/chat-response-annotations";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

type AnnotationState = ReturnType<typeof createChatResponseAnnotationState>;
type AnnotationAction = Parameters<typeof responseAnnotationReducer>[1];

export function SideChatResponseAnnotations({
  annotationState,
  dispatchAnnotation,
  annotationsExpanded,
  setAnnotationsExpanded,
  editingAnnotationId,
  setEditingAnnotationId,
  editingAnnotationAnchorRef,
  annotationDetailsChipRef,
}: {
  annotationState: AnnotationState;
  dispatchAnnotation: Dispatch<AnnotationAction>;
  annotationsExpanded: boolean;
  setAnnotationsExpanded: Dispatch<SetStateAction<boolean>>;
  editingAnnotationId: string | null;
  setEditingAnnotationId: Dispatch<SetStateAction<string | null>>;
  editingAnnotationAnchorRef: MutableRefObject<HTMLButtonElement | null>;
  annotationDetailsChipRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  if (annotationState.annotations.length === 0) return null;

  return (
    <div className="mb-3 flex flex-col items-start gap-2">
      <DraftResponseAnnotationsPopover
        annotations={annotationState.annotations}
        pendingFilesByAnnotationId={annotationState.pendingFilesByAnnotationId}
        open={annotationsExpanded}
        buttonRef={annotationDetailsChipRef}
        onOpenChange={(open) => {
          setAnnotationsExpanded(open);
          if (open) setEditingAnnotationId(null);
        }}
        onClear={() => {
          dispatchAnnotation({ type: "clear" });
          setAnnotationsExpanded(false);
          setEditingAnnotationId(null);
        }}
        onEdit={(annotation) => {
          editingAnnotationAnchorRef.current = annotationDetailsChipRef.current;
          setEditingAnnotationId(annotation.id);
        }}
        onDelete={(annotationId) => {
          dispatchAnnotation({ type: "delete", id: annotationId });
          if (annotationState.annotations.length === 1) setAnnotationsExpanded(false);
          setEditingAnnotationId((current) => current === annotationId ? null : current);
        }}
      />
      {editingAnnotationId ? (() => {
        const annotation = annotationState.annotations.find(
          (candidate) => candidate.id === editingAnnotationId,
        );
        if (!annotation) return null;
        const editorAnchor = editingAnnotationAnchorRef.current;
        const editorBoundary = editorAnchor?.closest<HTMLElement>(
          '[data-testid="side-chat-panel-view"]',
        ) ?? null;
        return (
          <ResponseAnnotationEditor
            annotation={annotation}
            ordinal={annotation.ordinal}
            pendingFiles={annotationState.pendingFilesByAnnotationId[annotation.id] ?? []}
            showSelectedTextContext
            anchorRect={editorAnchor?.getBoundingClientRect() ?? null}
            getAnchorRect={() => editorAnchor?.isConnected ? editorAnchor.getBoundingClientRect() : null}
            boundaryRect={editorBoundary?.getBoundingClientRect() ?? null}
            getBoundaryRect={() => editorBoundary?.isConnected ? editorBoundary.getBoundingClientRect() : null}
            returnFocusRef={editingAnnotationAnchorRef}
            validateSave={(changes) => validateChatResponseAnnotationReplacement(
              annotationState,
              annotation.id,
              {
                comment: changes.comment,
                attachmentIds: changes.attachmentIds,
                files: changes.pendingFiles,
              },
            )}
            onSave={({ comment, pendingFiles, attachmentIds }) => {
              dispatchAnnotation({
                type: "replaceDraft",
                id: annotation.id,
                comment,
                attachmentIds,
                files: pendingFiles,
              });
              setEditingAnnotationId(null);
            }}
            onCancel={() => setEditingAnnotationId(null)}
            onDelete={() => {
              dispatchAnnotation({ type: "delete", id: annotation.id });
              setEditingAnnotationId(null);
            }}
          />
        );
      })() : null}
    </div>
  );
}
