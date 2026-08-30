import { ApiError, ApiTimeoutError, isAbortError } from "@/api/client";

export type ChatErrorAction = "send" | "steer" | "side-chat" | "feedback";

export type ChatErrorToast = {
  title: string;
  body: string;
};

function actionTitle(action: ChatErrorAction) {
  switch (action) {
    case "steer":
      return "Could not send steer";
    case "side-chat":
      return "Could not send Side Chat message";
    case "feedback":
      return "Could not send feedback";
    default:
      return "Could not send message";
  }
}

function apiErrorCode(error: ApiError) {
  if (!error.body || typeof error.body !== "object") return null;
  const details = "details" in error.body
    ? (error.body as { details?: unknown }).details
    : null;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  const code = "code" in details ? (details as { code?: unknown }).code : null;
  return typeof code === "string" ? code : null;
}

export function chatErrorToast(error: unknown, action: ChatErrorAction = "send"): ChatErrorToast {
  if (error instanceof ApiTimeoutError) {
    return {
      title: actionTitle(action),
      body: "The request took too long. Check your connection and try again.",
    };
  }

  if (error instanceof ApiError) {
    if (error.status === 409 && apiErrorCode(error) === "chat_send_in_progress") {
      return {
        title: actionTitle(action),
        body: "This message is already being sent. Try again shortly.",
      };
    }
    if (
      error.status === 422
      && (
        apiErrorCode(error) === "chat_annotation_selection_mismatch"
        || error.message === "Annotation selected text does not exactly match its rendered Markdown source range"
      )
    ) {
      return {
        title: actionTitle(action),
        body: "The selected response text changed. Re-select the highlighted text and try again.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        title: actionTitle(action),
        body: "You no longer have access to this chat. Refresh and try again.",
      };
    }
    if (error.status === 404) {
      return {
        title: actionTitle(action),
        body: "This chat is no longer available. Refresh and try again.",
      };
    }
    if (error.status === 409) {
      return {
        title: actionTitle(action),
        body: "This chat changed while the request was in progress. Refresh and try again.",
      };
    }
    if (error.status === 429) {
      return {
        title: actionTitle(action),
        body: "Rudder is busy right now. Wait a moment and try again.",
      };
    }
    if (error.status >= 400 && error.status < 500) {
      return {
        title: actionTitle(action),
        body: "Check the message and try again.",
      };
    }
    if (error.status >= 500) {
      return {
        title: actionTitle(action),
        body: "Rudder could not process the request. Try again.",
      };
    }
  }

  if (isAbortError(error)) {
    return {
      title: actionTitle(action),
      body: "The request was interrupted. Try again when you are ready.",
    };
  }

  if (error instanceof TypeError || (error instanceof Error && /network|fetch|connection|load failed/iu.test(error.message))) {
    return {
      title: actionTitle(action),
      body: "Rudder could not be reached. Check your connection and try again.",
    };
  }

  return {
    title: actionTitle(action),
    body: "Something went wrong. Try again.",
  };
}

export function chatErrorMessage(error: unknown, action: ChatErrorAction = "send") {
  return chatErrorToast(error, action).body;
}
