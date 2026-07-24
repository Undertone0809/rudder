import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState, type MutableRefObject } from "react";
import { ApiError } from "../../api/client";
import { organizationsApi } from "../../api/orgs";
import { useToast } from "../../context/ToastContext";
import { ConditionalFileSaveQueue } from "../../lib/conditional-file-save-queue";
import { queryKeys } from "../../lib/queryKeys";
import {
  containsEmbeddedImageDataUrl,
  EMBEDDED_IMAGE_DATA_URL_ERROR,
} from "../../lib/workspace-document-policy";

export type WorkspaceFileSaveNotice = {
  filePath: string;
  status: "saving" | "error";
  error?: unknown;
};

interface UseWorkspaceFileSaveQueueOptions {
  organizationId: string | null;
  selectedFilePathRef: MutableRefObject<string | null>;
  syncedFileRef: MutableRefObject<{ filePath: string | null; content: string }>;
}

/**
 * Owns one organization's conditional Library writes. The caller is keyed by
 * organization, so delayed callbacks can update only that organization's cache
 * and cannot reuse a new organization's queue after a route transition.
 */
export function useWorkspaceFileSaveQueue({
  organizationId,
  selectedFilePathRef,
  syncedFileRef,
}: UseWorkspaceFileSaveQueueOptions) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [notices, setNotices] = useState(
    () => new Map<string, WorkspaceFileSaveNotice>(),
  );
  const queue = useMemo(() => new ConditionalFileSaveQueue({
    save: async (payload) => {
      if (!organizationId) throw new Error("No organization selected");
      if (containsEmbeddedImageDataUrl(payload.content)) {
        throw new Error(EMBEDDED_IMAGE_DATA_URL_ERROR);
      }
      return organizationsApi.updateWorkspaceFile(
        organizationId,
        payload.filePath,
        payload,
      );
    },
    savedContent: (detail, payload) => detail.content ?? payload.content,
    isConflict: (error) => error instanceof ApiError && error.status === 409,
    onSaving: ({ filePath }) => {
      setNotices((current) => new Map(current).set(filePath, {
        filePath,
        status: "saving",
      }));
    },
    onSaved: (detail, _payload, content) => {
      if (!organizationId) return;
      if (selectedFilePathRef.current === detail.filePath) {
        syncedFileRef.current = { filePath: detail.filePath, content };
      }
      setNotices((current) => {
        const next = new Map(current);
        next.delete(detail.filePath);
        return next;
      });
      queryClient.setQueryData(
        queryKeys.organizations.workspaceFile(organizationId, detail.filePath),
        detail,
      );
    },
    onError: ({ filePath, error }) => {
      setNotices((current) => new Map(current).set(filePath, {
        filePath,
        status: "error",
        error,
      }));
      pushToast({
        title: error instanceof ApiError && error.status === 409
          ? "Library file changed elsewhere"
          : "Could not save Library file",
        body: error instanceof Error ? error.message : EMBEDDED_IMAGE_DATA_URL_ERROR,
        tone: "error",
      });
    },
  }), [
    organizationId,
    pushToast,
    queryClient,
    selectedFilePathRef,
    syncedFileRef,
  ]);
  const clearNotice = useCallback((filePath: string) => {
    setNotices((current) => {
      const next = new Map(current);
      next.delete(filePath);
      return next;
    });
  }, []);

  return { clearNotice, notices, queue };
}
