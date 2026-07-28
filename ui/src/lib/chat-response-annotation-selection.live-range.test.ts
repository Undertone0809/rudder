// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  findChatAnnotationSourceRoot,
  restoreLiveChatAnnotationRange,
  type ChatAnnotationSelectionAnchor,
} from "./chat-response-annotation-selection";

function assistantSource(messageId: string, text = "stable quote") {
  const root = document.createElement("div");
  root.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, `assistant:${messageId}`);
  root.dataset.annotationSurface = "assistant_body";
  root.dataset.messageId = messageId;
  const paragraph = document.createElement("p");
  paragraph.dataset.markdownSourceStart = "0";
  paragraph.dataset.markdownSourceEnd = String(text.length);
  paragraph.textContent = text;
  root.appendChild(paragraph);
  return root;
}

function assistantAnchor(messageId: string): ChatAnnotationSelectionAnchor {
  return {
    surface: "assistant_body",
    selectedText: "quote",
    sourceConversationId: "chat-1",
    sourceMessageId: messageId,
    sourceHash: "hash",
    start: 7,
    end: 12,
    prefix: "stable ",
    suffix: "",
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("live Chat annotation range recovery", () => {
  it("restores canonical offsets against a replacement source root", () => {
    const workspace = document.createElement("main");
    document.body.appendChild(workspace);
    const original = assistantSource("message-1");
    workspace.appendChild(original);
    const replacement = assistantSource("message-1");
    original.replaceWith(replacement);

    const restored = restoreLiveChatAnnotationRange({
      anchor: assistantAnchor("message-1"),
      source: "stable quote",
      searchRoot: workspace,
    });

    expect(restored?.sourceRoot).toBe(replacement);
    expect(restored?.range.toString()).toBe("quote");
  });

  it("does not bind to a matching source outside the active workspace", () => {
    const activeWorkspace = document.createElement("main");
    const sidePanel = document.createElement("aside");
    sidePanel.appendChild(assistantSource("message-1"));
    document.body.append(activeWorkspace, sidePanel);

    expect(findChatAnnotationSourceRoot(
      assistantAnchor("message-1"),
      activeWorkspace,
    )).toBeNull();
    expect(restoreLiveChatAnnotationRange({
      anchor: assistantAnchor("message-1"),
      source: "stable quote",
      searchRoot: activeWorkspace,
    })).toBeNull();
  });

  it("matches Process roots by generation provenance", () => {
    const workspace = document.createElement("main");
    document.body.appendChild(workspace);
    for (const generationId of ["old-generation", "current-generation"]) {
      const root = assistantSource("message-1", "stable quote");
      root.setAttribute(
        CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
        `process:message-1:${generationId}:1:1:thinking`,
      );
      root.dataset.annotationSurface = "process_transcript";
      root.dataset.transcriptKind = "thinking";
      root.dataset.generationId = generationId;
      root.dataset.generationSeqStart = "1";
      root.dataset.generationSeqEnd = "1";
      workspace.appendChild(root);
    }
    const anchor: ChatAnnotationSelectionAnchor = {
      ...assistantAnchor("message-1"),
      surface: "process_transcript",
      transcriptKind: "thinking",
      generationId: "current-generation",
      generationSeqStart: 1,
      generationSeqEnd: 1,
    };

    expect(findChatAnnotationSourceRoot(anchor, workspace)?.dataset.generationId)
      .toBe("current-generation");
  });
});
