// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  CHAT_ANNOTATION_BLOCK_ATTRIBUTE,
  CHAT_ANNOTATION_SOURCE_ATTRIBUTE,
  resolveChatAnnotationRange,
} from "./chat-response-annotation-selection";

const sourceHash = "b".repeat(64);

function sourceRoot(sourceId: string, blockId: string) {
  const root = document.createElement("div");
  root.setAttribute(CHAT_ANNOTATION_SOURCE_ATTRIBUTE, sourceId);
  root.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, blockId);
  return root;
}

describe("chat response annotation selection", () => {
  it("maps a precise CJK selection across Markdown links and inline code to source offsets", () => {
    const source = "这是 **Rudder**，查看 [文档](https://rudder.dev) 与 `inline code`。";
    const root = sourceRoot("assistant:message-1", "message-1");
    root.innerHTML = "这是 <strong>Rudder</strong>，查看 <a>文档</a> 与 <code>inline code</code>。";
    document.body.appendChild(root);

    const linkText = root.querySelector("a")!.firstChild!;
    const codeText = root.querySelector("code")!.firstChild!;
    const range = document.createRange();
    range.setStart(linkText, 0);
    range.setEnd(codeText, "inline code".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
      contextLength: 6,
    })).toEqual({
      selectedText: "文档 与 inline code",
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
      sourceHash,
      start: source.indexOf("文档"),
      end: source.indexOf("inline code") + "inline code".length,
      prefix: source.slice(Math.max(0, source.indexOf("文档") - 6), source.indexOf("文档")),
      suffix: source.slice(
        source.indexOf("inline code") + "inline code".length,
        source.indexOf("inline code") + "inline code".length + 6,
      ),
    });

    root.remove();
  });

  it("carries process generation provenance for a valid same-block selection", () => {
    const source = "Thinking about the edge case.";
    const root = sourceRoot("process:message-1:generation-1:4:6", "transcript-block-4-6");
    root.textContent = source;
    document.body.appendChild(root);
    const text = root.firstChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 8);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "process_transcript",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    })).toMatchObject({
      selectedText: "Thinking",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    });

    root.remove();
  });

  it("allows a final-answer selection across paragraphs and list items in one message", () => {
    const source = "First paragraph.\n\n- 第一项\n- 第二项";
    const root = sourceRoot("assistant:message-3", "message-3");
    const paragraph = document.createElement("p");
    paragraph.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-paragraph");
    paragraph.textContent = "First paragraph.";
    const list = document.createElement("ul");
    const firstItem = document.createElement("li");
    firstItem.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-list-item-1");
    firstItem.textContent = "第一项";
    const secondItem = document.createElement("li");
    secondItem.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "markdown-list-item-2");
    secondItem.textContent = "第二项";
    list.append(firstItem, secondItem);
    root.append(paragraph, list);
    document.body.appendChild(root);

    const range = document.createRange();
    range.setStart(paragraph.firstChild!, "First ".length);
    range.setEnd(secondItem.firstChild!, "第二项".length);

    expect(resolveChatAnnotationRange({
      range,
      sourceRoot: root,
      source,
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toMatchObject({
      selectedText: "paragraph.第一项第二项",
      start: source.indexOf("paragraph."),
      end: source.length,
    });

    root.remove();
  });

  it("rejects collapsed and cross-source ranges", () => {
    const first = sourceRoot("assistant:message-1", "block-1");
    const second = sourceRoot("assistant:message-2", "block-2");
    first.textContent = "First";
    second.textContent = "Second";
    document.body.append(first, second);

    const collapsed = document.createRange();
    collapsed.setStart(first.firstChild!, 1);
    collapsed.collapse(true);
    expect(resolveChatAnnotationRange({
      range: collapsed,
      sourceRoot: first,
      source: "First",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();

    const crossSource = document.createRange();
    crossSource.setStart(first.firstChild!, 0);
    crossSource.setEnd(second.firstChild!, 3);
    expect(resolveChatAnnotationRange({
      range: crossSource,
      sourceRoot: first,
      source: "First",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "assistant_body",
    })).toBeNull();

    first.remove();
    second.remove();
  });

  it("rejects a process selection across transcript provenance blocks", () => {
    const nestedBlocks = sourceRoot("process:message-3", "message-3");
    const blockOne = document.createElement("span");
    blockOne.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "nested-1");
    blockOne.textContent = "One";
    const blockTwo = document.createElement("span");
    blockTwo.setAttribute(CHAT_ANNOTATION_BLOCK_ATTRIBUTE, "nested-2");
    blockTwo.textContent = "Two";
    nestedBlocks.append(blockOne, blockTwo);
    document.body.appendChild(nestedBlocks);
    const crossBlock = document.createRange();
    crossBlock.setStart(blockOne.firstChild!, 0);
    crossBlock.setEnd(blockTwo.firstChild!, 3);
    expect(resolveChatAnnotationRange({
      range: crossBlock,
      sourceRoot: nestedBlocks,
      source: "OneTwo",
      sourceHash,
      sourceConversationId: "10000000-0000-4000-8000-000000000001",
      sourceMessageId: "20000000-0000-4000-8000-000000000001",
      surface: "process_transcript",
      transcriptKind: "thinking",
      generationId: "30000000-0000-4000-8000-000000000001",
      generationSeqStart: 4,
      generationSeqEnd: 6,
    })).toBeNull();

    nestedBlocks.remove();
  });
});
