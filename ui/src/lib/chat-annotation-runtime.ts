import type { DevServerHealthStatus } from "@/api/health";
import type { ToastInput } from "@/context/ToastContext";
import { readDesktopShell } from "@/lib/desktop-shell";
import type { ChatInlineAnnotationInput } from "@rudderhq/shared";

export const ANNOTATION_RUNTIME_RESTART_TOAST_ID = "dev-restart-required";
export type AnnotationDraftPersistence = "durable" | "memory";

export function resolveAnnotationDraftPersistence({
  explicit,
  pendingFileCount,
}: {
  explicit?: AnnotationDraftPersistence;
  pendingFileCount: number;
}): AnnotationDraftPersistence {
  return explicit ?? (pendingFileCount > 0 ? "memory" : "durable");
}

export function blockStaleAnnotationSubmission({
  annotations,
  devServer,
  draftPersistence = "durable",
  pushToast,
}: {
  annotations: ChatInlineAnnotationInput[];
  devServer: DevServerHealthStatus | undefined;
  draftPersistence?: AnnotationDraftPersistence;
  pushToast: (input: ToastInput) => string | null;
}) {
  if (
    annotations.length === 0
    || !devServer?.enabled
    || !devServer.restartRequired
  ) return false;

  const desktopShell = readDesktopShell();
  const canRestartImmediately = draftPersistence === "durable" && desktopShell;
  pushToast({
    id: ANNOTATION_RUNTIME_RESTART_TOAST_ID,
    dedupeKey: `${ANNOTATION_RUNTIME_RESTART_TOAST_ID}:${Date.now()}:${Math.random()}`,
    title: "Restart Rudder to send annotations",
    body: draftPersistence === "memory"
      ? "Your draft is still open in this window. Copy it before restarting Rudder."
      : desktopShell
        ? "Your message and annotations are saved. Rudder's local server is still running older code."
      : "Your message and annotations are saved. Restart pnpm dev, then send again.",
    tone: "warn",
    persistent: true,
    ...(canRestartImmediately
      ? {
        action: {
          label: "Restart Rudder",
          onClick: async () => {
            try {
              await desktopShell.restart();
            } catch (error) {
              pushToast({
                title: "Could not restart Rudder",
                body: error instanceof Error ? error.message : "Try restarting Rudder manually.",
                tone: "error",
              });
              throw error;
            }
          },
        },
      }
      : {}),
  });
  return true;
}
