const pendingFilesByMutation = new Map<string, Map<string, File[]>>();

export function stageRunFeedbackPendingFiles(
  clientMutationId: string,
  annotationId: string,
  files: readonly File[],
) {
  if (files.length === 0) return;
  const byAnnotation = pendingFilesByMutation.get(clientMutationId) ?? new Map<string, File[]>();
  byAnnotation.set(annotationId, [...files]);
  pendingFilesByMutation.set(clientMutationId, byAnnotation);
}

export function consumeRunFeedbackPendingFiles(
  clientMutationId: string,
): Record<string, File[]> {
  const byAnnotation = pendingFilesByMutation.get(clientMutationId);
  if (!byAnnotation) return {};
  pendingFilesByMutation.delete(clientMutationId);
  return Object.fromEntries(
    Array.from(byAnnotation.entries(), ([annotationId, files]) => [annotationId, [...files]]),
  );
}
