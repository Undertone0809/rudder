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

export function chatErrorToast(error: unknown, action: ChatErrorAction = "send"): ChatErrorToast {
  if (error instanceof ApiTimeoutError) {
    return {
      title: actionTitle(action),
      body: "The request took too long. Check your connection and try again.",
    };
  }

  if (error instanceof ApiError) {
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
