import type { ChatInlineAnnotationInput } from "@rudderhq/shared";

export const CHAT_FILE_ANNOTATION_REQUEST_EVENT = "rudder:chat-file-annotation-request";
export const CHAT_FILE_ANNOTATION_LOCATE_EVENT = "rudder:chat-file-annotation-locate";

export type ChatFileAnnotationRequestDetail = {
  action: "add_to_chat" | "ask_in_side_chat";
  annotation: ChatInlineAnnotationInput;
  anchorRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
  boundaryRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> | null;
};

export type ChatFileAnnotationLocateDetail = {
  surface: "workspace_file" | "local_file";
  sourceFilePath: string;
  sourceHash: string;
  sourceRenderMode: "markdown" | "text";
  start: number;
  end: number;
};

let pendingLocation: ChatFileAnnotationLocateDetail | null = null;

export function requestChatFileAnnotation(detail: ChatFileAnnotationRequestDetail) {
  window.dispatchEvent(new CustomEvent<ChatFileAnnotationRequestDetail>(
    CHAT_FILE_ANNOTATION_REQUEST_EVENT,
    { detail },
  ));
}

export function requestChatFileAnnotationLocation(detail: ChatFileAnnotationLocateDetail) {
  pendingLocation = detail;
  window.dispatchEvent(new CustomEvent<ChatFileAnnotationLocateDetail>(
    CHAT_FILE_ANNOTATION_LOCATE_EVENT,
    { detail },
  ));
}

export function readPendingChatFileAnnotationLocation() {
  return pendingLocation;
}

export function consumePendingChatFileAnnotationLocation(
  detail: ChatFileAnnotationLocateDetail,
) {
  if (pendingLocation === detail) pendingLocation = null;
}
