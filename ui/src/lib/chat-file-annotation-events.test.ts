// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_FILE_ANNOTATION_REQUEST_EVENT,
  chatFileAnnotationRouteConversationId,
  requestChatFileAnnotation,
  type ChatFileAnnotationRequestDetail,
} from "./chat-file-annotation-events";

function request() {
  return requestChatFileAnnotation({
    action: "add_to_chat",
    annotation: {
      id: "30000000-0000-4000-8000-000000000100",
      selectedText: "beta",
      comment: null,
      sourceConversationId: "chat-1",
      surface: "local_file",
      sourceFilePath: "/tmp/example.ts",
      sourceRenderMode: "text",
      sourceHash: "a".repeat(64),
      start: 6,
      end: 10,
      prefix: "alpha ",
      suffix: " gamma",
      attachmentIds: [],
    },
    anchorRect: { left: 10, right: 60, top: 20, bottom: 40, width: 50, height: 20 },
    boundaryRect: null,
  });
}

const listeners: EventListener[] = [];

afterEach(() => {
  for (const listener of listeners) {
    window.removeEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, listener);
  }
  listeners.length = 0;
});

function listen(handler: (detail: ChatFileAnnotationRequestDetail) => void) {
  const listener: EventListener = (event) => {
    handler((event as CustomEvent<ChatFileAnnotationRequestDetail>).detail);
  };
  listeners.push(listener);
  window.addEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, listener);
}

describe("requestChatFileAnnotation", () => {
  it.each([
    ["/messenger/chat/chat-1", "chat-1"],
    ["/rudder/messenger/chat/chat%202", "chat 2"],
    ["/chat/chat-3", "chat-3"],
    ["/messenger/workbench", null],
    ["/messenger/chat/%E0%A4%A", null],
  ])("reads the active Chat id from %s", (pathname, expected) => {
    expect(chatFileAnnotationRouteConversationId(pathname)).toBe(expected);
  });

  it("returns unhandled when no Chat listener receives the request", () => {
    expect(request()).toEqual({ status: "unhandled" });
  });

  it("returns an accepted or rejected synchronous acknowledgement", () => {
    listen((detail) => detail.respond?.({ status: "accepted" }));
    expect(request()).toEqual({ status: "accepted" });

    window.removeEventListener(CHAT_FILE_ANNOTATION_REQUEST_EVENT, listeners.pop()!);
    listen((detail) => detail.respond?.({
      status: "rejected",
      reason: "conversation_not_ready",
    }));
    expect(request()).toEqual({ status: "rejected", reason: "conversation_not_ready" });
  });

  it("keeps the first acknowledgement when multiple listeners respond", () => {
    listen((detail) => detail.respond?.({ status: "accepted" }));
    listen((detail) => detail.respond?.({
      status: "rejected",
      reason: "conversation_mismatch",
    }));

    expect(request()).toEqual({ status: "accepted" });
  });
});
