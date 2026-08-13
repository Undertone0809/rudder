import type { ChatInlineAnnotationInput } from "@rudderhq/shared";

export const CHAT_FILE_ANNOTATION_REQUEST_EVENT = "rudder:chat-file-annotation-request";
export const CHAT_FILE_ANNOTATION_LOCATE_EVENT = "rudder:chat-file-annotation-locate";

export type ChatFileAnnotationRequestRejectionReason =
  | "conversation_mismatch"
  | "conversation_not_ready"
  | "side_chat_unavailable"
  | "validation_failed";

export type ChatFileAnnotationRequestResult =
  | { status: "accepted" }
  | { status: "rejected"; reason: ChatFileAnnotationRequestRejectionReason }
  | { status: "unhandled" };

export type ChatFileAnnotationRequestInput = {
  action: "add_to_chat" | "ask_in_side_chat";
  annotation: ChatInlineAnnotationInput;
  anchorRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height">;
  boundaryRect: Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> | null;
  getBoundaryRect?: () => Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> | null;
};

export type ChatFileAnnotationRequestDetail = ChatFileAnnotationRequestInput & {
  respond?: (result: Exclude<ChatFileAnnotationRequestResult, { status: "unhandled" }>) => void;
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

export function chatFileAnnotationRouteConversationId(pathname: string) {
  const match = pathname.match(/\/(?:messenger\/)?chat\/([^/?#]+)(?:\/|$)/u);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function requestChatFileAnnotation(
  input: ChatFileAnnotationRequestInput,
): ChatFileAnnotationRequestResult {
  let result: ChatFileAnnotationRequestResult = { status: "unhandled" };
  const detail: ChatFileAnnotationRequestDetail = {
    ...input,
    respond: (response) => {
      if (result.status === "unhandled") result = response;
    },
  };
  window.dispatchEvent(new CustomEvent<ChatFileAnnotationRequestDetail>(
    CHAT_FILE_ANNOTATION_REQUEST_EVENT,
    { detail },
  ));
  return result;
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
